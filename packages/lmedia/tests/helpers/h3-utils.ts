/**
 * 红队验收测试共享工具（h3 image 引擎 · 黑盒）。
 *
 * 观测通道仅三种：
 *   1. CLI spawn（lmedia: `tsx packages/lmedia/src/index.ts`；主壳: `tsx packages/cli/src/index.ts`）
 *   2. 文件系统（PNG 头 8 字节 / IHDR 尺寸 / report.json / index.json 原始字节 / 锁文件 lock.start|end 时间戳行 / venv 产物 stat）
 *   3. npm pack --dry-run（发布白名单观测）
 *
 * 铁律：绝不 import 任何实现模块（src/commands/image.ts、src/lib/h3-*.ts、python/*.py 一概不碰）。
 * 全部用例在 mock 模式驱动，隔离 env 清单（验收场景 SSOT 冻结）：
 *   LMEDIA_IMAGE_MOCK=1 + H3_RUNTIME（桩目录，不碰外盘真栈）+
 *   H3_STYLES_LIB / H3_CHARS_LIB（隔离资产库根）+
 *   LMEDIA_IMAGE_STATE（隔离 gate 状态文件）+ H3_LOCK（隔离锁文件）。
 */
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir, readJson } from './sfx-utils';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** packages/lmedia */
export const PROJECT_ROOT = path.resolve(HERE, '..', '..');
/** 仓库根（honeydo monorepo） */
export const REPO_ROOT = path.resolve(PROJECT_ROOT, '..', '..');
export const CLI_ENTRY = path.join(PROJECT_ROOT, 'src', 'index.ts');
export const MAIN_CLI_ENTRY = path.join(REPO_ROOT, 'packages', 'cli', 'src', 'index.ts');

const TSX = [
  path.join(PROJECT_ROOT, 'node_modules', '.bin', 'tsx'),
  path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx'),
].find((p) => fs.existsSync(p)) ?? 'tsx';

/**
 * 从开发机继承环境里抹掉的干扰变量（显式传入 opts.env 的除外）。
 * 包含 h3 新 seam 与旧图像链路全部开关，保证 hermetic。
 */
const NOISE = [
  'LMEDIA_RUNTIME', 'LMEDIA_NO_DAEMON', 'LMEDIA_NO_IMAGE_GATE', 'LMEDIA_IMAGE_STATE',
  'LMEDIA_NO_GPU_WAIT', 'LMEDIA_IMAGE_MOCK', 'H3_RUNTIME', 'H3_STYLES_LIB', 'H3_CHARS_LIB',
  'H3_LOCK', 'LMEDIA_SFX_LIB', 'HF_HOME', 'HF_HUB_CACHE', 'HF_HUB_OFFLINE',
];
/**
 * doctor 用裁剪版：保留 LMEDIA_RUNTIME / HF_*（doctor 的 [video]/[sfx] 等非 image 节
 * 要按本机真实栈求值；[image] 节由显式 H3_RUNTIME 桩 + LMEDIA_IMAGE_STATE 驱动）。
 */
const NOISE_DOCTOR = NOISE.filter(
  (k) => !['LMEDIA_RUNTIME', 'HF_HOME', 'HF_HUB_CACHE', 'HF_HUB_OFFLINE'].includes(k),
);

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
  /** stdout + stderr 合并，用于谓词未绑定流时的内容断言 */
  all: string;
}

function spawnCli(
  entry: string,
  cwd: string,
  args: string[],
  opts: { env?: Record<string, string>; timeoutMs?: number; home?: string },
  noise: string[],
): Promise<CliResult> {
  return new Promise((resolve) => {
    const e: NodeJS.ProcessEnv = { ...process.env };
    for (const k of noise) if (!(k in (opts.env ?? {}))) delete e[k];
    if (opts.home) e.HOME = opts.home;
    Object.assign(e, opts.env ?? {});
    const child = spawn(TSX, [entry, ...args], { cwd, env: e });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
    }, opts.timeoutMs ?? 50_000);
    child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { err += d.toString(); });
    child.on('error', (er: Error) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout: out, stderr: `${err}\nspawn 失败: ${er.message}`, all: `${out}${err}${er.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout: out, stderr: err, all: `${out}\n${err}` });
    });
  });
}

/** lmedia CLI（黑盒 spawn，mock 隔离 env 由 fixture 提供） */
export function runH3Cli(
  args: string[],
  opts: { env?: Record<string, string>; timeoutMs?: number; home?: string } = {},
): Promise<CliResult> {
  return spawnCli(CLI_ENTRY, PROJECT_ROOT, args, opts, NOISE);
}

/** doctor 专用：仅抹 image/h3 域变量，保留本机真实栈 env（非 image 节按真实栈求值） */
export function runDoctorCli(
  args: string[],
  opts: { env?: Record<string, string>; timeoutMs?: number } = {},
): Promise<CliResult> {
  return spawnCli(CLI_ENTRY, PROJECT_ROOT, args, opts, NOISE_DOCTOR);
}

/** 主壳 CLI（packages/cli，--engine 枚举 / 路由层的黑盒观测点） */
export function runMainCli(
  args: string[],
  opts: { env?: Record<string, string>; timeoutMs?: number } = {},
): Promise<CliResult> {
  return spawnCli(MAIN_CLI_ENTRY, REPO_ROOT, args, opts, NOISE);
}

/* ------------------------------------------------------------------ */
/* mock 隔离 fixture                                                    */
/* ------------------------------------------------------------------ */

export interface H3Fixture {
  root: string;
  /** H3_RUNTIME：桩栈根（stubRuntime 往里造 venv/权重分片） */
  runtime: string;
  /** H3_STYLES_LIB：风格库根（index.json 位于 <root>/index.json） */
  stylesLib: string;
  /** H3_CHARS_LIB：角色库根 */
  charsLib: string;
  /** LMEDIA_IMAGE_STATE：gate 状态文件（不存在 = 默认启用，沿用仓内既有语义） */
  stateFile: string;
  /** H3_LOCK：零依赖锁文件 */
  lockFile: string;
  outDir: string;
  workDir: string;
  env(over?: Record<string, string>): Record<string, string>;
  dispose(): void;
}

export function makeFixture(prefix: string): H3Fixture {
  const root = tmpDir(prefix);
  const fx: H3Fixture = {
    root,
    runtime: path.join(root, 'h3-runtime'),
    stylesLib: path.join(root, 'h3-styles-lib'),
    charsLib: path.join(root, 'h3-chars-lib'),
    stateFile: path.join(root, 'image-state.json'),
    lockFile: path.join(root, 'h3.lock'),
    outDir: path.join(root, 'out'),
    workDir: path.join(root, 'work'),
    env(over: Record<string, string> = {}) {
      return {
        LMEDIA_IMAGE_MOCK: '1',
        H3_RUNTIME: fx.runtime,
        H3_STYLES_LIB: fx.stylesLib,
        H3_CHARS_LIB: fx.charsLib,
        LMEDIA_IMAGE_STATE: fx.stateFile,
        H3_LOCK: fx.lockFile,
        ...over,
      };
    },
    dispose() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
  fs.mkdirSync(fx.outDir, { recursive: true });
  fs.mkdirSync(fx.workDir, { recursive: true });
  return fx;
}

/* ------------------------------------------------------------------ */
/* 桩 H3 runtime（不碰外盘真栈；mock 下 python 不加载真权重）              */
/* ------------------------------------------------------------------ */

/**
 * 按设计文档的栈布局造最小桩：
 *   新布局：<runtime>/venv + <runtime>/weights/image/transformer_diffusers(12 分片) + <runtime>/weights/tower/text_encoder(14 分片)
 *   legacy：<runtime>/venv + <runtime>/image/transformer_diffusers + <runtime>/tower/text_encoder（同层）
 * 顶层另放 pdd_fused_heads.safetensors（设计：存在但不计入分片数）。
 * weights:false 时只造 venv（权重缺失类用例）。
 */
export function stubRuntime(
  runtime: string,
  layout: 'new' | 'legacy' = 'new',
  opts: { weights?: boolean } = {},
): void {
  const venvBin = path.join(runtime, 'venv', 'bin');
  fs.mkdirSync(venvBin, { recursive: true });
  fs.writeFileSync(path.join(venvBin, 'python'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(
    path.join(runtime, 'venv', 'pyvenv.cfg'),
    'home = /usr/bin\ninclude-system-site-packages = false\nversion = 3.12.0\n',
  );
  if (opts.weights === false) return;
  const imageRoot = layout === 'new' ? path.join(runtime, 'weights', 'image') : path.join(runtime, 'image');
  const towerRoot = layout === 'new' ? path.join(runtime, 'weights', 'tower') : path.join(runtime, 'tower');
  const shard = (i: number, total: number): string =>
    `${String(i).padStart(5, '0')}-of-${String(total).padStart(5, '0')}`;
  fs.mkdirSync(path.join(imageRoot, 'transformer_diffusers'), { recursive: true });
  for (let i = 1; i <= 12; i++) {
    fs.writeFileSync(path.join(imageRoot, 'transformer_diffusers', `diffusion_pytorch_model-${shard(i, 12)}.safetensors`), 'stub');
  }
  fs.mkdirSync(path.join(towerRoot, 'text_encoder'), { recursive: true });
  for (let i = 1; i <= 14; i++) {
    fs.writeFileSync(path.join(towerRoot, 'text_encoder', `model-${shard(i, 14)}.safetensors`), 'stub');
  }
  fs.writeFileSync(path.join(imageRoot, 'pdd_fused_heads.safetensors'), 'stub');
}

/* ------------------------------------------------------------------ */
/* PNG 观测（文件头字节）                                                */
/* ------------------------------------------------------------------ */

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 头 8 字节 == PNG magic（场景 1.P1 的 observe） */
export function pngMagicOk(file: string): boolean {
  const fd = fs.openSync(file, 'r');
  try {
    const b = Buffer.alloc(8);
    fs.readSync(fd, b, 0, 8, 0);
    return b.equals(PNG_MAGIC);
  } finally {
    fs.closeSync(fd);
  }
}

/** IHDR 宽高（字节 16-23，大端）；非 PNG / 非 IHDR 直接抛（响亮失败） */
export function pngDims(file: string): { width: number; height: number } {
  const b = fs.readFileSync(file);
  if (!b.subarray(0, 8).equals(PNG_MAGIC) || b.subarray(12, 16).toString('latin1') !== 'IHDR') {
    throw new Error(`不是合法 PNG（IHDR 缺失）: ${file}`);
  }
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

/** 最小合法 1x1 PNG（资产 add 的锚页/角色卡 fixture） */
const ONE_PX_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

export function writeMinimalPng(file: string): string {
  const buf = Buffer.from(ONE_PX_PNG_B64, 'base64');
  if (!buf.subarray(0, 8).equals(PNG_MAGIC)) {
    throw new Error('内嵌 1x1 PNG fixture 字节无效（测试自身前提失败，必须响亮）');
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
  return file;
}

/* ------------------------------------------------------------------ */
/* stdout / JSON 契约观测                                                */
/* ------------------------------------------------------------------ */

/** stdout 恰好一行（trim 后无内部换行且非空），返回该行；违反直接抛 */
export function expectSingleLine(stdout: string): string {
  const t = stdout.trim();
  if (t.length === 0 || t.includes('\n')) {
    throw new Error(`stdout 应恰好一行，实际 ${JSON.stringify(stdout.slice(0, 400))}`);
  }
  return t;
}

/** 取 stdout 最后一个非空行并 JSON.parse（--json 元数据） */
export function lastJsonLine(stdout: string): Record<string, unknown> {
  const lines = stdout.trim().split('\n').filter((l) => l.trim().length > 0);
  if (lines.length === 0) throw new Error(`stdout 无可解析行: ${JSON.stringify(stdout.slice(0, 400))}`);
  return JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
}

/** 两个路径指向同一真实文件（吸收 /tmp ↔ /private/tmp 符号链接差异） */
export function sameRealFile(a: string, b: string): boolean {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* 锁文件时间戳观测（场景 8：lock.start / lock.end 时间戳行）             */
/* ------------------------------------------------------------------ */

export interface LockInterval { start: number; end: number }

function normEpoch(v: number): number {
  return v < 1e12 ? v * 1000 : v; // 秒 → 毫秒
}

function parseLockTs(line: string): number {
  // JSONL 形态兜底
  try {
    const o = JSON.parse(line) as Record<string, unknown>;
    for (const k of ['ts', 'time', 'timestamp', 'at', 'start', 'end']) {
      const v = o[k];
      if (typeof v === 'number' && Number.isFinite(v)) return normEpoch(v);
      if (typeof v === 'string') {
        const p = Date.parse(v);
        if (Number.isFinite(p)) return p;
        const n = Number(v);
        if (Number.isFinite(n) && n > 0) return normEpoch(n);
      }
    }
  } catch { /* 非 JSON，走 token 扫描 */ }
  const tokens = line.split(/\s+/);
  for (let i = tokens.length - 1; i >= 1; i--) {
    const t = tokens[i];
    if (/^\d+(\.\d+)?$/.test(t)) return normEpoch(Number(t));
    const p = Date.parse(t);
    if (Number.isFinite(p)) return p;
  }
  const pAll = Date.parse(line.replace(/lock\.(start|end)/g, '').trim());
  return Number.isFinite(pAll) ? pAll : NaN;
}

/**
 * 解析锁文件的 lock.start/lock.end 时间戳行 → 按发生顺序配对的闭区间列表（start 升序）。
 * 设计：持锁期间写 lock.start/lock.end 时间戳行（并发串行化的观测判据）。
 * 任何结构异常（文件缺失 / 配对残缺 / 时间戳不可解析）都直接抛——不允许宽容跳过。
 */
export function lockIntervals(lockFile: string): LockInterval[] {
  if (!fs.existsSync(lockFile)) {
    throw new Error(`锁文件未创建: ${lockFile}（设计要求单条命令也加锁并写 lock.start/lock.end）`);
  }
  const raw = fs.readFileSync(lockFile, 'utf-8');
  const events: { kind: 'start' | 'end'; ts: number }[] = [];
  for (const line0 of raw.split('\n')) {
    const line = line0.trim();
    if (!line) continue;
    const isStart = line.includes('lock.start');
    const isEnd = line.includes('lock.end');
    if (!isStart && !isEnd) continue;
    const ts = parseLockTs(line);
    if (!Number.isFinite(ts)) throw new Error(`锁时间戳行无法解析: ${JSON.stringify(line0)}`);
    events.push({ kind: isStart ? 'start' : 'end', ts });
  }
  const starts = events.filter((e) => e.kind === 'start').length;
  const ends = events.filter((e) => e.kind === 'end').length;
  if (starts < 2 || ends < 2) {
    throw new Error(`并发两任务应留下 ≥2 对 lock.start/lock.end，实际 start=${starts} end=${ends}\n--- 锁文件内容 ---\n${raw}`);
  }
  const out: LockInterval[] = [];
  let open: number | null = null;
  for (const e of events) {
    if (e.kind === 'start') {
      if (open !== null) throw new Error(`lock.start 嵌套（未先 end）:\n${raw}`);
      open = e.ts;
    } else {
      if (open === null) throw new Error(`lock.end 先于 lock.start:\n${raw}`);
      out.push({ start: open, end: e.ts });
      open = null;
    }
  }
  if (open !== null) throw new Error(`存在未闭合的 lock.start:\n${raw}`);
  return out.sort((a, b) => a.start - b.start);
}

/* ------------------------------------------------------------------ */
/* 资产库 index.json 定位 / npm pack 观测                                */
/* ------------------------------------------------------------------ */

/** 库根下定位 index.json（约定 <libRoot>/index.json；找不到就递归浅搜，绝不猜着重建） */
export function findIndexPath(libRoot: string): string {
  const direct = path.join(libRoot, 'index.json');
  if (fs.existsSync(direct)) return direct;
  const found: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 3) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name === 'index.json') found.push(p);
    }
  };
  walk(libRoot, 0);
  if (found.length !== 1) {
    throw new Error(`库根下应恰有一个 index.json（add 之后），实际 ${found.length}: ${JSON.stringify(found)}`);
  }
  return found[0];
}

/** npm pack --dry-run --json 的打包文件清单（发布白名单观测，npm≥7 输出 files[].path） */
export function npmPackDryRunFiles(): string[] {
  const r = spawnSync('npm', ['pack', '--dry-run', '--json'], { cwd: PROJECT_ROOT, encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`npm pack --dry-run 失败: ${r.stderr}`);
  const parsed = JSON.parse(r.stdout) as Array<{ files?: Array<{ path?: string }> }>;
  const files = parsed.flatMap((e) => (e.files ?? []).map((f) => f.path ?? '')).filter(Boolean);
  if (files.length === 0) throw new Error(`npm pack --json 未产出文件列表: ${r.stdout.slice(0, 400)}`);
  return files;
}

export { tmpDir, readJson };
