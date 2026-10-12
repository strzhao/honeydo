/**
 * 红队验收测试共享工具（黑盒）——etts 能力包。
 *
 * 观测通道仅三种：
 *   1. CLI spawn（`node packages/etts/dist/cli.js` —— 验收场景绑定约定逐字：
 *      「etts bin 解析 = node /Users/stringzhao/workspace/honeydo/packages/etts/dist/cli.js」）
 *   2. 主壳 spawn（`node packages/cli/dist/index.js` —— 同绑定约定）
 *   3. 文件系统（mp3 stat / sha256 / mtime / 失败清单 JSONL / dist 产物）
 *
 * 铁律：绝不 import 任何实现模块（src/cli.ts、src/args.ts、python/etts.py 等）。
 */
import { spawn } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** packages/etts 包根（target 落位 packages/etts/tests/helpers/ 下，向上两级） */
export const ETTS_PKG_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
export const REPO_ROOT = path.resolve(ETTS_PKG_ROOT, '..', '..');
/** 绑定约定（验收场景·绑定约定）：etts bin = node <pkg>/dist/cli.js */
export const ETTS_BIN = path.join(ETTS_PKG_ROOT, 'dist', 'cli.js');
/** 绑定约定：honeydo = node packages/cli/dist/index.js */
export const HONEYDO_BIN = path.join(REPO_ROOT, 'packages', 'cli', 'dist', 'index.js');

/** 全部 etts 命令面 spawn 的退出码登记（供场景 11.P6「全命令面 exit ∈ {0,1,2}」汇总断言） */
export const exitCodes: number[] = [];

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
  /** stdout + stderr 合流，用于「错误含关键字」且流归属未逐字声明时兜底 */
  all: string;
}

export function runBin(
  args: string[],
  opts: { env?: Record<string, string | undefined>; timeoutMs?: number } = {},
): Promise<CliResult> {
  return spawnNode(ETTS_BIN, args, opts, true);
}

/** 主壳路由（场景 6）：`honeydo etts ...`，同样登记退出码（属 etts 命令面） */
export function runHoneydo(
  args: string[],
  opts: { env?: Record<string, string | undefined>; timeoutMs?: number } = {},
): Promise<CliResult> {
  return spawnNode(HONEYDO_BIN, args, opts, true);
}

/** 工程门禁命令（npm build/typecheck/test/lint）——非 etts 命令面，不登记 11.P6 */
export function runNpm(
  npmArgs: string[],
  opts: { cwd?: string; env?: Record<string, string | undefined>; timeoutMs?: number } = {},
): Promise<CliResult> {
  return spawnRaw('npm', npmArgs, opts);
}

/** venv 之外的任意命令（如 venv python -c 'import edge_tts'）——非 etts 命令面，不登记 */
export function runCmd(
  file: string,
  args: string[],
  opts: { env?: Record<string, string | undefined>; timeoutMs?: number } = {},
): Promise<CliResult> {
  return spawnRaw(file, args, opts);
}

/** 从 stderr 提取契约音色回显行（`voice: <name>…`）；无匹配返回原文（让断言以可读方式失败） */
export function voiceLine(stderr: string): string {
  const line = stderr.split('\n').find((l) => l.startsWith('voice: '));
  return line ?? stderr;
}

/** afinfo 估算时长（秒）。降级口径断言（场景 2.P2/10.P1）依赖：解析失败即抛错红灯 */
export async function durationSec(file: string, timeoutMs = 20_000): Promise<number> {
  const r = await spawnRaw('afinfo', [file], { timeoutMs });
  const m = /estimated duration:\s*([\d.]+)\s*sec/.exec(r.stdout);
  if (!m) throw new Error(`afinfo 未解析出时长: ${file} → ${r.stdout.slice(0, 200)}`);
  return Number(m[1]);
}

function mergeEnv(extra?: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return { ...process.env, ...(extra ?? {}) } as NodeJS.ProcessEnv;
}

function spawnNode(
  entry: string,
  args: string[],
  opts: { env?: Record<string, string | undefined>; timeoutMs?: number },
  record: boolean,
): Promise<CliResult> {
  return spawnRaw(process.execPath, [entry, ...args], opts, record);
}

function spawnRaw(
  file: string,
  args: string[],
  opts: { cwd?: string; env?: Record<string, string | undefined>; timeoutMs?: number } = {},
  record = false,
): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn(file, args, {
      cwd: opts.cwd,
      env: mergeEnv(opts.env),
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* 已退出 */
      }
    }, opts.timeoutMs ?? 120_000);
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      err += d.toString();
    });
    child.on('error', (e: Error) => {
      clearTimeout(timer);
      if (record) exitCodes.push(-1);
      resolve({ code: -1, stdout: out, stderr: `${err}\nspawn 失败: ${e.message}`, all: `${out}${err}${e.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const c = code ?? -1;
      if (record) exitCodes.push(c);
      resolve({ code: c, stdout: out, stderr: err, all: `${out}\n${err}` });
    });
  });
}

/* ------------------------------------------------------------------ */
/* 前置置备（失败 = 测试红灯，绝不宽容跳过）                             */
/* ------------------------------------------------------------------ */

/**
 * 确保 dist 产物就绪（etts bin + 主壳 bin）。缺失则执行 repo 根 `npm run build`；
 * 构建失败/产物仍缺 → throw（TDD 红灯），绝不静默跳过。
 */
export async function ensureDist(): Promise<void> {
  const need = [ETTS_BIN, HONEYDO_BIN].filter((p) => !fs.existsSync(p));
  if (need.length === 0) return;
  const r = await runNpm(['run', 'build'], { cwd: REPO_ROOT, timeoutMs: 600_000 });
  if (r.code !== 0) {
    throw new Error(
      `前置构建失败（npm run build exit=${r.code}）——契约 14.P1（build exit==0 且 dist 入口存在）未满足。\nstderr:\n${r.stderr.slice(-4000)}`,
    );
  }
  for (const p of [ETTS_BIN, HONEYDO_BIN]) {
    if (!fs.existsSync(p)) throw new Error(`构建后仍缺产物: ${p}`);
  }
}

/** venv 布局：python3 -m venv 标准产物 <dir>/bin/python（darwin） */
export function venvPython(runtimeDir: string): string {
  return path.join(runtimeDir, 'bin', 'python');
}

/**
 * 确保 venv 就绪（ETTS_RUNTIME 指向的目录存在 python 可执行 + edge_tts 可 import 的最弱证据：python 文件存在）。
 * 缺失则跑 `etts setup`（契约幂等：重复跑安全）。setup exit!=0 → throw（红灯）。
 * setup 自带「探测合成 1 条短样例」→ exit 0 同时证明 PyPI 与微软端点可达（网络场景前置）。
 */
export async function ensureVenv(runtimeDir: string): Promise<void> {
  if (fs.existsSync(venvPython(runtimeDir))) return;
  const r = await runBin(['setup'], {
    env: { ...process.env, ETTS_RUNTIME: runtimeDir },
    timeoutMs: 600_000,
  });
  if (r.code !== 0) {
    throw new Error(
      `venv 置备失败（etts setup exit=${r.code}；前置条件：PyPI 与微软端点可达，见验收场景绑定约定）\nstderr:\n${r.stderr.slice(-4000)}`,
    );
  }
}

/* ------------------------------------------------------------------ */
/* 观测小工具                                                           */
/* ------------------------------------------------------------------ */

export function sha256File(p: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

export function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** trim 后最后一个非空行（契约：结果类末行走 stdout） */
export function lastLine(s: string): string {
  const lines = s.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim().length > 0) return lines[i];
  }
  return '';
}

/** 解析 JSONL 文本（跳过空行），失败即抛（调用方负责先确定每行都是 JSON） */
export function parseJsonl(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue;
    out.push(JSON.parse(line) as Record<string, unknown>);
  }
  return out;
}

export function readJsonlFile(p: string): Record<string, unknown>[] {
  return parseJsonl(fs.readFileSync(p, 'utf8'));
}

/**
 * CONTRACT_AMBIGUOUS: 契约只声明 voices 人读输出为「ShortName/Gender/Locale 对齐列」，
 * 未声明分隔符与表头形态。按「≥2 空格分隔、≥3 列、第 3 列形如 bcp47 locale」解析数据行；
 * 表头/装饰行第 3 列不匹配 locale 正则，天然排除。
 */
export function extractVoiceRows(stdout: string): { shortName: string; gender: string; locale: string }[] {
  const rows: { shortName: string; gender: string; locale: string }[] = [];
  for (const line of stdout.split('\n')) {
    if (line.trim().length === 0) continue;
    const cols = line.trim().split(/\s{2,}/).map((c) => c.trim());
    if (cols.length < 3) continue;
    const locale = cols[2];
    if (!/^[a-z]{2,3}(-[A-Za-z0-9]+)*$/i.test(locale)) continue;
    if (/^(shortname|locale)$/i.test(cols[0])) continue;
    rows.push({ shortName: cols[0], gender: cols[1], locale });
  }
  return rows;
}

/**
 * CONTRACT_AMBIGUOUS: 绑定约定声明「stderr 重试/进度标记措辞以实现为准（契约仅约束存在且可计数）」，
 * 标记字面未声明 → 用 attempt/retry/尝试/重试 的组合正则计数，跨中英文兜底。
 */
export function countAttemptMarks(stderr: string): number {
  return (stderr.match(/\b(?:attempt|retry|retries|尝试|重试)/gi) ?? []).length;
}

/** 递归收集 dir 下指定后缀文件（场景 14.P2 freshness 观测用） */
export function collectFiles(dir: string, suffix: string, acc: string[] = []): string[] {
  if (!fs.existsSync(dir)) return acc;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) collectFiles(p, suffix, acc);
    else if (e.isFile() && e.name.endsWith(suffix)) acc.push(p);
  }
  return acc;
}

export function writeJsonl(p: string, lines: unknown[]): void {
  fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}
