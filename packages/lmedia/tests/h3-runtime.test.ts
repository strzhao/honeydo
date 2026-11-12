/** h3-runtime 单测：栈解析三候选 × 两布局 / 分片计数 / lockfile（原子获取 + 释放标记 + stale 回收） */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  IMAGE_SHARDS,
  TOWER_SHARDS,
  countShards,
  detectH3Layout,
  h3LockPath,
  h3RuntimeCandidate,
  h3StackChecks,
  readH3LockStatus,
  reclaimStaleH3Lock,
  resolveH3Runtime,
  withH3Lock,
} from '../src/lib/h3-runtime.js';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 环境还原器：测后恢复原值（不污染其它用例） */
const envSnapshots: (() => void)[] = [];
function setEnv(k: string, v: string | undefined): void {
  const prev = process.env[k];
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
  envSnapshots.push(() => {
    if (prev === undefined) delete process.env[k];
    else process.env[k] = prev;
  });
}
afterEach(() => {
  for (const r of envSnapshots.splice(0)) r();
});

/** 桩栈：venv/bin/python + 权重分片（new 或 legacy 布局） */
function stubRuntime(base: string, layout: 'new' | 'legacy'): string {
  const imgDir = layout === 'new' ? path.join(base, 'weights', 'image') : path.join(base, 'image');
  const twDir = layout === 'new' ? path.join(base, 'weights', 'tower') : path.join(base, 'tower');
  fs.mkdirSync(path.join(base, 'venv', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(base, 'venv', 'bin', 'python'), '#!/bin/sh\n');
  fs.chmodSync(path.join(base, 'venv', 'bin', 'python'), 0o755);
  fs.mkdirSync(path.join(imgDir, 'transformer_diffusers'), { recursive: true });
  fs.mkdirSync(path.join(twDir, 'text_encoder'), { recursive: true });
  for (let i = 1; i <= IMAGE_SHARDS; i++) {
    fs.writeFileSync(path.join(imgDir, 'transformer_diffusers', `diffusion_pytorch_model-${String(i).padStart(5, '0')}-of-00012.safetensors`), 'x');
  }
  for (let i = 1; i <= TOWER_SHARDS; i++) {
    fs.writeFileSync(path.join(twDir, 'text_encoder', `model-${String(i).padStart(5, '0')}-of-00014.safetensors`), 'x');
  }
  return base;
}

let dir = '';

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'h3-runtime-'));
});

afterAll(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

describe('栈解析（三候选 × 两布局）', () => {
  it('H3_RUNTIME 显式目录（new 布局）→ weights/ 形态解析', () => {
    const root = stubRuntime(path.join(dir, 'rt-new'), 'new');
    setEnv('H3_RUNTIME', root);
    const rt = resolveH3Runtime();
    expect(rt?.layout).toBe('new');
    expect(rt?.transformerDir).toBe(path.join(root, 'weights', 'image', 'transformer_diffusers'));
    expect(rt?.textEncoderDir).toBe(path.join(root, 'weights', 'tower', 'text_encoder'));
    expect(rt?.venvPython).toBe(path.join(root, 'venv', 'bin', 'python'));
  });

  it('H3_RUNTIME 显式目录（legacy 同层布局）→ image/tower 形态解析', () => {
    const root = stubRuntime(path.join(dir, 'rt-legacy'), 'legacy');
    setEnv('H3_RUNTIME', root);
    const rt = resolveH3Runtime();
    expect(rt?.layout).toBe('legacy');
    expect(rt?.transformerDir).toBe(path.join(root, 'image', 'transformer_diffusers'));
    expect(rt?.textEncoderDir).toBe(path.join(root, 'tower', 'text_encoder'));
  });

  it('无 H3_RUNTIME → $LMEDIA_RUNTIME/h3 候选；栈不存在 → null', () => {
    const lr = path.join(dir, 'lr');
    fs.mkdirSync(path.join(lr, 'h3'), { recursive: true });
    stubRuntime(path.join(lr, 'h3'), 'new');
    delete process.env.H3_RUNTIME;
    setEnv('LMEDIA_RUNTIME', lr);
    expect(h3RuntimeCandidate()).toBe(path.join(lr, 'h3'));
    expect(resolveH3Runtime()?.root).toBe(path.join(lr, 'h3'));

    setEnv('H3_RUNTIME', path.join(dir, 'not-exist'));
    expect(resolveH3Runtime()).toBeNull();
    expect(detectH3Layout(path.join(dir, 'not-exist'))).toBeNull();
  });

  it('分片计数：12/14 就绪；缺片/顶层混入文件不计入', () => {
    const root = stubRuntime(path.join(dir, 'rt-count'), 'new');
    setEnv('H3_RUNTIME', root);
    const rt = resolveH3Runtime()!;
    expect(countShards(rt.transformerDir)).toBe(IMAGE_SHARDS);
    expect(countShards(rt.textEncoderDir)).toBe(TOWER_SHARDS);
    fs.rmSync(path.join(rt.transformerDir, 'diffusion_pytorch_model-00001-of-00012.safetensors'));
    expect(countShards(rt.transformerDir)).toBe(IMAGE_SHARDS - 1);
    expect(countShards(path.join(dir, 'nope'))).toBe(0);
  });
});

describe('h3StackChecks（preflight 永不抛）', () => {
  it('rt=null → 栈项逐项缺失 + fix 含 setup/doctor 指引（出厂资产独立于栈，如实反映包内现状）', () => {
    const items = h3StackChecks(null, path.join(PKG, 'assets'));
    const stack = items.filter((i) => !i.name.includes('出厂资产'));
    expect(stack.every((i) => !i.ok)).toBe(true);
    expect(items.map((i) => i.fix).join('\n')).toMatch(/lmedia image setup/);
    expect(items.map((i) => i.fix).join('\n')).toMatch(/lmedia doctor/);
  });

  it('完整桩栈 → 全部就绪（出厂资产在包内即 ok）', () => {
    const root = stubRuntime(path.join(dir, 'rt-ok'), 'new');
    setEnv('H3_RUNTIME', root);
    const items = h3StackChecks(resolveH3Runtime(), path.join(PKG, 'assets'));
    for (const i of items) {
      expect(`${i.name}=${i.ok}`, i.name).toBe(`${i.name}=true`);
    }
  });

  it('缺权重分片 → 对应项 ok=false 且 fix 指向分片目录', () => {
    const root = stubRuntime(path.join(dir, 'rt-part'), 'new');
    fs.rmSync(path.join(root, 'weights', 'image', 'transformer_diffusers', 'diffusion_pytorch_model-00002-of-00012.safetensors'));
    setEnv('H3_RUNTIME', root);
    const items = h3StackChecks(resolveH3Runtime(), path.join(PKG, 'assets'));
    const image = items.find((i) => i.name.includes('image 权重分片'))!;
    expect(image.ok).toBe(false);
    expect(image.fix).toContain(`11/${IMAGE_SHARDS}`);
    const tower = items.find((i) => i.name.includes('tower 权重分片'))!;
    expect(tower.ok).toBe(true);
  });
});

describe('lockfile（零依赖）', () => {
  it('原子获取 + 持锁写 pid/lock.start + 释放追加 lock.end（文件保留为释放标记）', async () => {
    const lock = path.join(dir, 'lock-basic.lock');
    setEnv('H3_LOCK', lock);
    expect(h3LockPath()).toBe(lock);
    expect(fs.existsSync(lock)).toBe(false);
    const inside = await withH3Lock(async () => {
      const st = readH3LockStatus(lock);
      expect(st.exists).toBe(true);
      expect(st.released).toBe(false);
      expect(st.pid).toBe(process.pid);
      expect(st.stale).toBe(false);
      expect(st.start).toBeTruthy();
      const raw = fs.readFileSync(lock, 'utf-8');
      expect(raw).toContain(`pid ${process.pid}`);
      expect(raw).toContain('lock.start ');
      return 42;
    });
    expect(inside).toBe(42);
    const after = readH3LockStatus(lock);
    expect(after.released).toBe(true);
    expect(after.end).toBeTruthy();
    expect(fs.existsSync(lock)).toBe(true); // 保留 = 释放标记 + 观测日志
  });

  it('已释放的锁 → 下一个持锁者回收并保留历史行', async () => {
    const lock = path.join(dir, 'lock-reuse.lock');
    setEnv('H3_LOCK', lock);
    await withH3Lock(async () => 1);
    const firstEnd = readH3LockStatus(lock).end;
    await new Promise((r) => setTimeout(r, 10)); // ISO 时间戳到 ms：同 ms 内两次释放无法区分
    await withH3Lock(async () => 2);
    const raw = fs.readFileSync(lock, 'utf-8');
    expect(raw.match(/lock\.end /g)?.length).toBeGreaterThanOrEqual(2);
    expect(readH3LockStatus(lock).end).not.toBe(firstEnd);
    expect(raw).toContain('pid '); // 历史行保留
  });

  it('stale 锁（PID 不存活）→ 自动回收后可获取', async () => {
    const lock = path.join(dir, 'lock-stale.lock');
    setEnv('H3_LOCK', lock);
    fs.writeFileSync(lock, `pid 999999999\nlock.start 2020-01-01T00:00:00Z\n`);
    const st = readH3LockStatus(lock);
    expect(st.stale).toBe(true);
    const held = await withH3Lock(async () => {
      // 持锁中检查：回收保留历史 + 当前持有者事件行在最后（状态取最后一个事件行）
      const raw = fs.readFileSync(lock, 'utf-8');
      expect(raw).toContain('pid 999999999');
      const cur = readH3LockStatus(lock);
      expect(cur.pid).toBe(process.pid);
      expect(cur.released).toBe(false);
      expect(cur.start).toBeTruthy(); // 末事件 = 本次 lock.start（持有中）
      return 'acquired';
    }, { pollMs: 20 });
    expect(held).toBe('acquired');
  });

  it('reclaimStaleH3Lock：stale → reclaimed；无锁 → idle', () => {
    const stale = path.join(dir, 'lock-reclaim.lock');
    fs.writeFileSync(stale, 'pid 999999999\nlock.start 2020-01-01T00:00:00Z\n');
    expect(reclaimStaleH3Lock(stale).action).toBe('reclaimed');
    expect(fs.existsSync(stale)).toBe(false);
    expect(reclaimStaleH3Lock(path.join(dir, 'never.lock')).action).toBe('idle');
  });

  it('活进程持锁（未释放）→ 轮询等待，超时抛错；不得硬抢', async () => {
    const lock = path.join(dir, 'lock-busy.lock');
    setEnv('H3_LOCK', lock);
    // 模拟“活着的别的进程”：detached 真子进程持锁（PID 存活判定走 kill(0)）
    const holder = spawn('sleep', ['5'], { stdio: 'ignore', detached: true });
    fs.writeFileSync(lock, `pid ${holder.pid}\nlock.start 2020-01-01T00:00:00Z\n`);
    await expect(withH3Lock(async () => 1, { pollMs: 20, timeoutMs: 80 })).rejects.toThrow(/超时/);
    expect(readH3LockStatus(lock).pid).toBe(holder.pid); // 未被硬抢
    holder.kill('SIGKILL');
    await new Promise<void>((res) => holder.once('exit', () => res())); // 等 reap（僵尸进程 kill(0) 仍算存活）
    expect(readH3LockStatus(lock).stale).toBe(true);
    holder.unref();
  });
});
