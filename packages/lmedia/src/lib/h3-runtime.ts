/**
 * H3-Image 推理栈解析（MiniMax-H3 本地两段式，venv + 126GB 权重）。
 *
 * 栈根解析优先级：H3_RUNTIME env > $LMEDIA_RUNTIME/h3 > <默认栈>/h3。
 * 布局两形态（迁移期均识别）：
 *   new    = <root>/venv/ + weights/image/transformer_diffusers + weights/tower/text_encoder
 *   legacy = <root>/venv/ + image/transformer_diffusers + tower/text_encoder（当前外盘布局）
 *
 * 零依赖 lockfile（GPU 串行铁律）：默认 ~/.lmedia/h3.lock，H3_LOCK env 可覆盖（测试隔离）。
 * fs.open(path,'wx') 原子创建（O_EXCL 等价）；持锁写 PID + lock.start 时间戳行，
 * 释放追加 lock.end 行（供并发串行化的观测判据）；持锁 PID 不存活 → stale 安全回收。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveRuntimeRoot } from './runtime.js';

export type H3Layout = 'new' | 'legacy';

export interface H3Runtime {
  root: string;
  layout: H3Layout;
  venvPython: string;     // <root>/venv/bin/python
  imageDir: string;       // DiT 权重父目录（weights/image 或 image）
  towerDir: string;       // 文本案权重父目录（weights/tower 或 tower）
  transformerDir: string; // <imageDir>/transformer_diffusers（12 分片）
  textEncoderDir: string; // <towerDir>/text_encoder（14 分片）
}

export interface PreflightItem {
  name: string;
  ok: boolean;
  fix: string;
}

/** image 权重分片数：transformer_diffusers 下 12 个 safetensors（顶层 pdd_fused_heads 不在此目录） */
export const IMAGE_SHARDS = 12;
/** tower 权重分片数：text_encoder 下 14 个 safetensors */
export const TOWER_SHARDS = 14;

/** 栈根候选（不校验存在性）：H3_RUNTIME > $LMEDIA_RUNTIME/h3 > <resolveRuntimeRoot()>/h3 */
export function h3RuntimeCandidate(): string {
  const env = process.env.H3_RUNTIME;
  if (env && env.trim()) return path.resolve(env.trim());
  const lr = process.env.LMEDIA_RUNTIME;
  if (lr && lr.trim()) return path.join(path.resolve(lr.trim()), 'h3');
  return path.join(resolveRuntimeRoot(), 'h3');
}

/** 目录内 safetensors 分片计数（探测失败 = 0） */
export function countShards(dir: string): number {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.safetensors')).length;
  } catch {
    return 0;
  }
}

/** 识别栈根布局；两形态都不匹配 → null（栈不存在或半就位） */
export function detectH3Layout(root: string): H3Layout | null {
  if (fs.existsSync(path.join(root, 'weights', 'image', 'transformer_diffusers'))
    || fs.existsSync(path.join(root, 'weights', 'tower', 'text_encoder'))) return 'new';
  if (fs.existsSync(path.join(root, 'image', 'transformer_diffusers'))
    || fs.existsSync(path.join(root, 'tower', 'text_encoder'))) return 'legacy';
  return null;
}

function buildRuntime(root: string, layout: H3Layout): H3Runtime {
  const imageDir = layout === 'new' ? path.join(root, 'weights', 'image') : path.join(root, 'image');
  const towerDir = layout === 'new' ? path.join(root, 'weights', 'tower') : path.join(root, 'tower');
  return {
    root: path.resolve(root),
    layout,
    venvPython: path.join(root, 'venv', 'bin', 'python'),
    imageDir,
    towerDir,
    transformerDir: path.join(imageDir, 'transformer_diffusers'),
    textEncoderDir: path.join(towerDir, 'text_encoder'),
  };
}

/** 解析 H3 栈：候选根两形态都不匹配 → null（调用方给 setup 指引，不猜） */
export function resolveH3Runtime(): H3Runtime | null {
  const root = h3RuntimeCandidate();
  const layout = detectH3Layout(root);
  return layout ? buildRuntime(root, layout) : null;
}

/** setup 的落盘目标（显式 env 优先；都没有时在候选根创建） */
export function h3SetupTarget(): string {
  return h3RuntimeCandidate();
}

/** 目录存在且非空 → true */
function dirHasEntries(p: string): boolean {
  try {
    return fs.readdirSync(p).length > 0;
  } catch {
    return false;
  }
}

/** 出厂资产（picturebook/pipi）随包完整性（import.meta.url 相对定位，repo 与发布布局一致） */
export function builtinAssetsOk(builtinRoot: string): boolean {
  const need = [
    path.join(builtinRoot, 'h3-styles', 'picturebook', 'style.json'),
    path.join(builtinRoot, 'h3-chars', 'pipi', 'char.json'),
  ];
  return need.every((p) => fs.existsSync(p));
}

/**
 * H3 栈就绪性检查（doctor / image enable·status / gen·edit·batch preflight 共用；**永不抛**）。
 * rt=null（栈找不到）时逐项按缺失报告。每项带 fix 指引；权重缺失不给下载承诺（126GB 不在 setup 内自动拉）。
 */
export function h3StackChecks(rt: H3Runtime | null, builtinRoot: string): PreflightItem[] {
  if (!rt) {
    const root = h3RuntimeCandidate();
    return [
      {
        name: 'h3 runtime 根',
        ok: false,
        fix: `H3 栈未找到（候选 ${root}）：设 H3_RUNTIME=<栈根>（venv/ + weights/image + weights/tower，或 legacy venv/ + image + tower 同层），或先 lmedia image setup 建 venv`,
      },
      { name: 'h3 venv', ok: false, fix: 'lmedia image setup（uv venv 优先，回退 python3 -m venv）' },
      {
        name: `[image] H3 image 权重分片（transformer_diffusers ×${IMAGE_SHARDS}）`,
        ok: false,
        fix: `确认权重在位（126GB 不在 setup 下载范围）：transformer_diffusers/ 下 ${IMAGE_SHARDS} 个 safetensors 分片；布局漂移用 H3_RUNTIME 指认；就位后 lmedia doctor 复核`,
      },
      {
        name: `[image] H3 tower 权重分片（text_encoder ×${TOWER_SHARDS}）`,
        ok: false,
        fix: `确认权重在位：text_encoder/ 下 ${TOWER_SHARDS} 个 safetensors 分片（顶层 pdd_fused_heads.safetensors 不计入）；就位后 lmedia doctor 复核`,
      },
      {
        name: '[image] H3 出厂资产（picturebook/pipi）',
        ok: builtinAssetsOk(builtinRoot),
        fix: '出厂资产应随包分发：重装 honeydo/lmedia，或检查 packages/lmedia/assets/h3-styles|chars',
      },
    ];
  }
  const imageShards = countShards(rt.transformerDir);
  const towerShards = countShards(rt.textEncoderDir);
  return [
    {
      name: `h3 runtime 根（${rt.layout} 布局）`,
      ok: true,
      fix: '',
    },
    {
      name: 'h3 venv',
      ok: fs.existsSync(rt.venvPython),
      fix: `lmedia image setup（建 ${path.join(rt.root, 'venv')}；uv venv 优先，回退 python3 -m venv）`,
    },
    {
      name: `[image] H3 image 权重分片（transformer_diffusers ×${IMAGE_SHARDS}）`,
      ok: imageShards === IMAGE_SHARDS && dirHasEntries(rt.transformerDir),
      fix: `分片 ${imageShards}/${IMAGE_SHARDS}（${rt.transformerDir}）：权重不在 setup 下载范围（126GB），H3_RUNTIME 指认现有栈或自行就位；就位后 lmedia doctor 复核`,
    },
    {
      name: `[image] H3 tower 权重分片（text_encoder ×${TOWER_SHARDS}）`,
      ok: towerShards === TOWER_SHARDS && dirHasEntries(rt.textEncoderDir),
      fix: `分片 ${towerShards}/${TOWER_SHARDS}（${rt.textEncoderDir}）：权重不在 setup 下载范围，就位后 lmedia doctor 复核`,
    },
    {
      name: '[image] H3 出厂资产（picturebook/pipi）',
      ok: builtinAssetsOk(builtinRoot),
      fix: '出厂资产应随包分发：重装 honeydo/lmedia，或检查 packages/lmedia/assets/h3-styles|chars',
    },
  ];
}

// ———————————————————————————— 零依赖 lockfile ————————————————————————————

export interface H3LockStatus {
  path: string;
  exists: boolean;
  pid?: number;
  released: boolean;   // 已写 lock.end（干净释放标记）
  start?: string;
  end?: string;
  stale: boolean;      // 存在、未释放、持锁 PID 不存活
}

export function h3LockPath(): string {
  const env = process.env.H3_LOCK;
  if (env && env.trim()) return path.resolve(env.trim());
  return path.join(os.homedir(), '.lmedia', 'h3.lock');
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readH3LockStatus(lockPath = h3LockPath()): H3LockStatus {
  let content = '';
  try {
    content = fs.readFileSync(lockPath, 'utf-8');
  } catch {
    return { path: lockPath, exists: false, released: false, stale: false };
  }
  // 历史行会随回收保留（lock.start/lock.end 追加日志）——当前状态由**最后一个事件行**决定
  const events = [...content.matchAll(/^pid (\d+)$|^lock\.start (.+)$|^lock\.end (.+)$/gm)];
  const last = events[events.length - 1];
  const released = last?.[3] !== undefined; // 末尾是 lock.end → 已释放
  const lastPid = [...events].reverse().find((e) => e[1] !== undefined)?.[1];
  const pid = Number.parseInt(lastPid ?? '', 10);
  const start = [...events].reverse().find((e) => e[2] !== undefined)?.[2];
  const end = last?.[3];
  return {
    path: lockPath,
    exists: true,
    pid: Number.isFinite(pid) ? pid : undefined,
    released,
    start,
    end,
    stale: !released && Number.isFinite(pid) && !pidAlive(pid),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * H3 GPU 串行锁（gen/edit/batch 全部走这里）：
 * - wx 原子创建；EEXIST 时读文件判定：已释放（有 lock.end）或 stale（PID 不存活）→ 回收重试
 * - 回收时保留旧内容（lock.start/lock.end 历史行）——并发串行化的观测判据
 * - 活锁：轮询重试（默认 2s 间隔，30min 超时）
 * - 释放：追加 lock.end 行（文件保留 = 释放标记 + 观测日志）
 */
export async function withH3Lock<T>(
  fn: () => Promise<T>,
  opts: { pollMs?: number; timeoutMs?: number } = {},
): Promise<T> {
  const lock = h3LockPath();
  const pollMs = opts.pollMs ?? 2000;
  const timeoutMs = opts.timeoutMs ?? 30 * 60_000;
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const started = Date.now();
  for (;;) {
    try {
      const fd = fs.openSync(lock, 'wx');
      try {
        fs.writeSync(fd, `pid ${process.pid}\nlock.start ${new Date().toISOString()}\n`);
      } finally {
        fs.closeSync(fd);
      }
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const st = readH3LockStatus(lock);
      if (st.exists && (st.released || st.stale)) {
        // 已释放/僵尸锁 → 回收（保留历史行供观测；rename 保证非原子窗口内不半写）
        let prev = '';
        try { prev = fs.readFileSync(lock, 'utf-8'); } catch { /* raced away */ }
        try {
          const aside = `${lock}.reclaim.${process.pid}`;
          fs.renameSync(lock, aside);
          fs.rmSync(aside, { force: true });
          const fd = fs.openSync(lock, 'wx');
          try {
            if (prev) fs.writeSync(fd, prev.endsWith('\n') || !prev ? prev : `${prev}\n`);
            fs.writeSync(fd, `pid ${process.pid}\nlock.start ${new Date().toISOString()}\n`);
          } finally {
            fs.closeSync(fd);
          }
          break;
        } catch { /* raced with another waiter → 重新走轮询 */ }
      } else if (Date.now() - started > timeoutMs) {
        throw new Error(
          `H3 锁等待超时（${Math.round(timeoutMs / 1000)}s）: ${lock}`
          + `（持锁 pid ${st.pid ?? '?'}，未释放也不像死进程——GPU 任务仍在跑或锁被外部干预）`,
        );
      }
      await sleep(pollMs);
    }
  }
  process.stderr.write(`[h3:lock] ${new Date().toISOString()} acquired (pid ${process.pid})\n`);
  try {
    return await fn();
  } finally {
    try {
      fs.appendFileSync(lock, `lock.end ${new Date().toISOString()}\n`);
      process.stderr.write(`[h3:lock] ${new Date().toISOString()} released (pid ${process.pid})\n`);
    } catch { /* 锁文件被外部删掉：释放尽力而为 */ }
  }
}

/** disable 时的锁处置：stale 顺手回收；活进程持锁则如实报告（不硬抢） */
export function reclaimStaleH3Lock(lockPath = h3LockPath()): { action: 'reclaimed' | 'held' | 'idle'; pid?: number } {
  const st = readH3LockStatus(lockPath);
  if (!st.exists || st.released) return { action: 'idle' };
  if (st.stale) {
    try {
      fs.rmSync(lockPath, { force: true });
      return { action: 'reclaimed', pid: st.pid };
    } catch {
      return { action: 'held', pid: st.pid };
    }
  }
  return { action: 'held', pid: st.pid };
}
