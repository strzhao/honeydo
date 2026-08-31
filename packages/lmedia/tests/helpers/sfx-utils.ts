/**
 * 红队验收测试共享工具（黑盒）。
 *
 * 观测通道仅三种：
 *   1. CLI spawn（`npx tsx src/index.ts ...`）
 *   2. ffmpeg / ffprobe（独立测量，不信任被测实现自报的指标）
 *   3. 文件系统（清单 JSON / wav 头 / sha256 / 原始字节）
 *
 * 绝不 import 任何实现模块（src/commands/sfx.ts、src/lib/sfx-library.ts 等）。
 */
import { spawn, spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const PROJECT_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
export const CLI_ENTRY = path.join(PROJECT_ROOT, 'src', 'index.ts');

/* ------------------------------------------------------------------ */
/* CLI 驱动                                                             */
/* ------------------------------------------------------------------ */

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
  /** stdout + stderr 合并，用于"错误输出含关键字"类断言（错误可能走任一流） */
  all: string;
}

export function runCli(
  args: string[],
  opts: { env?: Record<string, string | undefined>; timeoutMs?: number } = {},
): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn('npx', ['tsx', CLI_ENTRY, ...args], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, ...(opts.env ?? {}) } as NodeJS.ProcessEnv,
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
    }, opts.timeoutMs ?? 120_000);
    child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { err += d.toString(); });
    child.on('error', (e: Error) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout: out, stderr: `${err}\nspawn 失败: ${e.message}`, all: `${out}${err}${e.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout: out, stderr: err, all: `${out}\n${err}` });
    });
  });
}

/**
 * 涉及 `--lib` 的调用。设计文档只声明了"`--lib` 优先于 env 优先于默认"，
 * 未声明该 option 挂在 program / sfx / 叶子命令哪一层（CONTRACT_AMBIGUOUS），
 * 因此按三种挂载位置依次尝试，全部因 unknown option 失败时返回最后一次结果，
 * 由调用方硬断言兜底（不存在任何静默跳过）。
 */
export async function runSfxWithLib(
  sfxArgs: string[],
  libRoot: string,
  opts: { env?: Record<string, string | undefined>; timeoutMs?: number } = {},
): Promise<CliResult> {
  const placements: string[][] = [
    ['sfx', ...sfxArgs, '--lib', libRoot],
    ['sfx', '--lib', libRoot, ...sfxArgs],
    ['--lib', libRoot, 'sfx', ...sfxArgs],
  ];
  let last: CliResult | null = null;
  for (const argv of placements) {
    const r = await runCli(argv, opts);
    last = r;
    const unknownOpt = r.code !== 0 && /unknown option|未知选项|unknown required argument/i.test(r.stderr);
    if (!unknownOpt) return r;
  }
  return last as CliResult;
}

/* ------------------------------------------------------------------ */
/* ffmpeg / ffprobe 独立测量                                            */
/* ------------------------------------------------------------------ */

const FFMPEG = 'ffmpeg';
const FFPROBE = 'ffprobe';

interface SyncResult { code: number; stdout: Buffer; stderr: string; }

function runSync(bin: string, args: string[], maxBuffer = 1 << 28): SyncResult {
  const r = spawnSync(bin, args, { encoding: 'buffer', maxBuffer });
  return {
    code: r.status ?? -1,
    stdout: r.stdout as Buffer,
    stderr: (r.stderr as Buffer)?.toString() ?? '',
  };
}

/** 运行 ffmpeg，失败时抛出（fixture 制备阶段的硬前提）。 */
export function ffmpegRun(args: string[]): void {
  const r = runSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', ...args]);
  if (r.code !== 0) throw new Error(`ffmpeg ${args.join(' ')} 失败: ${r.stderr}`);
}

/** ffprobe 容器时长（秒）。 */
export function probeDuration(file: string): number {
  const r = runSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
  if (r.code !== 0) throw new Error(`ffprobe 失败: ${r.stderr}`);
  const v = Number(r.stdout.toString().trim());
  if (!Number.isFinite(v)) throw new Error(`ffprobe 无法解析时长: ${file}`);
  return v;
}

export interface WavInfo {
  isRiff: boolean;
  isWave: boolean;
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  dataBytes: number;
  /** 由 data 块字节数换算的时长（秒），用于绕开 format 标签的浮点误差 */
  duration: number;
}

/** 直接解析 RIFF/WAVE 头（不依赖 ffprobe），可同时验证容器有效性。 */
export function wavInfo(file: string): WavInfo {
  const b = fs.readFileSync(file);
  const tag = (off: number, len: number) => b.subarray(off, off + len).toString('latin1');
  const isRiff = tag(0, 4) === 'RIFF';
  const isWave = tag(8, 4) === 'WAVE';
  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  let dataBytes = 0;
  if (isRiff && isWave) {
    let off = 12;
    while (off + 8 <= b.length) {
      const id = tag(off, 4);
      const size = b.readUInt32LE(off + 4);
      if (id === 'fmt ') {
        channels = b.readUInt16LE(off + 8);
        sampleRate = b.readUInt32LE(off + 12);
        bitsPerSample = b.readUInt16LE(off + 22);
      } else if (id === 'data') {
        dataBytes = size;
        break;
      }
      off += 8 + size + (size % 2);
    }
  }
  const bytesPerFrame = Math.max(1, channels * Math.max(1, bitsPerSample) / 8);
  return {
    isRiff,
    isWave,
    sampleRate,
    channels,
    bitsPerSample,
    dataBytes,
    duration: sampleRate > 0 ? dataBytes / bytesPerFrame / sampleRate : 0,
  };
}

/** ffmpeg 解码为单声道 f32 原始 PCM（供样本级扫描）。 */
export function decodeMonoF32(file: string): Float32Array {
  const r = runSync(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-i', file,
    '-f', 'f32le', '-ac', '1', '-ar', '44100', '-',
  ]);
  if (r.code !== 0) throw new Error(`解码失败 ${file}: ${r.stderr}`);
  const usable = r.stdout.length - (r.stdout.length % 4);
  return new Float32Array(r.stdout.buffer, r.stdout.byteOffset, usable / 4);
}

/** 样本级峰值（dBFS）；全零样本返回 -Infinity。 */
export function peakDbfs(samples: Float32Array): number {
  let max = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > max) max = a;
  }
  return max === 0 ? Number.NEGATIVE_INFINITY : 20 * Math.log10(max);
}

export function countNonFinite(samples: Float32Array): number {
  let n = 0;
  for (let i = 0; i < samples.length; i++) if (!Number.isFinite(samples[i])) n++;
  return n;
}

/**
 * 独立响度测量：ffmpeg loudnorm print_format=json 的 input_i（LUFS）。
 * （场景 6.P1 声明允许 "ffmpeg ebur128 或 loudnorm print_format=json 测量"）
 */
export function measureLufs(file: string): number {
  const r = runSync(FFMPEG, ['-hide_banner', '-nostats', '-i', file, '-af', 'loudnorm=print_format=json', '-f', 'null', '-']);
  if (r.code !== 0) throw new Error(`loudnorm 测量失败 ${file}: ${r.stderr}`);
  const blocks = r.stderr.match(/\{[\s\S]*?\}/g) ?? [];
  if (blocks.length === 0) throw new Error(`loudnorm 未输出 JSON: ${r.stderr.slice(-400)}`);
  const parsed = JSON.parse(blocks[blocks.length - 1]) as Record<string, string>;
  return Number(parsed.input_i);
}

/* ------------------------------------------------------------------ */
/* 文件系统                                                             */
/* ------------------------------------------------------------------ */

export function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function sha256File(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** 读 JSON，解析失败直接抛（测试自身的前提失败要响亮，不允许吞掉）。 */
export function readJson<T = unknown>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
}

/** 递归收集对象树中指定 key 的全部取值。 */
export function collectValues(root: unknown, key: string): unknown[] {
  const out: unknown[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (node !== null && typeof node === 'object') {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        if (k === key) out.push(v);
        visit(v);
      }
    }
  };
  visit(root);
  return out;
}

/* ------------------------------------------------------------------ */
/* 音频 fixture 合成（全部 44.1kHz / mono / pcm_s16le）                  */
/* ------------------------------------------------------------------ */

export interface Fixtures {
  /** ① 首尾真静音(0.6s) + 中间发声 1.2s(峰值 -6dBFS) → 全长 2.4s */
  headTail: string;
  /** ② 首尾本底 -40dBFS(0.8s) + 发声 1.2s(峰值 -6dBFS) → 全长 2.8s */
  noiseFloor: string;
  /** ③ 全静音 1.0s */
  allSilence: string;
  /** ④ 首尾真静音(0.5s) + 段内峰值 -20.0dBFS(1.0s) → 全长 2.0s */
  peakKnown: string;
  /** ⑤ 已知响度正常短音：3.0s 正弦，峰值 -20dBFS，实测约 -23.7 LUFS */
  knownLoud: string;
  /** ⑥ 削波 wav：1.0s 正弦 16bit 硬削顶，峰值 ≈ 0 dBFS */
  clipping: string;
}

const tone = (amp: number, freq: number, dur: number): string =>
  `aevalsrc=${amp}*sin(2*PI*${freq}*t):d=${dur}:s=44100`;
const zero = (dur: number): string => `aevalsrc=0:d=${dur}:s=44100`;
const ENCODE = ['-ar', '44100', '-ac', '1', '-c:a', 'pcm_s16le', '-y'];

export function synthFixtures(dir: string): Fixtures {
  const j = (n: string): string => path.join(dir, n);
  const concat3 = (a: string, b: string, c: string, out: string): void =>
    ffmpegRun(['-f', 'lavfi', '-i', a, '-f', 'lavfi', '-i', b, '-f', 'lavfi', '-i', c,
      '-filter_complex', '[0:a][1:a][2:a]concat=n=3:v=0:a=1[out]', '-map', '[out]', ...ENCODE, out]);

  concat3(zero(0.6), tone(0.5012, 440, 1.2), zero(0.6), j('headtail.wav'));
  concat3(tone(0.01, 60, 0.8), tone(0.5012, 440, 1.2), tone(0.01, 60, 0.8), j('noisefloor.wav'));
  ffmpegRun(['-f', 'lavfi', '-i', zero(1.0), ...ENCODE, j('allsilence.wav')]);
  concat3(zero(0.5), tone(0.1, 440, 1.0), zero(0.5), j('peakknown.wav'));
  ffmpegRun(['-f', 'lavfi', '-i', tone(0.1, 440, 3.0), ...ENCODE, j('knownloud.wav')]);
  ffmpegRun(['-f', 'lavfi', '-i', tone(1.0, 440, 1.0), ...ENCODE, j('clipping.wav')]);

  const fx: Fixtures = {
    headTail: j('headtail.wav'),
    noiseFloor: j('noisefloor.wav'),
    allSilence: j('allsilence.wav'),
    peakKnown: j('peakknown.wav'),
    knownLoud: j('knownloud.wav'),
    clipping: j('clipping.wav'),
  };
  // fixture 前提硬校验：不满足即让整组测试响亮失败（不允许带病跑）
  expectNear(wavInfo(fx.headTail).duration, 2.4, 0.02, 'fixture① 时长');
  expectNear(wavInfo(fx.noiseFloor).duration, 2.8, 0.02, 'fixture② 时长');
  expectNear(wavInfo(fx.peakKnown).duration, 2.0, 0.02, 'fixture④ 时长');
  expectNear(peakDbfs(decodeMonoF32(fx.peakKnown)), -20.0, 0.05, 'fixture④ 段内峰值');
  expectNear(peakDbfs(decodeMonoF32(fx.clipping)), 0.0, 0.05, 'fixture⑥ 峰值');
  if (wavInfo(fx.headTail).sampleRate !== 44100) {
    throw new Error('fixture① 采样率前提不成立（应 44100）');
  }
  return fx;
}

export function expectNear(actual: number, expected: number, tol: number, label: string): void {
  if (!(Math.abs(actual - expected) <= tol)) {
    throw new Error(`${label}: 期望 |${actual} − ${expected}| ≤ ${tol}，实际偏差 ${Math.abs(actual - expected)}`);
  }
}

/** 按需合成单个正弦 wav（44.1kHz / mono / pcm_s16le），用于音效库入库类测试。 */
export function synthTone(
  dir: string,
  name: string,
  opts: { amp?: number; freq?: number; dur?: number } = {},
): string {
  const amp = opts.amp ?? 0.5012;
  const freq = opts.freq ?? 440;
  const dur = opts.dur ?? 0.8;
  const out = path.join(dir, name);
  ffmpegRun(['-f', 'lavfi', '-i', tone(amp, freq, dur), ...ENCODE, out]);
  if (!fs.existsSync(out)) throw new Error(`fixture 合成失败: ${out}`);
  return out;
}

/* ------------------------------------------------------------------ */
/* batch report.json 审计（场景 4.P1 与场景 1 冒烟共用同一裁决函数）        */
/* ------------------------------------------------------------------ */

export interface ReportCandidate {
  roll?: unknown;
  path?: unknown;
  peak?: unknown;
  snr?: unknown;
  pass?: unknown;
  reason?: unknown;
  /** 若实现直接给出分数则优先采用；契约未列此字段，属兼容兜底 */
  score?: unknown;
}

export interface ReportItem {
  key?: unknown;
  candidates?: unknown;
  winner?: unknown;
  anyPass?: unknown;
}

/** 候选分数：合格取 snr，淘汰取 peak（设计文档「winner.score 合格取 snr / 全废取 peak」同源规则）。 */
export function candidateScore(c: ReportCandidate): number | undefined {
  if (typeof c.score === 'number') return c.score;
  if (c.pass === true && typeof c.snr === 'number') return c.snr;
  if (typeof c.peak === 'number') return c.peak;
  return undefined;
}

/**
 * report.json 审计，返回违规描述列表（空数组 = 通过）。
 * 规则来自设计文档：多候选含分数；被淘汰候选 reason 非空；
 * 选优支配 = winner.score 必须是同资格池最高分（合格池按 snr / 全废池按 peak，禁止跨量纲比较）。
 * [2026-08-31 QA] 依 qa-reviewer 建议收紧：旧实现只对比淘汰池（peak 口径）近乎恒真，
 * 「取 min(snr) 当 winner」的变异可存活；现改为同资格池支配判定。
 */
export function auditReport(report: unknown): string[] {
  const violations: string[] = [];
  const items = (report as { items?: unknown })?.items;
  if (!Array.isArray(items) || items.length === 0) {
    return ['report.items 缺失或为空'];
  }
  items.forEach((raw, i) => {
    const item = raw as ReportItem;
    const key = typeof item.key === 'string' ? item.key : `#${i}`;
    const cands = item.candidates;
    if (!Array.isArray(cands) || cands.length === 0) {
      violations.push(`${key}: candidates 缺失或为空（无多掷样）`);
      return;
    }
    const eliminated = cands.filter((c) => (c as ReportCandidate).pass !== true) as ReportCandidate[];
    eliminated.forEach((c) => {
      if (typeof c.reason !== 'string' || c.reason.trim().length === 0) {
        violations.push(`${key}: 淘汰候选(roll=${String(c.roll)}) reason 非空约束被破坏`);
      }
    });
    const winner = item.winner as { score?: unknown } | undefined;
    if (!winner || typeof winner.score !== 'number') {
      violations.push(`${key}: winner.score 缺失或非数值`);
      return;
    }
    const anyPass = (item as { anyPass?: unknown }).anyPass;
    const pool = (anyPass === false
      ? (cands.filter((c) => (c as ReportCandidate).pass !== true) as ReportCandidate[])
      : (cands.filter((c) => (c as ReportCandidate).pass === true) as ReportCandidate[]));
    const poolScores = pool.map(candidateScore).filter((s): s is number => typeof s === 'number');
    if (poolScores.length > 1) {
      const maxPool = Math.max(...poolScores);
      if (winner.score < maxPool - 1e-9) {
        violations.push(`${key}: winner.score ${winner.score} < 同资格池最高分 ${maxPool}（选优支配被破坏）`);
      }
    }
  });
  return violations;
}

/* ------------------------------------------------------------------ */
/* 音效栈运行时前提（runtime.ts 声明的解析顺序，仅用于场景 3.P1 前置门控）    */
/* ------------------------------------------------------------------ */

/** LMEDIA_RUNTIME > ~/.lmedia/runtime（symlink）> ~/ml/lb-local-gen */
export function audioRuntimeRoot(): string {
  const envRoot = process.env.LMEDIA_RUNTIME ?? '';
  if (envRoot) return envRoot;
  const link = path.join(os.homedir(), '.lmedia', 'runtime');
  try {
    if (fs.existsSync(link)) return fs.realpathSync(link);
  } catch { /* 走默认 */ }
  return path.join(os.homedir(), 'ml', 'lb-local-gen');
}

export function audioEnvReady(): boolean {
  const python = path.join(audioRuntimeRoot(), '.venv-audio', 'bin', 'python');
  const model = path.join(os.homedir(), '.cache', 'huggingface', 'hub', 'models--mispeech--Dasheng-AudioGen');
  return fs.existsSync(python) && fs.existsSync(model);
}
