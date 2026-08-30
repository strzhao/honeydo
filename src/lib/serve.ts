/** serve.ts — 常驻推理 daemon 客户端（unix socket NDJSON 协议）。
 *
 * daemon（python/serve.py）模型加载一次常驻，gen/edit/upscale 免每次 ~2min 冷加载。
 * 协议：一行 JSON 请求 → 0..n 个 queued/log 帧 → 恰好 1 个 done 帧 → close。
 * 错误语义（定死，勿改）：
 *  - connect 失败（ENOENT/ECONNREFUSED/超时）→ requestJob resolve(null) = daemon 不在，
 *    调用方决定自动拉起或回退冷路径；客户端**绝不 unlink socket**（防与并发 start 竞态）
 *  - connect 成功但 done 前断连 → reject（任务结果未知，不回退——避免 40min 任务重复跑）
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { resolveRuntime } from './runtime.js';
import type { PyResult } from './run-python.js';

export type ServeMode = 'gen' | 'edit';
export type JobKind = 'gen' | 'edit' | 'upscale';

export const SERVE_DIR = path.join(os.homedir(), '.lmedia', 'serve');
export const sockPath = (m: ServeMode) => path.join(SERVE_DIR, `${m}.sock`);
export const statusPath = (m: ServeMode) => path.join(SERVE_DIR, `${m}.json`);
export const logPath = (m: ServeMode) => path.join(SERVE_DIR, `${m}.log`);

export const DEFAULT_IDLE_TIMEOUT_SEC = 1800; // 空闲 30min 自退（用户决策 2026-08-29）

export interface DaemonStatus {
  pid: number;
  mode: ServeMode;
  state: 'boot' | 'loading' | 'ready' | 'busy';
  busy: boolean;
  queue: number;
  jobs: number;
  lastJobAt: number | null;
}

export function otherMode(m: ServeMode): ServeMode {
  return m === 'gen' ? 'edit' : 'gen';
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false; // ESRCH=进程不存在；EPERM 视为活（不归我们管）
  }
}

/** 读 status.json（可能陈旧——pid 已死即残留），返回 null=无文件 */
export function readStatus(m: ServeMode): (DaemonStatus & { snapshot?: string; startedAt?: number }) | null {
  try {
    return JSON.parse(fs.readFileSync(statusPath(m), 'utf-8'));
  } catch {
    return null;
  }
}

/** 向 daemon 发一行 JSON 请求并等 done 帧。null=daemon 不在（connect 失败）。 */
export function requestJob(
  mode: ServeMode,
  payload: { kind: JobKind | 'ping' } & Record<string, unknown>
): Promise<PyResult | null> {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ path: sockPath(mode) });
    sock.setNoDelay(true);
    let buf = '';
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      reject(err);
    };
    const gone = () => fail(new Error('daemon 连接中断（任务结果未知，不自动重跑；产物文件可能已落盘）'));
    sock.setTimeout(5000, () => {
      // connect 阶段超时=daemon 不在；连接建立后的读等待无超时（任务可达 60min）
      if (!sock.writableEnded && buf === '') {
        settled = true;
        sock.destroy();
        resolve(null);
      }
    });
    sock.on('connect', () => {
      sock.setTimeout(0);
      sock.write(`${JSON.stringify(payload)}\n`);
    });
    sock.on('error', (e: NodeJS.ErrnoException) => {
      if (settled) return;
      if (e.code === 'ENOENT' || e.code === 'ECONNREFUSED') {
        settled = true;
        sock.destroy();
        resolve(null); // daemon 不在
      } else fail(new Error(`daemon 连接错误: ${e.message}`));
    });
    sock.on('data', (d: Buffer) => {
      buf += d.toString();
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let frame: { t: string; [k: string]: unknown };
        try {
          frame = JSON.parse(line);
        } catch {
          continue;
        }
        if (frame.t === 'log') {
          process.stderr.write(String(frame.line ?? '') + (String(frame.line ?? '').endsWith('\n') ? '' : '\n'));
        } else if (frame.t === 'queued') {
          process.stderr.write(`排队中（前面还有 ${frame.position} 个任务）\n`);
        } else if (frame.t === 'done') {
          settled = true;
          sock.end();
          if (frame.ok) resolve(frame.result as PyResult);
          else fail(new Error(`daemon 任务失败: ${frame.error}\n${frame.tb ?? ''}`));
        }
      }
    });
    sock.on('close', () => gone());
  });
}

/** ping daemon。null=不在/陈旧。 */
export async function pingDaemon(mode: ServeMode): Promise<DaemonStatus | null> {
  const r = await requestJob(mode, { kind: 'ping' });
  return (r as unknown as DaemonStatus) ?? null;
}

/**
 * 拉起 daemon（幂等：已在运行直接返回状态）。
 * spawn detached python/serve.py，stdio 落 log 文件，轮询 socket 文件出现（上限 20s——
 * 覆盖解释器启动 + bind；模型加载在 bind 之后，不在此等待）。
 */
export async function spawnDaemon(
  mode: ServeMode,
  opts: { idleTimeoutSec?: number } = {}
): Promise<{ pid: number } | null> {
  const alive = await pingDaemon(mode);
  if (alive) return { pid: alive.pid };
  const rt = resolveRuntime();
  fs.mkdirSync(SERVE_DIR, { recursive: true });
  const idle = String(opts.idleTimeoutSec ?? DEFAULT_IDLE_TIMEOUT_SEC);
  const args = [
    path.join(rt.pythonDir, 'serve.py'),
    '--mode', mode,
    '--socket', sockPath(mode),
    '--status', statusPath(mode),
    '--log', logPath(mode),
    '--snapshot', mode === 'gen' ? rt.snapshot : rt.snapshotEdit,
    '--idle-timeout', idle,
  ];
  const logFd = fs.openSync(logPath(mode), 'a');
  const child = spawn(rt.pythonGen, args, {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env, HF_HUB_OFFLINE: process.env.HF_HUB_OFFLINE ?? '1' },
  });
  child.unref();
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(sockPath(mode))) return { pid: child.pid ?? -1 };
    await sleep(200);
  }
  return null; // 启动失败（venv 坏/脚本错）——log 文件有现场
}

/**
 * 停 daemon：TERM → 轮询退出 ≤15s → SIGKILL。ping 不通但文件残留 → 清理（幂等）。
 */
export async function stopDaemon(mode: ServeMode): Promise<'stopped' | 'killed' | 'not-running' | 'not-running-cleaned'> {
  const st = await pingDaemon(mode);
  if (!st) {
    // 陈旧残留清理（-9 遗物）：socket/status 文件存在但无 listener
    const had = fs.existsSync(sockPath(mode)) || fs.existsSync(statusPath(mode));
    for (const p of [sockPath(mode), statusPath(mode)]) {
      try { fs.rmSync(p); } catch { /* 尽力 */ }
    }
    return had ? 'not-running-cleaned' : 'not-running';
  }
  try { process.kill(st.pid, 'SIGTERM'); } catch { /* 已退 */ }
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && pidAlive(st.pid)) await sleep(300);
  if (pidAlive(st.pid)) {
    try { process.kill(st.pid, 'SIGKILL'); } catch { /* 已退 */ }
    await sleep(500);
    for (const p of [sockPath(mode), statusPath(mode)]) {
      try { fs.rmSync(p); } catch { /* 尽力 */ }
    }
    return 'killed';
  }
  return 'stopped'; // 正常路径：daemon 自己 unlink 了 socket+status
}

/**
 * GPU 串行铁律的运行时防护：冷路径回退前，任一模式 daemon 正忙（busy/queue>0）则等它空闲，
 * 防止冷路径加载模型与常驻模型抢 MPS。LMEDIA_NO_GPU_WAIT=1 绕过。
 */
export async function waitGpuIdle(): Promise<void> {
  if (process.env.LMEDIA_NO_GPU_WAIT === '1') return;
  for (;;) {
    const busy = (await pingDaemon('gen')) ?? (await pingDaemon('edit'));
    if (!busy || (!busy.busy && busy.queue === 0)) return;
    process.stderr.write(`等待 ${busy.mode} daemon 空闲（GPU 串行；LMEDIA_NO_GPU_WAIT=1 可跳过）…\n`);
    await sleep(5000);
  }
}
