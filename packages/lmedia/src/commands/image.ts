/** lmedia image — 图像模态子树：gen / edit / upscale / serve */
import type { Command } from 'commander';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveRuntime, type Runtime } from '../lib/runtime.js';
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
import { registerServe } from './serve.js';

/** Qwen-Image-2512 官方推荐负向模板（--neg 可覆盖；--cfg<=1 关闭引导时不下发） */
const DEFAULT_NEG =
  '低分辨率，低画质，肢体畸形，手指畸形，画面过饱和，蜡像感，人脸无细节，过度光滑，画面具有AI感。构图混乱。文字模糊，扭曲。';

/** --cache [thresh] → teaCache payload（缺省阈值 0.3=mlx-teacache Apple Silicon 标定档；未传 = undefined 关闭） */
function parseCache(v: string | boolean | undefined): { thresh: number } | undefined {
  if (v === undefined) return undefined;
  return { thresh: v === true ? 0.3 : parseFloat(String(v)) };
}

/**
 * daemon 热路径 + 冷路径统一入口（对 CLI 调用方完全透明）：
 * 1. 依次试 daemonModes 上的常驻 daemon（upscale 两种模式哪个活用哪个）
 * 2. 全不在：gen/edit 自动拉起（首次含 ~2min 加载；另一模式 daemon 在跑则不拉——双驻 ~110GB 超内存）
 * 3. 兜底：waitGpuIdle（防与常驻模型抢 MPS）→ 冷路径 runPython
 * --no-daemon / LMEDIA_NO_DAEMON=1 直通冷路径（排障逃生口）
 */
async function runImageJob(
  rt: Runtime,
  args: { kind: JobKind; daemonModes: ServeMode[]; script: string; payload: Record<string, unknown>; noDaemon?: boolean }
): Promise<PyResult> {
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

interface GenOpts {
  out?: string;
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
}

function registerGen(image: Command): void {
  image
    .command('gen <prompt>')
    .description('文生图：Qwen-Image-2512 bf16（本地，零 API 成本）')
    .option('-o, --out <path>', '输出路径', `lmedia-${Date.now()}.png`)
    .option('--style <name>', '风格 LoRA 名（如 lbwatercolor）')
    .option('--char <name>', '角色 LoRA 名（如 pipi）')
    .option('--style-weight <n>', '风格 LoRA 权重（覆盖注册表默认）')
    .option('--char-weight <n>', '角色 LoRA 权重（覆盖注册表默认）')
    .option('--lora <name...>', '任意注册 LoRA 名（可多个）')
    .option('--width <px>', '宽', '1664')
    .option('--height <px>', '高', '928')
    .option('--steps <n>', '步数（默认 20；--fast 默认 8；显式传入优先）')
    .option('--seed <n>', '随机种子', '42')
    .option('--cfg <n>', 'true CFG 强度（默认 4.0=官方配方；<=1 关闭引导；--fast 默认 1.0）')
    .option('--neg <text>', '负向提示词（默认官方中文模板；传空串=无负向）')
    .option('--fast [steps]', 'Lightning 蒸馏加速：注入 lightning2512 LoRA（默认 8 步，可 --fast 4），cfg=1，可与 --style/--char 叠加')
    .option('--cache [thresh]', 'TeaCache 步缓存（阈值缺省 0.3，越大越快越糙；质量近似无损）')
    .option('--num <n>', '一次生成张数（1-4），输出 out-1.png..out-N.png', '1')
    .option('--upscale', '生成后超分到 2730×1535')
    .option('--no-daemon', '绕过常驻 daemon，强制冷路径（排障用）')
    .action(async (promptIn: string, opts: GenOpts) => {
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
          out: path.resolve(opts.out!),
          snapshot: rt.snapshot,
          width: parseInt(opts.width!, 10),
          height: parseInt(opts.height!, 10),
          steps,
          trueCfg,
          neg,
          num,
          seed: parseInt(opts.seed!, 10),
          loras,
          lightningSched: fast || undefined,
          teaCache: parseCache(opts.cache),
          upscaleTo: opts.upscale ? [2730, 1535] : undefined,
        },
      });
      console.log(JSON.stringify(result, null, 2));
    });
}

interface EditOpts {
  out?: string;
  ref: string[];
  width?: string;
  height?: string;
  steps?: string;
  seed?: string;
  cfg?: string;
  neg?: string;
  fast?: string | boolean;
  cache?: string | boolean;
  daemon?: boolean;
}

function registerEdit(image: Command): void {
  image
    .command('edit <prompt>')
    .description('参考图编辑：Qwen-Image-Edit-2511（1+ 张参考图锁角色/风格）')
    .requiredOption('--ref <path...>', '参考图（可多张）')
    .option('-o, --out <path>', '输出路径', `lmedia-edit-${Date.now()}.png`)
    .option('--width <px>', '宽', '1664')
    .option('--height <px>', '高', '928')
    .option('--steps <n>', '步数（默认 20；官方 2511 配方 40，质量优先可上调；--fast 默认 8；显式传入优先）')
    .option('--seed <n>', '随机种子', '42')
    .option('--cfg <n>', 'true CFG 强度（默认 4.0=官方 Edit-2511 配方；--fast 默认 1.0）')
    .option('--neg <text>', '负向提示词（官方编辑配方默认 " "，几乎无约束；cfg<=1 时不下发）')
    .option('--fast [steps]', 'Lightning 蒸馏加速：注入 lightningedit2511 LoRA（默认 8 步，可 --fast 4），cfg=1 + 蒸馏调度器，约 1/7 耗时')
    .option('--cache [thresh]', 'TeaCache 步缓存（阈值缺省 0.3，越大越快越糙；质量近似无损，出版档候选）')
    .option('--no-daemon', '绕过常驻 daemon，强制冷路径（排障用）')
    .action(async (prompt: string, opts: EditOpts) => {
      const rt = resolveRuntime();
      // --fast：注入 Edit-2511 Lightning 蒸馏 LoRA（固定权重 1.0），默认 8 步 / cfg 1.0；
      // --fast 4 优先用匹配的 4 步 LoRA（lightningedit2511x4），未注册则回退 8 步 LoRA 跑 4 步
      const fast = opts.fast !== undefined;
      const fastSteps = opts.fast === true ? 8 : parseInt(opts.fast as string, 10);
      const trueCfg = opts.cfg !== undefined ? parseFloat(opts.cfg) : fast ? 1.0 : 4.0;
      const steps = opts.steps !== undefined ? parseInt(opts.steps, 10) : fast ? fastSteps : 20;
      const loras: { path: string; scale: number }[] = [];
      if (fast) {
        const wantX4 = fastSteps <= 4;
        const lt =
          (wantX4 ? findLora('lightningedit2511x4') : undefined) ?? findLora('lightningedit2511');
        if (!lt || !fs.existsSync(lt.path)) {
          console.error('--fast 需要 lightningedit2511 LoRA（下载后: lmedia lora add lightningedit2511 <path> --kind speed）');
          process.exit(2);
        }
        loras.push({ path: lt.path, scale: 1.0 });
      }
      const result = await runImageJob(rt, {
        kind: 'edit',
        daemonModes: ['edit'],
        script: path.join(rt.pythonDir, 'edit.py'),
        noDaemon: opts.daemon === false,
        payload: {
          prompt,
          out: path.resolve(opts.out!),
          snapshotEdit: rt.snapshotEdit,
          refs: opts.ref.map((r) => path.resolve(r)),
          width: parseInt(opts.width!, 10),
          height: parseInt(opts.height!, 10),
          steps,
          trueCfg,
          neg: trueCfg > 1 ? (opts.neg ?? ' ') : undefined,
          seed: parseInt(opts.seed!, 10),
          loras,
          lightningSched: fast || undefined,
          teaCache: parseCache(opts.cache),
        },
      });
      console.log(JSON.stringify(result, null, 2));
    });
}

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
  const image = program.command('image').description('图像生产能力（文生图/参考图编辑/超分/常驻 daemon）');
  registerGen(image);
  registerEdit(image);
  registerUpscale(image);
  registerServe(image);
}
