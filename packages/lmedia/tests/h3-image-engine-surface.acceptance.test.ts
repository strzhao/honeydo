/**
 * 红队验收测试 · 场景 6 / 9 / 场景12.P6（引擎关系面：默认引擎、deprecated、doubao 保留、参数错误、gate 闭环）。
 *
 * 场景 6：默认引擎 + deprecated + doubao 保留   → P1-P4
 * 场景 9：参数错误 → exit 2 + stdout 干净       → P1-P3
 * 场景12.P6：image disable → gen 被拦（doubao 云端替代提示）→ enable 恢复
 *
 * 黑盒铁律：只 spawn 真实 CLI（lmedia + 主壳 packages/cli）+ 文件系统观测，绝不 import 实现模块。
 * 9.P1 走主壳（--engine 枚举校验是主壳 takeFlag 的设计职责）；其余走 lmedia。
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  lastJsonLine,
  makeFixture,
  pngMagicOk,
  runH3Cli,
  runMainCli,
  stubRuntime,
} from './helpers/h3-utils';

describe('场景 6：默认引擎 + deprecated + doubao 保留', () => {
  it('场景6.P1 [real-process] 不带 --engine 的 gen 实际 engine==h3（经 --json）', { timeout: 60_000 }, async () => {
    const fx = makeFixture('h3-s6p1-');
    stubRuntime(fx.runtime, 'new');
    try {
      const out = path.join(fx.outDir, 'out.png');
      const r = await runH3Cli(
        ['image', 'gen', '清晨的山谷原野', '--quality', 'draft', '-o', out, '--json'],
        { env: fx.env() },
      );
      expect(r.code).toBe(0);
      const meta = lastJsonLine(r.stdout);
      expect(meta['engine']).toBe('h3');
    } finally {
      fx.dispose();
    }
  });

  it('场景6.P2 [real-process] --engine qwen（mock 走 h3 管道）exit 0 且 stderr 含弃用提示', { timeout: 60_000 }, async () => {
    const fx = makeFixture('h3-s6p2-');
    stubRuntime(fx.runtime, 'new');
    try {
      const out = path.join(fx.outDir, 'out.png');
      const r = await runH3Cli(
        ['image', 'gen', '清晨的山谷原野', '--engine', 'qwen', '--quality', 'draft', '-o', out],
        { env: fx.env() },
      );
      expect(r.code).toBe(0);
      // 设计冻结话术：「qwen 本地引擎已 deprecated，权重需重下 ~108GB，推荐 h3 引擎」
      expect(/deprecated/i.test(r.stderr)).toBe(true);
      expect(r.stderr.includes('h3')).toBe(true);
      // mock 影响面总表：qwen 路径随后走 h3 mock 出图管道
      expect(fs.existsSync(out)).toBe(true);
      expect(pngMagicOk(out)).toBe(true);
    } finally {
      fx.dispose();
    }
  });

  it('场景6.P3 [det-machine] 帮助/枚举中 doubao 与 h3 均出现', { timeout: 60_000 }, async () => {
    const fx = makeFixture('h3-s6p3-');
    stubRuntime(fx.runtime, 'new');
    try {
      const r = await runH3Cli(['image', 'gen', '--help'], { env: fx.env() });
      expect(r.code).toBe(0);
      expect(r.all.includes('doubao')).toBe(true);
      expect(r.all.includes('h3')).toBe(true);
    } finally {
      fx.dispose();
    }
  });

  it('场景6.P4 [det-machine] 帮助中 qwen 标弃用、h3 标默认本地', { timeout: 60_000 }, async () => {
    const fx = makeFixture('h3-s6p4-');
    stubRuntime(fx.runtime, 'new');
    try {
      const r = await runH3Cli(['image', 'gen', '--help'], { env: fx.env() });
      expect(r.code).toBe(0);
      const lines = r.all.split('\n');
      // qwen 与 deprecated/弃用 同行出现
      expect(lines.some((l) => l.includes('qwen') && /deprecated|弃用/i.test(l))).toBe(true);
      // h3 与 默认/default 同行出现
      expect(lines.some((l) => /h3/.test(l) && /默认|default/i.test(l))).toBe(true);
    } finally {
      fx.dispose();
    }
  });
});

describe('场景 9：参数错误 → exit 2 + stdout 干净', () => {
  it('场景9.P1 [real-process] 主壳 --engine nosuchengine → exit 2、stdout 空、stderr 含引擎枚举', { timeout: 60_000 }, async () => {
    const fx = makeFixture('h3-s9p1-');
    stubRuntime(fx.runtime, 'new');
    try {
      const out = path.join(fx.outDir, 'out.png');
      // --engine 枚举校验是主壳（packages/cli takeFlag）职责，走主壳入口
      const r = await runMainCli(['image', 'gen', '清晨的山谷原野', '--engine', 'nosuchengine', '-o', out]);
      expect(r.code).toBe(2);
      expect(r.stdout.trim()).toBe('');
      expect(r.stderr.includes('h3')).toBe(true);
      expect(r.stderr.includes('doubao')).toBe(true);
      expect(r.stderr.includes('qwen')).toBe(true);
    } finally {
      fx.dispose();
    }
  });

  it('场景9.P2 [real-process] lmedia --quality ultra → exit 2、stderr 列出 draft/publish、stdout 空', { timeout: 60_000 }, async () => {
    const fx = makeFixture('h3-s9p2-');
    stubRuntime(fx.runtime, 'new');
    try {
      const out = path.join(fx.outDir, 'out.png');
      const r = await runH3Cli(
        ['image', 'gen', '清晨的山谷原野', '--engine', 'h3', '--quality', 'ultra', '-o', out],
        { env: fx.env() },
      );
      expect(r.code).toBe(2);
      expect(r.stdout.trim()).toBe('');
      expect(r.stderr.includes('draft')).toBe(true);
      expect(r.stderr.includes('publish')).toBe(true);
    } finally {
      fx.dispose();
    }
  });

  it('场景9.P3 [real-process] edit 缺场景文本 → exit 2、stderr 指明、stdout 空', { timeout: 60_000 }, async () => {
    const fx = makeFixture('h3-s9p3-');
    stubRuntime(fx.runtime, 'new');
    try {
      const r = await runH3Cli(['image', 'edit'], { env: fx.env() });
      expect(r.code).toBe(2);
      expect(r.stdout.trim()).toBe('');
      expect(r.stderr.length).toBeGreaterThan(0);
      expect(/场景|scene|prompt|必填|required|缺少|missing/i.test(r.stderr)).toBe(true);
    } finally {
      fx.dispose();
    }
  });
});

describe('场景 12（gate 闭环）：image disable / enable', () => {
  it('场景12.P6 [real-process] disable 后 gen → exit 1 且话术含 doubao 云端替代提示；enable 后恢复', { timeout: 60_000 }, async () => {
    const fx = makeFixture('h3-s12p6-');
    stubRuntime(fx.runtime, 'new');
    try {
      const out1 = path.join(fx.outDir, 'blocked.png');
      const dis = await runH3Cli(['image', 'disable', '--reason', '红队验收'], { env: fx.env() });
      expect(dis.code).toBe(0);
      const gen = await runH3Cli(
        ['image', 'gen', '清晨的山谷原野', '--engine', 'h3', '--quality', 'draft', '-o', out1],
        { env: fx.env() },
      );
      expect(gen.code).toBe(1);
      // ImageDisabledError 话术含 --engine doubao 云端替代提示
      expect(gen.stderr.includes('doubao')).toBe(true);
      expect(fs.existsSync(out1)).toBe(false);

      const en = await runH3Cli(['image', 'enable'], { env: fx.env() });
      expect(en.code).toBe(0);
      const out2 = path.join(fx.outDir, 'restored.png');
      const gen2 = await runH3Cli(
        ['image', 'gen', '清晨的山谷原野', '--engine', 'h3', '--quality', 'draft', '-o', out2],
        { env: fx.env() },
      );
      expect(gen2.code).toBe(0);
      expect(fs.existsSync(out2)).toBe(true);
      expect(pngMagicOk(out2)).toBe(true);
    } finally {
      fx.dispose();
    }
  });
});
