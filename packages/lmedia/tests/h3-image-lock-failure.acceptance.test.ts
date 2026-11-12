/**
 * 红队验收测试 · 场景 8 / 10 / 场景12.P5（GPU 并发串行化 + 运行时失败语义 + --json 冻结字段）。
 *
 * 场景 8：GPU 并发串行化（零依赖 lockfile：持锁写 lock.start/lock.end 时间戳行）→ P1-P2
 * 场景 10：运行时失败 → exit 1 + 无半成品 + 指引 → P1-P3
 * 场景12.P5：--json 元数据含全部冻结字段，seed 数值回显、elapsed_s > 0
 *
 * 黑盒铁律：只 spawn 真实 CLI + 文件系统观测（锁文件时间戳行 / 半成品缺失），绝不 import 实现模块。
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  lastJsonLine,
  lockIntervals,
  makeFixture,
  pngMagicOk,
  runH3Cli,
  stubRuntime,
} from './helpers/h3-utils';

const GEN_ARGS = (out: string): string[] => [
  'image', 'gen', '清晨的山谷原野', '--engine', 'h3', '--quality', 'draft', '-o', out,
];

describe('场景 8：GPU 并发串行化', () => {
  it('场景8.P1 [real-process] 两个并发 gen（mock）：两者 exit 0 且持锁区间不重叠', { timeout: 60_000 }, async () => {
    const fx = makeFixture('h3-s8p1-');
    stubRuntime(fx.runtime, 'new');
    try {
      const outA = path.join(fx.outDir, 'a.png');
      const outB = path.join(fx.outDir, 'b.png');
      // 同一 H3_LOCK 真并发（两次 spawn 同时挂起，靠锁串行）
      const [ra, rb] = await Promise.all([
        runH3Cli(GEN_ARGS(outA), { env: fx.env() }),
        runH3Cli(GEN_ARGS(outB), { env: fx.env() }),
      ]);
      expect(ra.code).toBe(0);
      expect(rb.code).toBe(0);
      expect(fs.existsSync(outA)).toBe(true);
      expect(fs.existsSync(outB)).toBe(true);
      // observe：锁文件持锁起止时间戳（lock.start / lock.end 行）
      const intervals = lockIntervals(fx.lockFile);
      expect(intervals.length).toBe(2);
      // 区间不重叠：前一持锁区间 end ≤ 后一区间 start
      for (let i = 0; i < intervals.length - 1; i++) {
        expect(intervals[i + 1].start).toBeGreaterThanOrEqual(intervals[i].end);
      }
    } finally {
      fx.dispose();
    }
  });

  it('场景8.P2 [det-machine] 后到任务 stderr 无并发冲突错误', { timeout: 60_000 }, async () => {
    const fx = makeFixture('h3-s8p2-');
    stubRuntime(fx.runtime, 'new');
    try {
      const outA = path.join(fx.outDir, 'a.png');
      const outB = path.join(fx.outDir, 'b.png');
      const [ra, rb] = await Promise.all([
        runH3Cli(GEN_ARGS(outA), { env: fx.env() }),
        runH3Cli(GEN_ARGS(outB), { env: fx.env() }),
      ]);
      expect(ra.code).toBe(0);
      expect(rb.code).toBe(0);
      // 后到任务以轮询等锁而非报错收场：两个进程的 stderr 均不得出现并发冲突类错误
      const conflict = /并发冲突|冲突|conflict|锁定失败|锁占用|获取锁失败|EEXIST|lock\s*(fail|error)/i;
      expect(conflict.test(ra.stderr)).toBe(false);
      expect(conflict.test(rb.stderr)).toBe(false);
    } finally {
      fx.dispose();
    }
  });
});

describe('场景 10：运行时失败 → exit 1 + 无半成品 + 指引', () => {
  it('场景10.P1 [real-process] -o 不可写目录 → exit 1、诊断仅 stderr、stdout 空', { timeout: 60_000 }, async () => {
    const fx = makeFixture('h3-s10p1-');
    stubRuntime(fx.runtime, 'new');
    try {
      const roDir = path.join(fx.root, 'readonly');
      fs.mkdirSync(roDir, { recursive: true });
      fs.chmodSync(roDir, 0o500); // r-x：进程属主不可写
      const out = path.join(roDir, 'out.png');
      try {
        const r = await runH3Cli(GEN_ARGS(out), { env: fx.env() });
        expect(r.code).toBe(1);
        expect(r.stdout.trim()).toBe('');
        expect(r.stderr.length).toBeGreaterThan(0);
      } finally {
        fs.chmodSync(roDir, 0o700); // 恢复以便清理
      }
    } finally {
      fx.dispose();
    }
  });

  it('场景10.P2 [det-machine] 失败后 -o 路径无半成品 PNG（临时文件+rename 原子写）', { timeout: 60_000 }, async () => {
    const fx = makeFixture('h3-s10p2-');
    stubRuntime(fx.runtime, 'new');
    try {
      const roDir = path.join(fx.root, 'readonly');
      fs.mkdirSync(roDir, { recursive: true });
      fs.chmodSync(roDir, 0o500);
      const out = path.join(roDir, 'out.png');
      try {
        const r = await runH3Cli(GEN_ARGS(out), { env: fx.env() });
        expect(r.code).toBe(1);
        expect(fs.existsSync(out)).toBe(false);
      } finally {
        fs.chmodSync(roDir, 0o700);
      }
    } finally {
      fx.dispose();
    }
  });

  it('场景10.P3 [real-process] 权重缺失（空 runtime）→ gen exit 1 且 stderr 含 setup/doctor 指引', { timeout: 60_000 }, async () => {
    const fx = makeFixture('h3-s10p3-');
    // 不造任何桩：空 runtime（无 venv 无权重）；gate 默认启用（state 文件不存在），preflight 必须拦下
    try {
      const out = path.join(fx.outDir, 'out.png');
      const r = await runH3Cli(GEN_ARGS(out), { env: fx.env() });
      expect(r.code).toBe(1);
      expect(/setup|doctor/i.test(r.stderr)).toBe(true);
      expect(fs.existsSync(out)).toBe(false);
    } finally {
      fx.dispose();
    }
  });
});

describe('场景 12（--json 冻结字段闭集）', () => {
  it('场景12.P5 [det-machine] --json 含全部冻结字段：seed 数值回显、elapsed_s 数值>0', { timeout: 60_000 }, async () => {
    const fx = makeFixture('h3-s12p5-');
    stubRuntime(fx.runtime, 'new');
    try {
      const out = path.join(fx.outDir, 'out.png');
      const r = await runH3Cli([...GEN_ARGS(out), '--json'], { env: fx.env() });
      expect(r.code).toBe(0);
      const meta = lastJsonLine(r.stdout);
      // 契约冻结字段名逐字：engine/quality/resolution/style/char/seed/output/elapsed_s
      for (const key of ['engine', 'quality', 'resolution', 'style', 'char', 'seed', 'output', 'elapsed_s']) {
        expect(Object.keys(meta)).toContain(key);
      }
      expect(typeof meta['seed']).toBe('number');
      expect(Number.isFinite(meta['seed'] as number)).toBe(true);
      expect(typeof meta['elapsed_s']).toBe('number');
      expect(meta['elapsed_s'] as number).toBeGreaterThan(0);
      // 出图本身成立（附带核验，防字段来自未真跑的空壳）
      expect(fs.existsSync(out)).toBe(true);
      expect(pngMagicOk(out)).toBe(true);
    } finally {
      fx.dispose();
    }
  });
});
