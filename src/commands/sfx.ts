/** lmedia sfx — 音效模态：Dasheng-AudioGen 本地生成（Apache 2.0，MPS，零 API 成本）+ 后处理产线
 * 生成：质量门（峰值≥-25dBFS + SNR≥20dB，全废自动加掷≤2）→ 剪裁（两级静音检测 + 簇截断）→ 段内两遍峰值归一 -6dBFS
 * 后处理：trim/recut（剪裁）· normalize（峰值/loudnorm）· accept（量化验收）· ab（A/B 试听页）· lib（SSOT 音效库）
 * 铁律：prompt 必须纯英文场景描述（"A friendly cartoon bear making soft grunting sounds"），中文会被英文文本编码器读成人声废片
 * 退出码：0 成功 / 1 环境·清单损坏·漂移·验收不过 / 2 参数非法·文件不存在
 */
import type { Command } from 'commander';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { hasCommand } from '../lib/which.js';
import { hfSnapshot, resolveAudioRuntime, type AudioRuntime } from '../lib/runtime.js';
import { runPython, type PyResult } from '../lib/run-python.js';
import {
  InvalidArgsError,
  SfxEnvError,
  addEntry,
  initLibrary,
  listEntries,
  removeEntry,
  resolveLibraryRoot,
  verifyLibrary,
} from '../lib/sfx-library.js';
import {
  assertFilesExist,
  assertMutuallyExclusive,
  parseAbGroups,
  parseBatchManifest,
  parseCap,
  parseLoudness,
  parseMaxDur,
  parseMinDur,
  parsePad,
  parseRolls,
  parseTarget,
  parseThreshDb,
  type AbGroup,
  type BatchItem,
} from '../lib/sfx-args.js';

const MODEL = 'mispeech/Dasheng-AudioGen';
const TOKENIZER = 'mispeech/dashengtokenizer';

/** 统一退出：参数/文件问题 2，环境/清单损坏/验收不过 1 */
function fail(e: unknown): never {
  if (e instanceof InvalidArgsError) {
    console.error(`✗ ${e.message}`);
    process.exit(2);
  }
  console.error(`✗ ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}

/** 音效 venv（缺失 → 安装指引 + exit 1） */
function requireAudioRuntime(): AudioRuntime {
  const rt = resolveAudioRuntime();
  if (!fs.existsSync(rt.pythonAudio)) {
    throw new SfxEnvError(
      `音效 venv 未找到: ${rt.pythonAudio}\n` +
      `修复: lmedia sfx setup（或 cd ${rt.root} && uv venv .venv-audio --python 3.11 && ` +
      `uv pip install -p .venv-audio/bin/python torch torchaudio "transformers<5" einops soundfile）`,
    );
  }
  return rt;
}

function requireFfmpeg(): void {
  if (!hasCommand('ffmpeg') || !hasCommand('ffprobe')) {
    throw new SfxEnvError('缺少 ffmpeg/ffprobe（brew install ffmpeg），音频后处理依赖');
  }
}

/** python op 执行：非零退出/结果不可解析 → exit 1（文案沿用 runPython 契约） */
async function runSfxOp(rt: AudioRuntime, payload: Record<string, unknown>): Promise<PyResult> {
  try {
    return await runPython(rt.pythonAudio, path.join(rt.pythonDir, 'sfx.py'), payload);
  } catch (e) {
    throw new SfxEnvError((e as Error).message);
  }
}

const n1 = (v: number | undefined): string => (v === undefined ? '?' : v.toFixed(1));
const pad = (s: string, w: number): string => (s.length >= w ? s : s + ' '.repeat(w - s.length));
const padL = (s: string, w: number): string => (s.length >= w ? s : ' '.repeat(w - s.length) + s);

function registerGen(sfx: Command): void {
  sfx
    .command('gen <prompt>')
    .description('文生音效。prompt 用英文描述声音场景（非拟声词）')
    .option('-o, --out <file>', '输出 wav 路径', 'sfx.wav')
    .option('--rolls <n>', '基础生成次数（全废自动加掷≤2）', '3')
    .option('--keep-rolls', '保留全部掷次到 <out>.rolls/ 目录')
    .option('--full', '跳过剪裁，保留 10s 原始生成')
    .action(async (prompt: string, opts: { out?: string; rolls?: string; keepRolls?: boolean; full?: boolean }) => {
      try {
        const rolls = parseRolls(opts.rolls);
        const rt = requireAudioRuntime();
        requireFfmpeg();
        const out = path.resolve(opts.out ?? 'sfx.wav');
        fs.mkdirSync(path.dirname(out), { recursive: true });
        console.error(`🎬 sfx gen（${rolls} 掷 + 质量门 + 剪裁）…`);
        const res = await runSfxOp(rt, {
          prompt, out, rolls, keepRolls: !!opts.keepRolls, trim: !opts.full,
        });
        const r = res as unknown as {
          out?: string; bestRoll?: number; peak?: number; snr?: number; dur?: number; gatePassed?: boolean;
        };
        if (r.out) {
          console.error(`${r.gatePassed ? '✓' : '⚠️ 无合格掷（取峰值最高，建议重跑）'} best=r${r.bestRoll} peak=${r.peak}dB snr=${r.snr}dB → ${r.out} (${r.dur}s)`);
        }
      } catch (e) {
        fail(e);
      }
    });
}

function registerBatch(sfx: Command): void {
  sfx
    .command('batch')
    .description('清单驱动批量生成：逐 key 多掷 + 质量门选优 → <dir>/<key>.best.wav + report.json')
    .requiredOption('-m, --manifest <file>', '批清单 JSON 路径（- 读 stdin）')
    .requiredOption('-o, --out <dir>', '输出目录')
    .option('--rolls <n>', '每 key 基础生成次数（1-10，全废自动加掷≤2）', '3')
    .option('--keep-rolls', '保留全部掷次到输出目录（<key>.r<N>.wav）')
    .option('--full', '跳过剪裁，保留 10s 原始生成')
    .option('--keys <list>', '只跑子集，逗号分隔（如 bear,frog）')
    .action(async (opts: {
      manifest: string; out: string; rolls?: string; keepRolls?: boolean; full?: boolean; keys?: string;
    }) => {
      try {
        const rolls = parseRolls(opts.rolls);
        const text = opts.manifest === '-'
          ? fs.readFileSync(0, 'utf-8')
          : (() => {
            if (!fs.existsSync(opts.manifest)) {
              throw new InvalidArgsError(`批清单不存在: ${opts.manifest}`);
            }
            return fs.readFileSync(opts.manifest, 'utf-8');
          })();
        const items: BatchItem[] = parseBatchManifest(
          text, opts.keys ? opts.keys.split(',').map((k) => k.trim()).filter(Boolean) : undefined,
        );
        const rt = requireAudioRuntime();
        requireFfmpeg();
        const outDir = path.resolve(opts.out);
        fs.mkdirSync(outDir, { recursive: true });
        console.error(`🎬 sfx batch（${items.length} key × ${rolls} 掷）→ ${outDir}`);
        const res = await runSfxOp(rt, {
          op: 'batch', items, outDir, rolls, keepRolls: !!opts.keepRolls, trim: !opts.full,
        }) as unknown as { dir: string; report: unknown; items: { key: string; anyPass: boolean }[]; genSec: number };
        const nPass = res.items.filter((i) => i.anyPass).length;
        console.error(`✓ 完成 ${nPass}/${res.items.length} key 有合格生成（${res.genSec}s）→ ${path.join(res.dir, 'report.json')}`);
        console.log(JSON.stringify(res, null, 2));
      } catch (e) {
        fail(e);
      }
    });
}

interface TrimItem {
  in: string; trim?: string; short?: string;
  durIn?: number; durTrim?: number; durShort?: number; durOut?: number;
  peakIn?: number; peakOut?: number;
}

function registerTrim(sfx: Command): void {
  sfx
    .command('trim <files...>')
    .description('去首尾静音（两级阈值）+ 内部簇截断 → <name>.trim.wav + <name>.short.wav + <name>.ops.json')
    .option('--thresh <v>', '静音阈值（形如 -35dB）', '-35dB')
    .option('--pad <sec>', '剪裁前后保留（秒）', '0.15')
    .action(async (files: string[], opts: { thresh?: string; pad?: string }) => {
      try {
        assertFilesExist(files);
        const thresh = parseThreshDb(opts.thresh, -35);
        const padSec = parsePad(opts.pad);
        requireFfmpeg();
        const rt = requireAudioRuntime();
        console.error(`· 剪裁 ${files.length} 个文件（thresh ${opts.thresh} / pad ${padSec}s）`);
        const res = await runSfxOp(rt, {
          op: 'trim', files, threshDb: thresh, pad: padSec,
        }) as unknown as { items: TrimItem[] };
        for (const it of res.items) {
          console.log(`✓ ${it.in} → ${it.trim} (dur ${n1(it.durIn)}→${n1(it.durTrim)}, peak ${n1(it.peakIn)}→${n1(it.peakOut)})`);
          console.error(`· short: ${it.short}（${n1(it.durShort)}s）`);
        }
      } catch (e) {
        fail(e);
      }
    });
}

function registerRecut(sfx: Command): void {
  sfx
    .command('recut <files...>')
    .description('灵敏重剪（-40dB/0.45s 间隙 + 硬帽）+ 段内归一 → 覆写 <name>.short.wav')
    .option('--thresh <v>', '静音阈值（形如 -40dB）', '-40dB')
    .option('--cap <sec>', '成品时长硬帽（0.5-10s）', '3.5')
    .action(async (files: string[], opts: { thresh?: string; cap?: string }) => {
      try {
        assertFilesExist(files);
        const thresh = parseThreshDb(opts.thresh, -40);
        const cap = parseCap(opts.cap);
        requireFfmpeg();
        const rt = requireAudioRuntime();
        console.error(`· 重剪 ${files.length} 个文件（thresh ${opts.thresh} / cap ${cap}s）`);
        const res = await runSfxOp(rt, {
          op: 'recut', files, threshDb: thresh, cap,
        }) as unknown as { items: TrimItem[] };
        for (const it of res.items) {
          console.log(`✓ ${it.in} → ${it.short} (dur ${n1(it.durIn)}→${n1(it.durOut)}, peak ${n1(it.peakIn)}→${n1(it.peakOut)})`);
        }
      } catch (e) {
        fail(e);
      }
    });
}

interface NormItem {
  in: string; out: string; durIn: number; durOut: number; peakIn: number; peakOut: number;
  mode: string; skipped: boolean; reason: string; gain?: number | null; lufsIn?: number; lufsOut?: number;
}

function registerNormalize(sfx: Command): void {
  sfx
    .command('normalize <files...>')
    .description('响度归一：默认两遍峰值归一 -6dBFS；--loudness 走 loudnorm 两遍（ambient）')
    .option('--target <dbfs>', '峰值目标 dBFS（-60 - -0.5，缺省 -6）')
    .option('--loudness <lufs>', '综合响度目标 LUFS（-40 - -5，与 --target 互斥）')
    .option('--out-dir <dir>', '输出目录（缺省原地覆写）')
    .action(async (files: string[], opts: { target?: string; loudness?: string; outDir?: string }) => {
      try {
        assertFilesExist(files);
        assertMutuallyExclusive(opts.target, opts.loudness, '--target', '--loudness');
        // 显式传参才走对应模式：只给 --loudness → loudnorm；否则峰值归一（--target 可省略）
        const loudness = opts.loudness !== undefined ? parseLoudness(opts.loudness) : undefined;
        const target = opts.target !== undefined ? parseTarget(opts.target) : -6.0;
        requireFfmpeg();
        const rt = requireAudioRuntime();
        const outDir = opts.outDir ? path.resolve(opts.outDir) : undefined;
        console.error(`· 归一 ${files.length} 个文件（${loudness !== undefined ? `loudnorm ${loudness} LUFS` : `峰值 ${target} dBFS`}）`);
        const res = await runSfxOp(rt, {
          op: 'normalize', files, target, loudness, outDir,
        }) as unknown as { items: NormItem[] };
        for (const it of res.items) {
          if (it.skipped) {
            console.log(`· ${it.in} → ${it.out}（${it.reason}）`);
          } else if (it.mode === 'loudness') {
            console.log(`✓ ${it.in} → ${it.out} (dur ${n1(it.durIn)}→${n1(it.durOut)}, lufs ${n1(it.lufsIn)}→${n1(it.lufsOut)})`);
          } else {
            console.log(`✓ ${it.in} → ${it.out} (dur ${n1(it.durIn)}→${n1(it.durOut)}, peak ${n1(it.peakIn)}→${n1(it.peakOut)})`);
          }
        }
      } catch (e) {
        fail(e);
      }
    });
}

interface AcceptItem {
  path: string; dur: number; peak: number; mean: number; flags: string[]; pass: boolean;
}

function registerAccept(sfx: Command): void {
  sfx
    .command('accept <files...>')
    .description('量化验收：时长/峰值/均值报表（任一 flag 命中 exit 1，人工终审前置）')
    .option('--max-dur <sec>', '过长阈值（秒）', '4.0')
    .option('--min-dur <sec>', '过短阈值（秒）', '0.4')
    .action(async (files: string[], opts: { maxDur?: string; minDur?: string }) => {
      try {
        assertFilesExist(files);
        const minDur = parseMinDur(opts.minDur);
        const maxDur = parseMaxDur(opts.maxDur, minDur);
        requireFfmpeg();
        const rt = requireAudioRuntime();
        const res = await runSfxOp(rt, {
          op: 'accept', files, maxDur, minDur,
        }) as unknown as { items: AcceptItem[] };
        console.error(`${pad('文件', 42)}${padL('时长', 7)}${padL('峰值', 10)}${padL('均值', 10)}  flag`);
        for (const it of res.items) {
          const name = path.basename(it.path);
          const flagText = it.pass ? it.flags.join(',') : `✗ ${it.flags.join(',')}`;
          console.log(
            `${pad(name, 42)}${padL(`${n1(it.dur)}s`, 7)}${padL(`${n1(it.peak)}dB`, 10)}${padL(`${n1(it.mean)}dB`, 10)}  ${pad(flagText, 16)} status=${it.pass ? 'pass' : 'fail'}`,
          );
        }
        const nPass = res.items.filter((i) => i.pass).length;
        console.log(`${nPass}/${res.items.length} 通过`);
        if (nPass !== res.items.length) process.exit(1);
      } catch (e) {
        fail(e);
      }
    });
}

function registerAb(sfx: Command): void {
  sfx
    .command('ab')
    .description('生成 A/B 试听页（独立 html，候选音频拷贝到 ab_files/ 相对路径引用）')
    .requiredOption('-m, --groups <file>', 'groups JSON：[{"name":"...","candidates":["a.wav","b.wav"]}]')
    .requiredOption('-o, --out <file>', '输出 html 路径')
    .action(async (opts: { groups: string; out: string }) => {
      try {
        if (!fs.existsSync(opts.groups)) throw new InvalidArgsError(`groups 文件不存在: ${opts.groups}`);
        const groups: AbGroup[] = parseAbGroups(fs.readFileSync(opts.groups, 'utf-8'));
        const candidates = groups.flatMap((g) => g.candidates);
        assertFilesExist(candidates, '候选音频');
        const rt = requireAudioRuntime();  // abpage 只拷贝文件，不需要 ffmpeg
        const out = path.resolve(opts.out);
        fs.mkdirSync(path.dirname(out), { recursive: true });
        const res = await runSfxOp(rt, { op: 'abpage', groups, out }) as unknown as {
          out: string; groups: number; candidates: number;
        };
        console.error(`· 候选音频已拷贝到 ${path.join(path.dirname(out), 'ab_files')}`);
        console.log(`✓ ${res.out}（${res.groups} 组 / ${res.candidates} 候选）`);
      } catch (e) {
        fail(e);
      }
    });
}

function registerSetup(sfx: Command): void {
  sfx
    .command('setup')
    .description('幂等创建音效 venv（uv venv .venv-audio + torch/transformers<5 等）')
    .action(async () => {
      try {
        const rt = resolveAudioRuntime();
        if (spawnSync('which', ['uv'], { stdio: 'ignore' }).status !== 0) {
          throw new SfxEnvError('缺少 uv（curl -LsSf https://astral.sh/uv/install.sh | sh），sfx setup 依赖');
        }
        const deps = ['torch', 'torchaudio', 'transformers<5', 'einops', 'soundfile'];
        if (fs.existsSync(rt.pythonAudio)) {
          const ok = spawnSync(rt.pythonAudio, ['-c', 'import torch, torchaudio, transformers, einops, soundfile'], { stdio: 'ignore' }).status === 0;
          if (ok) {
            console.error(`✓ 音效 venv 已就绪: ${rt.pythonAudio}`);
            return;
          }
          console.error('· venv 已存在但依赖不全 → 补装');
        } else {
          console.error(`· 创建 venv: ${rt.root}/.venv-audio（python 3.11）`);
          const r = spawnSync('uv', ['venv', path.join(rt.root, '.venv-audio'), '--python', '3.11'], { stdio: 'inherit' });
          if (r.status !== 0) throw new SfxEnvError('uv venv 失败');
        }
        console.error(`· 安装依赖: ${deps.map((d) => (d.includes('<') ? `"${d}"` : d)).join(' ')}`);
        const r = spawnSync('uv', ['pip', 'install', '-p', rt.pythonAudio, ...deps], { stdio: 'inherit' });
        if (r.status !== 0) throw new SfxEnvError('依赖安装失败（uv pip install）');
        console.error(`✓ 音效 venv 就绪: ${rt.pythonAudio}`);
      } catch (e) {
        fail(e);
      }
    });
}

function registerSfxDoctor(sfx: Command): void {
  sfx
    .command('doctor')
    .description('音效栈自检（venv / 主模型缓存 / 分词器缓存），独立退出码 0/1')
    .action(async () => {
      try {
        const rt = resolveAudioRuntime();
        const checks: [string, boolean, string][] = [
          ['音效 venv', fs.existsSync(rt.pythonAudio),
            `修复: lmedia sfx setup（建 ${rt.root}/.venv-audio）`],
          [`主模型缓存 ${MODEL}`, !!hfSnapshot(MODEL),
            `修复: HF_HUB_OFFLINE=0 huggingface-cli download ${MODEL}（或任一 transformers 加载触发下载）`],
          [`分词器缓存 ${TOKENIZER}`, !!hfSnapshot(TOKENIZER),
            `修复: HF_HUB_OFFLINE=0 huggingface-cli download ${TOKENIZER}`],
        ];
        for (const [name, ok, fix] of checks) {
          if (ok) console.log(`✓ ${name}`);
          else console.log(`✗ ${name} 缺失 → ${fix}`);
        }
        const bad = checks.filter(([, ok]) => !ok).length;
        if (bad === 0) {
          console.log('音效模态就绪（sfx gen/batch 可用）');
        } else {
          console.error(`音效栈缺失 ${bad} 项（见 ✗ 修复指引）`);
          process.exit(1);
        }
      } catch (e) {
        fail(e);
      }
    });
}

function registerLib(sfx: Command): void {
  const lib = sfx.command('lib').description('SSOT 音效库：入库（44.1k mono 160k mp3）/ 列表 / 移除 / 对账');

  lib
    .command('init')
    .description('创建库根 + 目录骨架 + 空清单（幂等）')
    .option('--lib <dir>', '库根（缺省 ~/.config/limg/sfx-library，可被 LMEDIA_SFX_LIB 覆盖）')
    .action(async (opts: { lib?: string }) => {
      try {
        const root = resolveLibraryRoot(opts.lib);
        const r = initLibrary(root);
        console.log(`${r.created ? '✓ 已创建' : '· 已存在'}音效库: ${r.root}（清单 ${r.manifest}）`);
      } catch (e) {
        fail(e);
      }
    });

  lib
    .command('add <file>')
    .description('转码入库 + 清单落账（同内容重复登记幂等跳过）')
    .requiredOption('--key <k>', '音效 key（小写字母/数字/短横线）')
    .option('--type <t>', 'sfx | ambient', 'sfx')
    .option('--library <name>', '库名（落入记录 library 字段）', 'default')
    .option('--title <t>', '标题')
    .option('--note <n>', '备注')
    .option('--tags <list>', '标签，逗号分隔（如 animal,cute）')
    .option('--lib <dir>', '库根')
    .action(async (file: string, opts: {
      key: string; type?: string; library?: string; title?: string; note?: string; tags?: string; lib?: string;
    }) => {
      try {
        if (opts.type !== 'sfx' && opts.type !== 'ambient') {
          throw new InvalidArgsError(`--type 仅支持 sfx|ambient: ${opts.type}`);
        }
        if (opts.library !== undefined && !opts.library.trim()) {
          throw new InvalidArgsError('--library 需为非空库名');
        }
        assertFilesExist([file], '输入音频');
        const root = resolveLibraryRoot(opts.lib);
        const { item, duplicated } = addEntry(root, {
          file: path.resolve(file),
          key: opts.key,
          type: opts.type,
          library: opts.library,
          title: opts.title,
          note: opts.note,
          tags: opts.tags ? opts.tags.split(',').map((t) => t.trim()).filter(Boolean) : [],
        });
        if (duplicated) {
          console.log(`· 已有同内容条目: ${item.key}（content_hash 相同，幂等跳过）`);
          return;
        }
        console.log(`✓ 入库 ${item.key} → ${item.path}（${item.duration.toFixed(2)}s / ${item.sample_rate}Hz / [${item.tags.join(', ')}]）`);
      } catch (e) {
        fail(e);
      }
    });

  lib
    .command('list')
    .description('表格列出库内条目（stdout 行数 == 过滤后清单条数）')
    .option('--type <t>', '按类型过滤（sfx|ambient）')
    .option('--status <s>', '按状态过滤（ready）')
    .option('--lib <dir>', '库根')
    .action(async (opts: { type?: string; status?: string; lib?: string }) => {
      try {
        const root = resolveLibraryRoot(opts.lib);
        const items = listEntries(root, { type: opts.type, status: opts.status });
        console.error(`${pad('key', 20)}${pad('type', 9)}${padL('dur', 8)}  ${pad('tags', 18)}${pad('status', 7)}path`);
        for (const i of items) {
          console.log(
            `${pad(i.key, 20)}${pad(i.type, 9)}${padL(i.duration.toFixed(2), 8)}  ${pad(`[${i.tags.join(',')}]`, 18)}${pad(i.status, 7)}${i.path}`,
          );
        }
        console.error(`共 ${items.length} 条`);
      } catch (e) {
        fail(e);
      }
    });

  lib
    .command('remove <key>')
    .description('移除清单记录（不删音频文件）')
    .option('--type <t>', '按类型限定（sfx|ambient）')
    .option('--lib <dir>', '库根')
    .action(async (key: string, opts: { type?: string; lib?: string }) => {
      try {
        const root = resolveLibraryRoot(opts.lib);
        const removed = removeEntry(root, key, opts.type);
        if (!removed) {
          // 契约：目标不存在属清单/记录域 → exit 1（非参数格式错误）
          console.error(`✗ 库中无此记录（按 type 过滤后）: ${key}（lmedia sfx lib list 查看）`);
          process.exit(1);
        }
        console.log(`✓ 已移除记录 ${key}（音频文件保留: ${removed.path}）`);
      } catch (e) {
        fail(e);
      }
    });

  lib
    .command('verify')
    .description('对账：记录 ↔ 文件 ↔ 时长（±0.1s）↔ status，漂移 exit 1')
    .option('--lib <dir>', '库根')
    .action(async (opts: { lib?: string }) => {
      try {
        const root = resolveLibraryRoot(opts.lib);
        const { items, problems } = verifyLibrary(root);
        for (const item of items) {
          const p = problems.find((x) => x.key === item.key && x.type === item.type);
          if (!p) console.log(`✓ ${item.key}（${item.type}）`);
          else console.log(`✗ ${item.key}（${item.type}）: ${p.issues.join('; ')}`);
        }
        console.error(`共 ${items.length} 条，漂移 ${problems.length} 条`);
        if (problems.length) process.exit(1);
      } catch (e) {
        fail(e);
      }
    });
}

export function registerSfx(program: Command): void {
  const sfx = program
    .command('sfx')
    .description('音效模态：Dasheng 本地生成（gen/batch）+ 剪裁/归一/验收/入库产线（trim/recut/normalize/accept/ab/lib）');

  registerGen(sfx);
  registerBatch(sfx);
  registerTrim(sfx);
  registerRecut(sfx);
  registerNormalize(sfx);
  registerAccept(sfx);
  registerAb(sfx);
  registerSetup(sfx);
  registerSfxDoctor(sfx);
  registerLib(sfx);
}

/** 全局 doctor 的 sfx 展示段（仅展示，不参与退出码判定） */
export function sfxDoctorChecks(): [string, boolean][] {
  const rt = resolveAudioRuntime();
  return [
    [`[sfx] .venv-audio（Dasheng-AudioGen）`, fs.existsSync(rt.pythonAudio)],
    [`[sfx] 主模型缓存 ${MODEL}`, !!hfSnapshot(MODEL)],
    [`[sfx] 分词器缓存 ${TOKENIZER}`, !!hfSnapshot(TOKENIZER)],
  ];
}
