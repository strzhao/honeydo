/** lmedia image — 图像模态子树：gen / edit / batch / upscale / serve + style·char 资产库 + setup
 *
 * 引擎关系（默认 H3）：`--engine h3`=默认本地（MiniMax-H3 两段式：encode 文本塔 → generate DiT，
 * 双参考 edit = Picture 1 角色锚 / Picture 2 风格锚 定版配方）；`--engine local|qwen`=旧 Qwen 栈
 * （deprecated：权重需重下 ~108GB）；云端 doubao 走 honeydo 主壳分发。
 * 输出契约（h3 路径冻结）：默认 stdout 恰好一行 = PNG 绝对路径；--json = 单行
 * {engine, quality, resolution, style, char, seed, output, elapsed_s}；进度一律 stderr；
 * 退出码 0 成功 / 1 运行错误（无半成品残留：先写临时文件再 rename）/ 2 参数错误。
 * batch stdout：默认一行 = report.json 绝对路径；--json = {report, dir, ok_count, failed_count, elapsed_s}。
 */
import { spawnSync } from 'node:child_process';
import type { Command } from 'commander';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pythonDriverDir, resolveRuntime, type Runtime } from '../lib/runtime.js';
import { findLora } from '../lib/registry.js';
import { runPython, type PyResult } from '../lib/run-python.js';
import {
  DEFAULT_IDLE_TIMEOUT_SEC,
  otherMode,
  pingDaemon,
  requestJob,
  spawnDaemon,
  waitGpuIdle,
  type JobKind,
  type ServeMode,
} from '../lib/serve.js';
import { hasCommand } from '../lib/which.js';
import {
  addChar as h3AddChar,
  addStyle as h3AddStyle,
  builtinAssetsRoot,
  charsLibRoot,
  InvalidArgsError,
  isBuiltinChar,
  isBuiltinStyle,
  listAssets,
  ManifestCorruptError,
  removeEntry,
  resolveChar,
  resolveStyle,
  stylesLibRoot,
  validateKey,
  verifyAssets,
  type H3AssetKind,
} from '../lib/h3-assets.js';
import { composePrompt, parseQuality, QUALITIES, type H3Quality } from '../lib/h3-prompt.js';
import { parseH3BatchManifest, readManifestText, type BatchManifestItem } from '../lib/h3-batch.js';
import {
  h3SetupTarget,
  h3StackChecks,
  reclaimStaleH3Lock,
  resolveH3Runtime,
  withH3Lock,
  type H3Runtime,
} from '../lib/h3-runtime.js';
import { assertImageEnabled, ImageDisabledError } from '../lib/image-state.js';
import { registerServe } from './serve.js';
import { registerImageCapability } from './image-capability.js';

/** 被 gate 拦截的叶子命令全路径（显式白名单，避免 'image gen' 与 'image serve start' 混淆） */
const IMAGE_GATED = new Set<string>([
  'image gen',
  'image edit',
  'image batch',
  'image upscale',
  'image serve start',
]);

/** 叶子命令全路径：'image gen' / 'image serve start'（顶层 program 无 parent，不计入） */
function commandPath(cmd: Command): string {
  const parts: string[] = [];
  for (let c: Command | null = cmd; c && c.parent; c = c.parent) parts.unshift(c.name());
  return parts.join(' ');
}

/** 能力开关的统一失败出口：仓库惯例是显式 process.exit，不用 uncaught 堆栈 */
function gateImage(what: string): void {
  try {
    assertImageEnabled(what);
  } catch (e) {
    if (!(e instanceof ImageDisabledError)) throw e;
    console.error(`✗ ${e.message}`);
    process.exit(1);
  }
}

/** Qwen-Image-2512 官方推荐负向模板（--neg 可覆盖；--cfg<=1 关闭引导时不下发） */
const DEFAULT_NEG =
  '低分辨率，低画质，肢体畸形，手指畸形，画面过饱和，蜡像感，人脸无细节，过度光滑，画面具有AI感。构图混乱。文字模糊，扭曲。';

/** --cache [thresh] → teaCache payload（缺省阈值 0.3=mlx-teacache Apple Silicon 标定档；未传 = undefined 关闭） */
function parseCache(v: string | boolean | undefined): { thresh: number } | undefined {
  if (v === undefined) return undefined;
  return { thresh: v === true ? 0.3 : parseFloat(String(v)) };
}

/** mock seam（LMEDIA_IMAGE_MOCK=1）：全链路跳过模型加载，结构/输出契约与真实模式一致 */
function isMock(): boolean {
  return process.env.LMEDIA_IMAGE_MOCK === '1';
}

/** h3 错误分级：参数/未知 key → 2；栈未就绪/推理/IO → 1 */
class H3ArgsError extends Error {}
class H3RuntimeError extends Error {}

function failH3(e: unknown): never {
  if (e instanceof H3ArgsError || e instanceof InvalidArgsError || e instanceof RangeError) {
    console.error(`✗ ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
  console.error(`✗ ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}

/**
 * daemon 热路径 + 冷路径统一入口（legacy Qwen 栈专用；对 CLI 调用方完全透明）：
 * 1. 依次试 daemonModes 上的常驻 daemon（upscale 两种模式哪个活用哪个）
 * 2. 全不在：gen/edit 自动拉起（首次含 ~2min 加载；另一模式 daemon 在跑则不拉——双驻 ~110GB 超内存）
 * 3. 兜底：waitGpuIdle（防与常驻模型抢 MPS）→ 冷路径 runPython
 * --no-daemon / LMEDIA_NO_DAEMON=1 直通冷路径（排障逃生口）
 */
async function runImageJob(
  rt: Runtime,
  args: { kind: JobKind; daemonModes: ServeMode[]; script: string; payload: Record<string, unknown>; noDaemon?: boolean }
): Promise<PyResult> {
  // 兜底 gate：hook 已拦叶子命令，这里保证未来新增调用点也不会绕过能力开关
  gateImage(`image ${args.kind}`);
  if (!args.noDaemon && process.env.LMEDIA_NO_DAEMON !== '1') {
    for (const mode of args.daemonModes) {
      const r = await requestJob(mode, { kind: args.kind, ...args.payload });
      if (r !== null) return r;
    }
    if (args.kind === 'gen' || args.kind === 'edit') {
      const mode = args.daemonModes[0];
      if (!(await pingDaemon(otherMode(mode)))) {
        process.stderr.write(
          `⟳ 拉起 ${mode} daemon（首次任务含 ~2min 模型加载；空闲 ${DEFAULT_IDLE_TIMEOUT_SEC / 60}min 自退，--no-daemon 可绕过）…\n`
        );
        await spawnDaemon(mode);
        const r = await requestJob(mode, { kind: args.kind, ...args.payload });
        if (r !== null) return r;
      }
    }
    await waitGpuIdle();
  }
  return runPython(rt.pythonGen, args.script, args.payload);
}

// ———————————————————————————— H3 两段式管线（gen/edit/batch 共用） ————————————————————————————

interface H3JobRequest {
  scene: string;
  out: string; // 绝对路径
  styleKey?: string;
  charKey?: string;
  seed: number;
  quality: H3Quality;
  /** 生成档尺寸覆盖（batch 清单 size；缺省按 quality 推导：draft 2048x1152 / publish 5472x3072） */
  size?: string;
  /** true = edit 语义（参考图 = Picture 1 角色锚 / Picture 2 风格锚）；false = 纯 t2i */
  withRefs: boolean;
}

interface H3JobResult {
  scene: string;
  out: string;
  ok: boolean;
  reason?: string;
  resolution?: string;
  elapsed_s?: number;
  styleKey: string;
  charKey: string;
}

interface H3RunOutput {
  /** 与入参 reqs 同序（含失败条目占位） */
  results: H3JobResult[];
  elapsed_s: number;
}

/** quality → 生成档尺寸字符串（与 python/h3_generate.py QUALITY_SIZES 对齐） */
function genSizeFor(r: H3JobRequest): string {
  if (r.size) return r.size;
  return r.quality === 'publish' ? '5472x3072' : '2048x1152';
}

/**
 * H3 栈 preflight（gen/edit/batch 共用；两种模式都跑——mock 只跳过模型加载，不跳过栈完整性）。
 * 任一项缺失 → H3RuntimeError（fix 行含 lmedia image setup / doctor 指引）。
 */
function assertH3StackReady(): H3Runtime {
  const rt = resolveH3Runtime();
  const missing = h3StackChecks(rt, builtinAssetsRoot()).filter((c) => !c.ok);
  if (missing.length) {
    throw new H3RuntimeError(
      `H3 栈未就绪（${missing.length} 项缺失）：\n` +
        missing.map((m) => `  ✗ ${m.name} → ${m.fix}`).join('\n'),
    );
  }
  return rt as H3Runtime;
}

/** 资产解析 + prompt 组装（用户库 > 出厂预设；未知 key → exit 2） */
function buildH3Jobs(reqs: H3JobRequest[]): {
  live: { index: number; prompt: string; images: string[]; size: string }[];
  results: H3JobResult[];
} {
  const live: { index: number; prompt: string; images: string[]; size: string }[] = [];
  const results: H3JobResult[] = [];
  for (const [index, r] of reqs.entries()) {
    const style = r.styleKey ? resolveStyle(r.styleKey) : null;
    if (r.styleKey && !style) {
      throw new H3ArgsError(`未知风格 key: ${r.styleKey}（lmedia image style list 查看可用）`);
    }
    const char = r.charKey ? resolveChar(r.charKey) : null;
    if (r.charKey && !char) {
      throw new H3ArgsError(`未知角色 key: ${r.charKey}（lmedia image char list 查看可用）`);
    }
    const composed = composePrompt({ scene: r.scene, style, char });
    results.push({
      scene: r.scene,
      out: r.out,
      ok: false,
      styleKey: style?.key ?? '',
      charKey: char?.key ?? '',
    });
    // edit 语义（withRefs）才带参考图：Picture 1 角色锚 / Picture 2 风格锚；t2i 纯文本（双轴零和，草稿专用）
    live.push({ index, prompt: composed.prompt, images: r.withRefs ? composed.images : [], size: genSizeFor(r) });
  }
  return { live, results };
}

/**
 * 两段式执行（GPU 串行锁内）：encode（文本塔一次加载，全部条目）→ generate（DiT 一次加载，全部条目）。
 * python 侧逐条隔离失败；mock 模式秒级完成且结构一致。返回结果与 reqs 同序。
 */
async function runH3Jobs(reqs: H3JobRequest[]): Promise<H3RunOutput> {
  if (!reqs.length) return { results: [], elapsed_s: 0 };
  const mock = isMock();
  const rt = assertH3StackReady();
  const { live, results } = buildH3Jobs(reqs);
  const py = mock ? 'python3' : rt.venvPython;
  const pyDir = pythonDriverDir();
  const t0 = Date.now();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'lmedia-h3-'));
  try {
    await withH3Lock(async () => {
      // 阶段一：文本塔编码（embedding 落盘后进程退出释放内存）
      console.error(`[h3] stage 1/2 encode（${live.length} 条${mock ? '，mock' : ''}）…`);
      const enc = await runPython(
        py,
        path.join(pyDir, 'h3_encode.py'),
        { runtime: rt.root, work, mock, prompt_refs: live.map((l) => ({ prompt: l.prompt, images: l.images })) },
        { acceptFailure: true },
      );
      const encItems = (enc.items ?? []) as { index: number; failed?: boolean; error?: string }[];
      const encodeFailed = new Set<number>();
      for (const it of encItems) {
        if (it.failed) {
          encodeFailed.add(it.index);
          results[it.index].ok = false;
          results[it.index].reason = `encode 失败: ${it.error ?? '未知'}`;
        }
      }
      const liveLeft = live.filter((l) => !encodeFailed.has(l.index));
      if (!liveLeft.length) return;

      // 阶段二：DiT 采样 + VAE 解码（+ publish 档 LANCZOS 缩回）
      console.error(`[h3] stage 2/2 generate（${liveLeft.length} 条${mock ? '，mock' : ''}）…`);
      const gen = await runPython(
        py,
        path.join(pyDir, 'h3_generate.py'),
        {
          runtime: rt.root,
          work,
          mock,
          items: liveLeft.map((l) => ({
            index: l.index,
            seed: reqs[l.index].seed,
            size: l.size,
            quality: reqs[l.index].quality,
            out: reqs[l.index].out,
          })),
        },
        { acceptFailure: true },
      );
      const genItems = (gen.items ?? []) as {
        index: number; out?: string; resolution?: string; elapsed_s?: number; failed?: boolean; error?: string;
      }[];
      const seen = new Set<number>();
      for (const it of genItems) {
        seen.add(it.index);
        const r = results[it.index];
        if (it.failed) {
          r.ok = false;
          r.reason = `generate 失败: ${it.error ?? '未知'}`;
        } else {
          r.ok = true;
          r.resolution = it.resolution;
          r.elapsed_s = it.elapsed_s;
        }
      }
      // generate 没报到的条目（异常截断）→ 保持失败态并给原因
      for (const l of liveLeft) {
        if (!seen.has(l.index)) {
          results[l.index].ok = false;
          results[l.index].reason = 'generate 未报告该条目（异常截断）';
        }
      }
    });
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
  return { results, elapsed_s: Math.round((Date.now() - t0) / 100) / 10 };
}

/** h3 输出契约：默认 stdout 恰好一行 = PNG 绝对路径；--json = 单行冻结字段 */
function emitH3Result(meta: {
  engine: string; quality: string; resolution?: string; style: string; char: string;
  seed: number; output: string; elapsed_s: number;
}, json: boolean): void {
  if (json) {
    console.log(JSON.stringify({
      engine: meta.engine,
      quality: meta.quality,
      resolution: meta.resolution ?? '',
      style: meta.style,
      char: meta.char,
      seed: meta.seed,
      output: meta.output,
      elapsed_s: meta.elapsed_s,
    }));
  } else {
    console.log(meta.output);
  }
}

function parseSeed(v: string | undefined): number {
  const n = Number(v ?? '42');
  if (!Number.isInteger(n) || n < 0) throw new H3ArgsError(`--seed 需为非负整数: ${v}`);
  return n;
}

function parseQualityOrExit(v: string | undefined): H3Quality {
  try {
    return parseQuality(v);
  } catch {
    throw new H3ArgsError(`--quality 仅支持 ${QUALITIES.join('|')}: ${v}`);
  }
}

/** 单条 h3 作业（gen/edit）：结果或失败统一出口 */
async function runH3Single(
  req: H3JobRequest,
  opts: { engine: string; json?: boolean },
): Promise<void> {
  const t0 = Date.now();
  const { results } = await runH3Jobs([req]);
  const r = results[0];
  const elapsed = r.elapsed_s ?? Math.round((Date.now() - t0) / 100) / 10;
  if (!r.ok) throw new H3RuntimeError(`${r.reason ?? '推理失败'}\n  输出路径无半成品残留: ${r.out}`);
  emitH3Result({
    engine: opts.engine,
    quality: req.quality,
    resolution: r.resolution,
    style: r.styleKey,
    char: r.charKey,
    seed: req.seed,
    output: r.out,
    elapsed_s: elapsed,
  }, opts.json ?? false);
}

// ———————————————————————————— gen ————————————————————————————

interface GenOpts {
  engine?: string;
  out?: string;
  quality?: string;
  style?: string;
  char?: string;
  styleWeight?: string;
  charWeight?: string;
  width?: string;
  height?: string;
  steps?: string;
  seed?: string;
  upscale?: boolean;
  lora?: string[];
  cfg?: string;
  neg?: string;
  fast?: string | boolean;
  num?: string;
  cache?: string | boolean;
  daemon?: boolean;
  json?: boolean;
}

/** 旧 Qwen 栈（--engine local|qwen 真实模式）的 gen 实现（legacy 行为原样保留） */
async function genLegacyQwen(promptIn: string, opts: GenOpts): Promise<void> {
  const rt = resolveRuntime();
  let prompt = promptIn;
  const loras: { path: string; scale: number }[] = [];
  const names = [opts.style, opts.char, ...(opts.lora ?? [])].filter(Boolean) as string[];
  const weightOverride: Record<string, number | undefined> = {
    [opts.style ?? '']: opts.styleWeight ? parseFloat(opts.styleWeight) : undefined,
    [opts.char ?? '']: opts.charWeight ? parseFloat(opts.charWeight) : undefined,
  };
  for (const name of names) {
    const entry = findLora(name);
    if (!entry) {
      console.error(`未注册的 LoRA: ${name}（lmedia lora list 查看）`);
      process.exit(2);
    }
    loras.push({ path: entry.path, scale: weightOverride[name] ?? entry.defaultWeight });
    if (entry.trigger && !prompt.includes(entry.trigger)) {
      prompt = `${entry.trigger}，${prompt}`;
    }
  }

  // --fast：注入 Lightning 蒸馏 LoRA（固定权重 1.0），默认 8 步 / cfg 1.0
  const fast = opts.fast !== undefined;
  const num = parseInt(opts.num ?? '1', 10);
  if (!Number.isFinite(num) || num < 1 || num > 4) {
    console.error('--num 取值 1-4');
    process.exit(2);
  }
  const steps =
    opts.steps !== undefined
      ? parseInt(opts.steps, 10)
      : fast
        ? opts.fast === true
          ? 8
          : parseInt(opts.fast as string, 10)
        : 20;
  const trueCfg = opts.cfg !== undefined ? parseFloat(opts.cfg) : fast ? 1.0 : 4.0;
  if (fast && !names.includes('lightning2512')) {
    const lt = findLora('lightning2512');
    if (!lt || !fs.existsSync(lt.path)) {
      console.error('--fast 需要 lightning2512 LoRA（下载后: lmedia lora add lightning2512 <path> --kind speed）');
      process.exit(2);
    }
    loras.unshift({ path: lt.path, scale: 1.0 });
  }

  // 负向：显式 --neg 优先（空串=无负向）；默认官方模板；引导关闭时不下发
  let neg: string | undefined;
  if (trueCfg > 1) {
    if (opts.neg !== undefined && opts.neg !== '') neg = opts.neg;
    else if (opts.neg === undefined) neg = DEFAULT_NEG;
  }

  const result = await runImageJob(rt, {
    kind: 'gen',
    daemonModes: ['gen'],
    script: path.join(rt.pythonDir, 'gen.py'),
    noDaemon: opts.daemon === false,
    payload: {
      prompt,
      out: path.resolve(opts.out ?? `lmedia-${Date.now()}.png`),
      snapshot: rt.snapshot,
      width: parseInt(opts.width ?? '1664', 10),
      height: parseInt(opts.height ?? '928', 10),
      steps,
      trueCfg,
      neg,
      num,
      seed: parseInt(opts.seed ?? '42', 10),
      loras,
      lightningSched: fast || undefined,
      teaCache: parseCache(opts.cache),
      upscaleTo: opts.upscale ? [2730, 1535] : undefined,
    },
  });
  console.log(JSON.stringify(result, null, 2));
}

function registerGen(image: Command): void {
  image
    .command('gen [prompt]')
    .description(
      '文生图。默认 h3 引擎（MiniMax-H3 本地两段式，h3=默认本地）；--engine local|qwen=旧 Qwen 栈（deprecated，权重需重下 ~108GB）；云端 doubao 走 honeydo image gen --engine doubao',
    )
    .option('--engine <e>', 'h3=默认本地（缺省）| local|qwen=旧 Qwen 栈（deprecated）', 'h3')
    .option('-o, --out <path>', '输出路径（h3）', `lmedia-h3-${Date.now()}.png`)
    .option('--quality <q>', 'h3 质量档：draft（2048x1152 直出）| publish（5472x3072 生成后缩回 2736x1536）', 'draft')
    .option('--style <key>', 'h3: 风格资产 key（picturebook）；local: 风格 LoRA 名')
    .option('--char <key>', 'h3: 角色资产 key（pipi）；local: 角色 LoRA 名')
    .option('--json', 'h3: stdout 输出单行 JSON 元数据（冻结字段）')
    .option('--seed <n>', '随机种子', '42')
    .option('--style-weight <n>', 'local: 风格 LoRA 权重（覆盖注册表默认）')
    .option('--char-weight <n>', 'local: 角色 LoRA 权重（覆盖注册表默认）')
    .option('--lora <name...>', 'local: 任意注册 LoRA 名（可多个）')
    .option('--width <px>', 'local: 宽', '1664')
    .option('--height <px>', 'local: 高', '928')
    .option('--steps <n>', 'local: 步数（默认 20；--fast 默认 8；显式传入优先）')
    .option('--cfg <n>', 'local: true CFG 强度（默认 4.0=官方配方；<=1 关闭引导；--fast 默认 1.0）')
    .option('--neg <text>', 'local: 负向提示词（默认官方中文模板；传空串=无负向）')
    .option('--fast [steps]', 'local: Lightning 蒸馏加速（默认 8 步，cfg=1）')
    .option('--cache [thresh]', 'local: TeaCache 步缓存')
    .option('--num <n>', 'local: 一次生成张数（1-4）', '1')
    .option('--upscale', 'local: 生成后超分到 2730×1535')
    .option('--no-daemon', 'local: 绕过常驻 daemon，强制冷路径（排障用）')
    .action(async (prompt: string | undefined, opts: GenOpts) => {
      try {
        const engine = (opts.engine ?? 'h3').toLowerCase();
        if (!['h3', 'local', 'qwen'].includes(engine)) {
          throw new H3ArgsError(
            `未知引擎: ${opts.engine}（--engine 枚举 h3|local|qwen；云端 doubao 走 honeydo image gen --engine doubao）`,
          );
        }
        if (!prompt || !prompt.trim()) {
          throw new H3ArgsError('缺少场景文本：image gen "<场景描述>"');
        }
        const qwenDeprecated = () => {
          console.error('⚠️ qwen 本地引擎已 deprecated：权重需重下 ~108GB；推荐 h3 引擎（--engine h3 或省略 --engine）');
        };
        if (engine === 'h3' || (engine === 'qwen' && isMock())) {
          if (engine === 'qwen') qwenDeprecated(); // mock 影响面：qwen 走 h3 mock 出图管道
          await runH3Single(
            {
              scene: prompt,
              out: path.resolve(opts.out ?? `lmedia-h3-${Date.now()}.png`),
              styleKey: opts.style,
              charKey: opts.char,
              seed: parseSeed(opts.seed),
              quality: parseQualityOrExit(opts.quality),
              withRefs: false,
            },
            { engine: engine === 'qwen' && isMock() ? 'h3' : engine, json: opts.json },
          );
          return;
        }
        if (engine === 'qwen') qwenDeprecated();
        await genLegacyQwen(prompt, opts);
      } catch (e) {
        failH3(e);
      }
    });
}

// ———————————————————————————— edit（仅本地 h3：双参考定版配方） ————————————————————————————

interface EditOpts {
  out?: string;
  style?: string;
  char?: string;
  quality?: string;
  seed?: string;
  json?: boolean;
}

function registerEdit(image: Command): void {
  image
    .command('edit [prompt]')
    .description(
      '参考图编辑：H3 引擎双参考定版配方（Picture 1=角色锚 / Picture 2=风格锚，弱引用 + 分工句式），仅本地 h3；出版必须双参考',
    )
    .option('-o, --out <path>', '输出路径', `lmedia-edit-${Date.now()}.png`)
    .option('--style <key>', '风格 key（image style list 查看；省略则不注入风格轴）')
    .option('--char <key>', '角色 key（image char list 查看；省略则不注入角色轴）')
    .option('--quality <q>', '质量档：draft（2048x1152 直出）| publish（5472x3072 生成后 LANCZOS 缩回 2736x1536）', 'draft')
    .option('--seed <n>', '随机种子', '42')
    .option('--json', 'stdout 输出单行 JSON 元数据（冻结字段）')
    .action(async (prompt: string | undefined, opts: EditOpts) => {
      try {
        if (!prompt || !prompt.trim()) {
          throw new H3ArgsError('缺少场景文本：image edit "<场景描述>"（双参考 edit 配方见 USAGE「H3 图像引擎」）');
        }
        await runH3Single(
          {
            scene: prompt,
            out: path.resolve(opts.out ?? `lmedia-edit-${Date.now()}.png`),
            styleKey: opts.style,
            charKey: opts.char,
            seed: parseSeed(opts.seed),
            quality: parseQualityOrExit(opts.quality),
            withRefs: true,
          },
          { engine: 'h3', json: opts.json },
        );
      } catch (e) {
        failH3(e);
      }
    });
}

// ———————————————————————————— batch ————————————————————————————

interface BatchOpts {
  manifest: string;
  out?: string;
  quality?: string;
  json?: boolean;
}

function registerBatch(image: Command): void {
  image
    .command('batch')
    .description(
      '清单驱动批量出图（H3）：encode/generate 各一次模型加载 + GPU 串行锁；逐条审计 report.json（条目级失败不中断）',
    )
    .requiredOption('-m, --manifest <file>', '批清单 JSON 路径（- 读 stdin）：[{"scene","out","style"?,"char"?,"seed"?,"size"?}]')
    .option('-o, --out <dir>', '输出目录（缺省 = 清单所在目录；report.json 落这里，条目相对 out 以此为基准）')
    .option('--quality <q>', '质量档（draft|publish；条目 size 可逐条覆盖尺寸）', 'draft')
    .option('--json', 'stdout 输出单行 JSON {report, dir, ok_count, failed_count, elapsed_s}')
    .action(async (opts: BatchOpts) => {
      try {
        const quality = parseQualityOrExit(opts.quality);
        const items: BatchManifestItem[] = parseH3BatchManifest(readManifestText(opts.manifest));
        // 输出目录：显式 -o > 清单所在目录（stdin = cwd）
        const outDir = opts.out
          ? path.resolve(opts.out)
          : path.dirname(path.resolve(opts.manifest === '-' ? process.cwd() : opts.manifest));
        fs.mkdirSync(outDir, { recursive: true });

        const reqs: H3JobRequest[] = items.map((it) => ({
          scene: it.scene,
          out: path.isAbsolute(it.out) ? it.out : path.join(outDir, it.out),
          styleKey: it.style,
          charKey: it.char,
          seed: it.seed ?? 42,
          quality,
          size: it.size,
          withRefs: true,
        }));
        // mock 失败注入 seam：scene 以 @fail 开头 → 该条目模拟推理失败（batch 审计驱动）
        const injected = new Set<number>();
        if (isMock()) {
          for (const [i, r] of reqs.entries()) {
            if (r.scene.startsWith('@fail')) injected.add(i);
          }
        }
        const liveIdx = reqs.map((_, i) => i).filter((i) => !injected.has(i));
        const liveReqs = liveIdx.map((i) => reqs[i]);
        const t0 = Date.now();
        const run = await runH3Jobs(liveReqs);
        // live 结果按序对位回原始清单索引（@fail 条目直接标失败）
        const reportItems = reqs.map((r, i) => {
          if (injected.has(i)) {
            return {
              scene: r.scene, out: r.out, status: 'failed' as const,
              reason: '@fail 注入（mock 模拟推理失败）', style: '', char: '', elapsed_s: 0,
            };
          }
          const pos = liveIdx.indexOf(i);
          const found = run.results[pos];
          return {
            scene: r.scene,
            out: r.out,
            status: found?.ok ? ('ok' as const) : ('failed' as const),
            ...(found && !found.ok ? { reason: found.reason } : {}),
            style: found?.styleKey ?? '',
            char: found?.charKey ?? '',
            elapsed_s: found?.elapsed_s ?? 0,
          };
        });
        const okCount = reportItems.filter((i) => i.status === 'ok').length;
        const failedCount = reportItems.length - okCount;
        const elapsed = Math.round((Date.now() - t0) / 100) / 10;
        const reportPath = path.join(outDir, 'report.json');
        const report = { generatedAt: new Date().toISOString(), items: reportItems };
        const tmp = `${reportPath}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, `${JSON.stringify(report, null, 1)}\n`, 'utf-8');
        fs.renameSync(tmp, reportPath);
        console.error(`[h3] batch 完成: ${okCount}/${reportItems.length} ok（${elapsed}s）→ ${reportPath}`);
        if (opts.json) {
          console.log(JSON.stringify({ report: reportPath, dir: outDir, ok_count: okCount, failed_count: failedCount, elapsed_s: elapsed }));
        } else {
          console.log(reportPath);
        }
        if (failedCount > 0) process.exit(1);
      } catch (e) {
        failH3(e);
      }
    });
}

// ———————————————————————————— setup（幂等；权重只校验不下载） ————————————————————————————

const H3_DEPS = [
  'torch',
  'transformers',
  'accelerate',
  'safetensors',
  'pillow',
  'diffusers @ git+https://github.com/huggingface/diffusers', // 必须 git main（PyPI 无 minimax_h3_image）
];

/** 前台跑一条命令，返回退出码（不直接 exit——调用方决定语义） */
function spawnStep(cmd: string, args: string[]): number {
  return spawnSync(cmd, args, { stdio: 'inherit' }).status ?? 1;
}

function registerH3Setup(image: Command): void {
  image
    .command('setup')
    .description('幂等创建 H3 venv 并装推理依赖（uv 优先回退 python3 -m venv；diffusers 用 git main）；126GB 权重不做下载只校验并给指引')
    .action(async () => {
      try {
        const target = h3SetupTarget();
        const venvPython = path.join(target, 'venv', 'bin', 'python');
        fs.mkdirSync(target, { recursive: true });
        if (isMock()) {
          // mock 影响面：真实创建 venv（可执行）但跳过 pip 安装与 import 冒烟（秒级）
          if (!fs.existsSync(venvPython)) {
            console.error(`· [mock] 创建 venv: ${target}/venv（跳过 pip 安装与冒烟）`);
            if (spawnStep('python3', ['-m', 'venv', '--copies', path.join(target, 'venv')]) !== 0) {
              throw new H3RuntimeError('[mock] venv 创建失败（python3 -m venv）');
            }
          }
          console.log(`✓ [mock] H3 venv 就绪: ${venvPython}（真实依赖安装用非 mock 模式重跑）`);
        } else {
          if (!fs.existsSync(venvPython)) {
            console.error(`· 创建 venv: ${target}/venv`);
            if (hasCommand('uv') && spawnStep('uv', ['venv', '--python', '3.12', path.join(target, 'venv')]) !== 0) {
              console.error('· uv venv 失败，回退 python3 -m venv');
            }
            // --copies：bin/python 落真实文件（symlink 形态 statSync 会取到系统解释器的旧 mtime）
            if (!fs.existsSync(venvPython) && spawnStep('python3', ['-m', 'venv', '--copies', path.join(target, 'venv')]) !== 0) {
              throw new H3RuntimeError('venv 创建失败（uv 与 python3 -m venv 均失败）');
            }
          } else {
            console.error(`✓ venv 已存在（幂等复用）: ${target}/venv`);
          }
          console.error(`· 安装依赖: ${H3_DEPS.join(' ')}`);
          if (hasCommand('uv')) {
            if (spawnStep('uv', ['pip', 'install', '--python', venvPython, ...H3_DEPS]) !== 0) {
              throw new H3RuntimeError('依赖安装失败（uv pip install）');
            }
          } else if (spawnStep(venvPython, ['-m', 'pip', 'install', ...H3_DEPS]) !== 0) {
            throw new H3RuntimeError('依赖安装失败（pip install）');
          }
          console.error('· import 冒烟（diffusers ModularPipeline）…');
          if (spawnStep(venvPython, ['-c', 'import torch, transformers, accelerate, safetensors, PIL; import diffusers; from diffusers import ModularPipeline; print("diffusers", diffusers.__version__)']) !== 0) {
            throw new H3RuntimeError('依赖冒烟失败（h3_generate 依赖不可用）');
          }
          console.log(`✓ H3 venv 就绪: ${venvPython}`);
        }
        // 权重只校验在位并给指引（126GB 不在 setup 内自动拉）
        const missing = h3StackChecks(resolveH3Runtime(), builtinAssetsRoot()).filter((c) => !c.ok);
        if (missing.length) {
          console.error(`⚠️ 栈仍有 ${missing.length} 项缺失（setup 只建 venv，权重不在下载范围）：`);
          for (const m of missing) console.error(`  ✗ ${m.name} → ${m.fix}`);
          console.error('  就位后 lmedia doctor 复核；出厂资产缺失请重装 honeydo/lmedia');
        }
      } catch (e) {
        failH3(e);
      }
    });
}

// ———————————————————————————— style / char 资产库命令组 ————————————————————————————

function failAsset(e: unknown): never {
  if (e instanceof InvalidArgsError) {
    console.error(`✗ ${e.message}`);
    process.exit(2);
  }
  console.error(`✗ ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}

function removeAssetOrExit(root: string, kind: H3AssetKind, key: string): void {
  if (removeEntry(root, kind, key)) return;
  if (kind === 'style' ? isBuiltinStyle(key) : isBuiltinChar(key)) {
    throw new InvalidArgsError(`"${key}" 是出厂预设（builtin），不可删除（可用同 key 用户库条目覆盖）`);
  }
  console.error(`✗ 库中无此${kind === 'style' ? '风格' : '角色'}: ${key}（lmedia image ${kind} list 查看）`);
  process.exit(1);
}

function registerAssetCommands(image: Command, kind: H3AssetKind): void {
  const label = kind === 'style' ? '风格' : '角色';
  const primaryFlag = kind === 'style' ? '--anchor' : '--ref';
  const extraFlag = kind === 'style' ? '--template' : '--identity';

  const grp = image
    .command(kind)
    .description(`H3 ${label}资产库：add（拷贝入库）/ list（含 [builtin] 出厂预设）/ remove / verify（出厂 key 不可删）`);

  grp
    .command('add <key>')
    .description('入库：资产文件拷贝进库（不引用原路径），sha256 查重幂等；key 仅小写字母/数字/短横线')
    .option(`${primaryFlag} <path>`, `${label}主资产图路径（必填）`)
    .option(`${extraFlag} <path>`, kind === 'style' ? '配方模板 txt（可选）' : '身份锁定句 txt（可选）')
    .option('--note <text>', '说明')
    .action(async (key: string, opts: { anchor?: string; ref?: string; template?: string; identity?: string; note?: string }) => {
      try {
        validateKey(key, 'key'); // key 格式先于文件存在性校验（错误线索更聚焦）
        const primary = (kind === 'style' ? opts.anchor : opts.ref) ?? '';
        if (!primary) {
          throw new InvalidArgsError(kind === 'style' ? '缺少 --anchor <锚页图路径>' : '缺少 --ref <角色卡图路径>');
        }
        const abs = path.resolve(primary);
        if (!fs.existsSync(abs)) throw new InvalidArgsError(`资产文件不存在: ${abs}`);
        const extra = kind === 'style' ? opts.template : opts.identity;
        let extraAbs: string | undefined;
        if (extra) {
          extraAbs = path.resolve(extra);
          if (!fs.existsSync(extraAbs)) throw new InvalidArgsError(`辅文件不存在: ${extraAbs}`);
        }
        const root = kind === 'style' ? stylesLibRoot() : charsLibRoot();
        const { item, duplicated } =
          kind === 'style'
            ? h3AddStyle(root, { key, anchor: abs, template: extraAbs, note: opts.note })
            : h3AddChar(root, { key, ref: abs, identity: extraAbs, note: opts.note });
        if (duplicated) {
          console.log(`· 已有同内容条目: ${item.key}（sha256 相同，幂等跳过）`);
          return;
        }
        console.log(`✓ 入库 ${item.key}（${kind}）→ ${item.path}${opts.note ? `（${opts.note}）` : ''}`);
      } catch (e) {
        failAsset(e);
      }
    });

  grp
    .command('list')
    .description('出厂预设（[builtin] 标记）+ 用户库合并展示')
    .action(async () => {
      try {
        const root = kind === 'style' ? stylesLibRoot() : charsLibRoot();
        const rows = listAssets(root, kind);
        for (const r of rows) {
          console.log(`[${r.source}] ${r.key.padEnd(16)} ${r.path}${r.note ? `  # ${r.note}` : ''}`);
        }
        console.error(`共 ${rows.length} 条（builtin ${rows.filter((r) => r.source === 'builtin').length} / user ${rows.filter((r) => r.source === 'user').length}）`);
      } catch (e) {
        failAsset(e);
      }
    });

  grp
    .command('verify [key]')
    .description('对账：出厂预设文件在位 + 用户库记录 ↔ 文件 ↔ 内容一致（漂移 → ✗ exit 1）')
    .action(async (key: string | undefined) => {
      try {
        const root = kind === 'style' ? stylesLibRoot() : charsLibRoot();
        const { problems } = verifyAssets(root, kind);
        const rows = listAssets(root, kind);
        let shown = 0;
        for (const row of rows) {
          if (key && row.key !== key) continue;
          const p = problems.find((x) => x.key === row.key);
          console.log(`${p ? '✗' : '✓'} ${row.key}（${row.source === 'builtin' ? 'builtin' : 'user'}）${p ? `: ${p.issues.join('; ')}` : ''}`);
          shown++;
        }
        if (key && shown === 0) {
          console.error(`✗ 未找到${label}: ${key}（lmedia image ${kind} list 查看）`);
          process.exit(1);
        }
        const relevant = problems.filter((p) => !key || p.key === key);
        console.error(`漂移 ${relevant.length} 条`);
        if (relevant.length) process.exit(1);
      } catch (e) {
        failAsset(e);
      }
    });

  grp
    .command('remove <key>')
    .description('仅用户库可删；出厂 key → exit 2「builtin 不可删」')
    .action(async (key: string) => {
      try {
        const root = kind === 'style' ? stylesLibRoot() : charsLibRoot();
        removeAssetOrExit(root, kind, key);
        console.log(`✓ 已移除 ${key}（连同库内资产文件）`);
      } catch (e) {
        failAsset(e);
      }
    });
}

// ———————————————————————————— upscale（legacy Real-ESRGAN，不变） ————————————————————————————

function registerUpscale(image: Command): void {
  image
    .command('upscale <input> <output>')
    .description('Real-ESRGAN x2 超分（MPS，秒级）')
    .option('--size <WxH>', '最终尺寸（如 2730x1535）')
    .option('--no-daemon', '绕过常驻 daemon，强制冷路径（排障用）')
    .action(async (input: string, output: string, opts: { size?: string; daemon?: boolean }) => {
      const rt = resolveRuntime();
      const size = opts.size?.split('x').map((s) => parseInt(s, 10));
      const result = await runImageJob(rt, {
        kind: 'upscale',
        daemonModes: ['gen', 'edit'], // 哪种 daemon 活着搭哪个便车；都不在直接冷路径（spandrel 秒级）
        script: path.join(rt.pythonDir, 'upscale.py'),
        noDaemon: opts.daemon === false,
        payload: {
          in: path.resolve(input),
          out: path.resolve(output),
          finalSize: size,
        },
      });
      console.log(JSON.stringify(result, null, 2));
    });
}

export function registerImage(program: Command): void {
  const image = program.command('image').description('图像生产能力（默认 H3 引擎：gen/edit/batch + style/char 资产库 + 超分/daemon；开关见 image disable|enable|status）');
  // 能力开关 gate：commander 的 preAction 钩子挂在父命令上、对全部后代叶子生效，
  // 且必然早于 action（含 resolveRuntime / LoRA 解析 / daemon 探测）；--help 与裸 `lmedia image` 不受影响。
  image.hook('preAction', (_thisCommand, actionCommand) => {
    const p = commandPath(actionCommand);
    if (IMAGE_GATED.has(p)) gateImage(p);
  });
  registerGen(image);
  registerEdit(image);
  registerBatch(image);
  registerH3Setup(image);
  registerAssetCommands(image, 'style');
  registerAssetCommands(image, 'char');
  registerUpscale(image);
  registerServe(image);
  registerImageCapability(image);
}

/** disable 时的锁处置（h3 无 daemon 可停；死进程遗留锁直接清）——image-capability.ts 调用 */
export function h3DisableHook(): void {
  const r = reclaimStaleH3Lock();
  if (r.action === 'reclaimed') console.log(`· 已回收遗留 H3 锁（持锁进程已死，pid ${r.pid}）`);
  else if (r.action === 'held') console.log(`· H3 锁被活进程持有（pid ${r.pid}）——任务结束后自动释放，未强行回收`);
}
