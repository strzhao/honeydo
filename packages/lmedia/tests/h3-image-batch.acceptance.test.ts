/**
 * 红队验收测试 · 场景 5 / 11 / 场景12.P3-P4（batch 全链路 + 单项失败审计 + 清单损坏语义）。
 *
 * 场景 5：batch 全成功 + report.json            → P1-P5
 * 场景 11：batch 单项运行时失败审计（@fail seam）→ P1-P4
 * 场景12.P3：清单文件级损坏（空文件）→ exit 1 ManifestCorruptError
 * 场景12.P4：清单条目字段非法（size="abc"）→ exit 2 且 stderr 指明条目与字段
 *
 * 清单契约（冻结）：JSON 数组 [{scene, out, style?, char?, seed?, size?}]；
 * report.json = {generatedAt, items:[{scene, out, status:'ok'|'failed', reason?, style?, char?, elapsed_s}]}；
 * 默认 stdout 恰好一行 = report.json 绝对路径。
 * 黑盒铁律：只 spawn 真实 CLI + report.json/文件头字节观测，绝不 import 实现模块。
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  expectSingleLine,
  makeFixture,
  pngDims,
  pngMagicOk,
  readJson,
  runH3Cli,
  stubRuntime,
  writeMinimalPng,
} from './helpers/h3-utils';

interface ReportItem {
  scene?: unknown;
  out?: unknown;
  status?: unknown;
  reason?: unknown;
  style?: unknown;
  char?: unknown;
  elapsed_s?: unknown;
}
interface BatchReport {
  generatedAt?: unknown;
  items?: ReportItem[];
}

async function runBatch(fx: ReturnType<typeof makeFixture>, manifest: unknown, name: string) {
  const manifestPath = path.join(fx.workDir, name);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return runH3Cli(['image', 'batch', '-m', manifestPath], { env: fx.env() });
}

describe('场景 5：batch 全成功 + report.json', () => {
  it('场景5.P1 [real-process] 3 条目合法清单 → exit 0 且 report.json items==3', { timeout: 60_000 }, async () => {
    const fx = makeFixture('h3-s5p1-');
    stubRuntime(fx.runtime, 'new');
    try {
      const manifest = [1, 2, 3].map((i) => ({
        scene: `绘本场景 ${i}：小桥流水`,
        out: path.join(fx.outDir, `page-${i}.png`),
        // 第 3 条显式给 size（契约值域 "WxH"，两侧均为正整数）——正向断言在 5.P3
        ...(i === 3 ? { size: '2048x1152' } : {}),
      }));
      const t0 = Date.now();
      const r = await runBatch(fx, manifest, 'manifest.json');
      const elapsed = Date.now() - t0;
      expect(r.code).toBe(0);
      // 默认 stdout 恰好一行 = report.json 绝对路径
      const line = expectSingleLine(r.stdout);
      expect(fs.existsSync(line)).toBe(true);
      const report = readJson<BatchReport>(line);
      expect(Array.isArray(report.items)).toBe(true);
      expect(report.items?.length).toBe(3);
      expect(elapsed).toBeLessThan(180_000); // 场景5.P4 一并求值：batch 总墙钟
    } finally {
      fx.dispose();
    }
  });

  it('场景5.P2 [det-machine] report 每条 status==ok 且输出路径非空', { timeout: 60_000 }, async () => {
    const fx = makeFixture('h3-s5p2-');
    stubRuntime(fx.runtime, 'new');
    try {
      const manifest = [1, 2, 3].map((i) => ({
        scene: `绘本场景 ${i}：小桥流水`,
        out: path.join(fx.outDir, `page-${i}.png`),
      }));
      const r = await runBatch(fx, manifest, 'manifest.json');
      expect(r.code).toBe(0);
      const report = readJson<BatchReport>(expectSingleLine(r.stdout));
      for (const item of report.items ?? []) {
        expect(item.status).toBe('ok');
        expect(typeof item.out).toBe('string');
        expect((item.out as string).length).toBeGreaterThan(0);
      }
    } finally {
      fx.dispose();
    }
  });

  it('场景5.P3 [det-machine] 3 个输出文件均存在且合法 PNG；显式 size 条目 IHDR==2048x1152', { timeout: 60_000 }, async () => {
    const fx = makeFixture('h3-s5p3-');
    stubRuntime(fx.runtime, 'new');
    try {
      const manifest = [1, 2, 3].map((i) => ({
        scene: `绘本场景 ${i}：小桥流水`,
        out: path.join(fx.outDir, `page-${i}.png`),
        ...(i === 3 ? { size: '2048x1152' } : {}),
      }));
      const r = await runBatch(fx, manifest, 'manifest.json');
      expect(r.code).toBe(0);
      const report = readJson<BatchReport>(expectSingleLine(r.stdout));
      const items = report.items ?? [];
      expect(items.length).toBe(3);
      for (const item of items) {
        const out = item.out as string;
        expect(fs.existsSync(out)).toBe(true);
        expect(pngMagicOk(out)).toBe(true);
      }
      // 清单 size 显式值 → 产物名义尺寸按该值直出（draft 档 2048x1152）
      const sized = pngDims(manifest[2].out as string);
      expect(sized.width).toBe(2048);
      expect(sized.height).toBe(1152);
    } finally {
      fx.dispose();
    }
  });

  it('场景5.P4 [det-machine] mock 模式 batch 总墙钟 <180s', { timeout: 60_000 }, async () => {
    const fx = makeFixture('h3-s5p4-');
    stubRuntime(fx.runtime, 'new');
    try {
      const manifest = [1, 2, 3].map((i) => ({
        scene: `绘本场景 ${i}：小桥流水`,
        out: path.join(fx.outDir, `page-${i}.png`),
      }));
      const t0 = Date.now();
      const r = await runBatch(fx, manifest, 'manifest.json');
      const elapsed = Date.now() - t0;
      expect(r.code).toBe(0);
      expect(elapsed).toBeLessThan(180_000);
    } finally {
      fx.dispose();
    }
  });

  it('场景5.P5 [det-machine] 清单 per-item style/char 覆盖生效：report 回显记录指定 key', { timeout: 60_000 }, async () => {
    const fx = makeFixture('h3-s5p5-');
    stubRuntime(fx.runtime, 'new');
    try {
      // 非默认资产经 CLI add 注入隔离库（fixture 约定：绝不手改 index.json）
      const anchor = writeMinimalPng(path.join(fx.workDir, 'anchor.png'));
      const charcard = writeMinimalPng(path.join(fx.workDir, 'charcard.png'));
      expect((await runH3Cli(['image', 'style', 'add', 'mystyle', '--anchor', anchor], { env: fx.env() })).code).toBe(0);
      expect((await runH3Cli(['image', 'char', 'add', 'mychar', '--ref', charcard], { env: fx.env() })).code).toBe(0);

      const manifest = [
        { scene: '自定义双轴条目：海边灯塔', out: path.join(fx.outDir, 'custom.png'), style: 'mystyle', char: 'mychar' },
        { scene: '默认条目：林间小屋', out: path.join(fx.outDir, 'default.png') },
      ];
      const r = await runBatch(fx, manifest, 'manifest.json');
      expect(r.code).toBe(0);
      const report = readJson<BatchReport>(expectSingleLine(r.stdout));
      const custom = (report.items ?? []).find((it) => typeof it.scene === 'string' && (it.scene as string).includes('海边灯塔'));
      expect(custom).toBeDefined();
      expect(custom?.style).toBe('mystyle');
      expect(custom?.char).toBe('mychar');
    } finally {
      fx.dispose();
    }
  });
});

describe('场景 11：batch 单项运行时失败审计（mock @fail 注入 seam）', () => {
  /** 混合清单：2 条合法 + 1 条 scene 以 @fail 开头 */
  async function runMixed(fx: ReturnType<typeof makeFixture>) {
    return runBatch(
      fx,
      [
        { scene: '正常条目一：晨雾森林', out: path.join(fx.outDir, 'ok-1.png') },
        { scene: '@fail 故意失败的条目', out: path.join(fx.outDir, 'boom.png') },
        { scene: '正常条目二：星空湖面', out: path.join(fx.outDir, 'ok-2.png') },
      ],
      'manifest-fail.json',
    );
  }

  it('场景11.P1 [real-process] 混合清单（2 合法 + 1 @fail）整体 exit 1', { timeout: 60_000 }, async () => {
    const fx = makeFixture('h3-s11p1-');
    stubRuntime(fx.runtime, 'new');
    try {
      const r = await runMixed(fx);
      expect(r.code).toBe(1);
    } finally {
      fx.dispose();
    }
  });

  it('场景11.P2 [det-machine] report 中 @fail 条目 status==failed 且 reason 非空', { timeout: 60_000 }, async () => {
    const fx = makeFixture('h3-s11p2-');
    stubRuntime(fx.runtime, 'new');
    try {
      const r = await runMixed(fx);
      expect(r.code).toBe(1);
      const report = readJson<BatchReport>(expectSingleLine(r.stdout));
      const failed = (report.items ?? []).filter((it) => it.status === 'failed');
      expect(failed.length).toBe(1);
      expect(typeof failed[0].reason).toBe('string');
      expect((failed[0].reason as string).trim().length).toBeGreaterThan(0);
    } finally {
      fx.dispose();
    }
  });

  it('场景11.P3 [det-machine] 2 个合法条目照常产出合法 PNG', { timeout: 60_000 }, async () => {
    const fx = makeFixture('h3-s11p3-');
    stubRuntime(fx.runtime, 'new');
    try {
      const r = await runMixed(fx);
      expect(r.code).toBe(1);
      const report = readJson<BatchReport>(expectSingleLine(r.stdout));
      const okItems = (report.items ?? []).filter((it) => it.status === 'ok');
      expect(okItems.length).toBe(2);
      for (const item of okItems) {
        const out = item.out as string;
        expect(fs.existsSync(out)).toBe(true);
        expect(pngMagicOk(out)).toBe(true);
      }
    } finally {
      fx.dispose();
    }
  });

  it('场景11.P4 [det-machine] 失败条目无输出文件', { timeout: 60_000 }, async () => {
    const fx = makeFixture('h3-s11p4-');
    stubRuntime(fx.runtime, 'new');
    try {
      const boomOut = path.join(fx.outDir, 'boom.png');
      const r = await runMixed(fx);
      expect(r.code).toBe(1);
      // 以清单声明的 -o 路径为准核验（不依赖 report 对失败条目的回显）
      expect(fs.existsSync(boomOut)).toBe(false);
    } finally {
      fx.dispose();
    }
  });
});

describe('场景 12（batch 清单契约闭集）', () => {
  it('场景12.P3 [det-machine] 清单文件级损坏（空文件）→ exit 1（ManifestCorruptError）', { timeout: 60_000 }, async () => {
    const fx = makeFixture('h3-s12p3-');
    stubRuntime(fx.runtime, 'new');
    try {
      const manifestPath = path.join(fx.workDir, 'empty.json');
      fs.writeFileSync(manifestPath, '');
      const r = await runH3Cli(['image', 'batch', '-m', manifestPath], { env: fx.env() });
      expect(r.code).toBe(1);
      expect(/ManifestCorrupt|损坏|corrupt/i.test(r.all)).toBe(true);
    } finally {
      fx.dispose();
    }
  });

  it('场景12.P4 [real-process] 清单条目字段非法（size="abc"）→ exit 2 且 stderr 指明条目与字段', { timeout: 60_000 }, async () => {
    const fx = makeFixture('h3-s12p4-');
    stubRuntime(fx.runtime, 'new');
    try {
      const manifest = [
        { scene: '正常条目：风车镇', out: path.join(fx.outDir, 'ok.png') },
        { scene: 'badsize-item：坏尺寸条目', out: path.join(fx.outDir, 'bad.png'), size: 'abc' },
      ];
      const r = await runBatch(fx, manifest, 'manifest-badsize.json');
      expect(r.code).toBe(2);
      // 字段名指名
      expect(r.stderr.includes('size')).toBe(true);
      // 条目指名（条目序号/条目字样/条目 scene 任一形态）
      expect(/条目|item|entry|index|line|行|badsize-item/i.test(r.stderr)).toBe(true);
    } finally {
      fx.dispose();
    }
  });
});
