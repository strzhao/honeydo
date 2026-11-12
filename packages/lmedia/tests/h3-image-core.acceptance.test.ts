/**
 * 红队验收测试 · 场景 1 / 2 / 7（h3 引擎核心出图路径）。
 *
 * 场景 1：一条命令出产线级图（edit + 出厂风格/角色）        → P1-P5
 * 场景 2：gen 路径 + --json 元数据契约                      → P1-P3
 * 场景 7：quality 双档 + 双轴独立性                         → P1-P4
 *
 * 黑盒铁律：只 spawn 真实 CLI + 文件系统/文件头字节观测，绝不 import 实现模块。
 * 全部用例 mock 驱动：LMEDIA_IMAGE_MOCK=1 + 桩 H3_RUNTIME + 隔离资产库/gate/锁。
 * gate 前提：LMEDIA_IMAGE_STATE 指向不存在的新文件 = 默认启用（仓内既有语义）。
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  expectSingleLine,
  lastJsonLine,
  makeFixture,
  pngDims,
  pngMagicOk,
  runH3Cli,
  sameRealFile,
  stubRuntime,
} from './helpers/h3-utils';

const EDIT_SCENE = '傍晚的绘本小镇街头，皮皮背着书包跑向校车';

describe('场景 1：一条命令出产线级图（edit + 出厂风格/角色）', () => {
  it('场景1.P1 [real-process] mock edit → exit 0 且产出合法 PNG（头 8 字节）', { timeout: 60_000 }, async () => {
    const fx = makeFixture('h3-s1p1-');
    stubRuntime(fx.runtime, 'new');
    try {
      const out = path.join(fx.outDir, 'page.png');
      const r = await runH3Cli(
        ['image', 'edit', EDIT_SCENE, '--style', 'picturebook', '--char', 'pipi', '-o', out],
        { env: fx.env() },
      );
      expect(r.code).toBe(0);
      expect(fs.existsSync(out)).toBe(true);
      expect(pngMagicOk(out)).toBe(true);
    } finally {
      fx.dispose();
    }
  });

  it('场景1.P2 [det-machine] stdout 恰好一行且含最终 PNG 路径', { timeout: 60_000 }, async () => {
    const fx = makeFixture('h3-s1p2-');
    stubRuntime(fx.runtime, 'new');
    try {
      const out = path.join(fx.outDir, 'page.png');
      const r = await runH3Cli(
        ['image', 'edit', EDIT_SCENE, '--style', 'picturebook', '--char', 'pipi', '-o', out],
        { env: fx.env() },
      );
      expect(r.code).toBe(0);
      const line = expectSingleLine(r.stdout);
      // 行内含该 PNG 路径（实现可能回显 realpath，用真实路径等价吸收 /tmp 符号链接差异）
      expect(line.includes(out) || sameRealFile(line, out)).toBe(true);
      expect(fs.existsSync(out)).toBe(true);
    } finally {
      fx.dispose();
    }
  });

  it('场景1.P3 [det-machine] stderr 按序出现 [h3:encode] 与 [h3:denoise]', { timeout: 60_000 }, async () => {
    const fx = makeFixture('h3-s1p3-');
    stubRuntime(fx.runtime, 'new');
    try {
      const out = path.join(fx.outDir, 'page.png');
      const r = await runH3Cli(
        ['image', 'edit', EDIT_SCENE, '--style', 'picturebook', '--char', 'pipi', '-o', out],
        { env: fx.env() },
      );
      expect(r.code).toBe(0);
      const iEnc = r.stderr.indexOf('[h3:encode]');
      const iDen = r.stderr.indexOf('[h3:denoise]');
      expect(iEnc).toBeGreaterThanOrEqual(0);
      expect(iDen).toBeGreaterThanOrEqual(0);
      expect(iEnc).toBeLessThan(iDen);
    } finally {
      fx.dispose();
    }
  });

  it('场景1.P4 [det-machine] 干净环境（用户库空）出厂预设直接解析：style=picturebook char=pipi', { timeout: 60_000 }, async () => {
    const fx = makeFixture('h3-s1p4-');
    stubRuntime(fx.runtime, 'new');
    try {
      const out = path.join(fx.outDir, 'page.png');
      // fixture 的资产库 = 全新空目录（无 index.json）→ 出厂预设必须独立可用
      const r = await runH3Cli(
        ['image', 'edit', EDIT_SCENE, '--style', 'picturebook', '--char', 'pipi', '-o', out, '--json'],
        { env: fx.env() },
      );
      expect(r.code).toBe(0);
      const meta = lastJsonLine(r.stdout);
      expect(meta['style']).toBe('picturebook');
      expect(meta['char']).toBe('pipi');
    } finally {
      fx.dispose();
    }
  });

  it('场景1.P5 [real-process] mock 模式墙钟 <180s', { timeout: 60_000 }, async () => {
    const fx = makeFixture('h3-s1p5-');
    stubRuntime(fx.runtime, 'new');
    try {
      const out = path.join(fx.outDir, 'page.png');
      const t0 = Date.now();
      const r = await runH3Cli(
        ['image', 'edit', EDIT_SCENE, '--style', 'picturebook', '--char', 'pipi', '-o', out],
        { env: fx.env() },
      );
      const elapsed = Date.now() - t0;
      expect(r.code).toBe(0);
      expect(elapsed).toBeLessThan(180_000);
    } finally {
      fx.dispose();
    }
  });
});

describe('场景 2：gen 路径 + --json 元数据契约', () => {
  it('场景2.P1 [real-process] gen --engine h3 --quality draft（mock）exit 0 且合法 PNG', { timeout: 60_000 }, async () => {
    const fx = makeFixture('h3-s2p1-');
    stubRuntime(fx.runtime, 'new');
    try {
      const out = path.join(fx.outDir, 'out.png');
      const r = await runH3Cli(
        ['image', 'gen', '清晨的山谷原野', '--engine', 'h3', '--quality', 'draft', '-o', out],
        { env: fx.env() },
      );
      expect(r.code).toBe(0);
      expect(fs.existsSync(out)).toBe(true);
      expect(pngMagicOk(out)).toBe(true);
    } finally {
      fx.dispose();
    }
  });

  it('场景2.P2 [det-machine] --json 可解析：engine=h3、quality=draft、output 正确、seed/elapsed_s 数值', { timeout: 60_000 }, async () => {
    const fx = makeFixture('h3-s2p2-');
    stubRuntime(fx.runtime, 'new');
    try {
      const out = path.join(fx.outDir, 'out.png');
      const r = await runH3Cli(
        ['image', 'gen', '清晨的山谷原野', '--engine', 'h3', '--quality', 'draft', '-o', out, '--json'],
        { env: fx.env() },
      );
      expect(r.code).toBe(0);
      const meta = lastJsonLine(r.stdout);
      expect(meta['engine']).toBe('h3');
      expect(meta['quality']).toBe('draft');
      const output = meta['output'];
      expect(typeof output).toBe('string');
      // output 正确 = 指向 -o 落盘的那个 PNG（真实路径等价比较）
      expect(fs.existsSync(output as string)).toBe(true);
      expect(sameRealFile(output as string, out)).toBe(true);
      expect(typeof meta['seed']).toBe('number');
      expect(typeof meta['elapsed_s']).toBe('number');
    } finally {
      fx.dispose();
    }
  });

  it('场景2.P3 [det-machine] --json 模式 stdout 保持机器可解析（进度不混入）', { timeout: 60_000 }, async () => {
    const fx = makeFixture('h3-s2p3-');
    stubRuntime(fx.runtime, 'new');
    try {
      const out = path.join(fx.outDir, 'out.png');
      const r = await runH3Cli(
        ['image', 'gen', '清晨的山谷原野', '--engine', 'h3', '--quality', 'draft', '-o', out, '--json'],
        { env: fx.env() },
      );
      expect(r.code).toBe(0);
      // 恰好一行且整行可 JSON.parse（进度/阶段标记必须走 stderr）
      const line = expectSingleLine(r.stdout);
      expect(() => JSON.parse(line)).not.toThrow();
    } finally {
      fx.dispose();
    }
  });
});

describe('场景 7：quality 双档 + 双轴独立性', () => {
  it('场景7.P1 [real-process] --quality publish：exit 0、quality=publish、resolution=2736x1536、<180s', { timeout: 60_000 }, async () => {
    const fx = makeFixture('h3-s7p1-');
    stubRuntime(fx.runtime, 'new');
    try {
      const out = path.join(fx.outDir, 'pub.png');
      const t0 = Date.now();
      const r = await runH3Cli(
        ['image', 'gen', '雪夜灯火的小巷', '--engine', 'h3', '--quality', 'publish', '-o', out, '--json'],
        { env: fx.env() },
      );
      const elapsed = Date.now() - t0;
      expect(r.code).toBe(0);
      expect(elapsed).toBeLessThan(180_000);
      const meta = lastJsonLine(r.stdout);
      expect(meta['quality']).toBe('publish');
      expect(meta['resolution']).toBe('2736x1536');
      // mock PNG 名义尺寸 = 档位最终名义尺寸（publish 缩回后 2736x1536）——用 IHDR 字节独立核验
      const dims = pngDims(out);
      expect(dims.width).toBe(2736);
      expect(dims.height).toBe(1536);
    } finally {
      fx.dispose();
    }
  });

  it('场景7.P2 [det-machine] --quality draft：quality=draft、resolution=2048x1152', { timeout: 60_000 }, async () => {
    const fx = makeFixture('h3-s7p2-');
    stubRuntime(fx.runtime, 'new');
    try {
      const out = path.join(fx.outDir, 'draft.png');
      const r = await runH3Cli(
        ['image', 'gen', '雪夜灯火的小巷', '--engine', 'h3', '--quality', 'draft', '-o', out, '--json'],
        { env: fx.env() },
      );
      expect(r.code).toBe(0);
      const meta = lastJsonLine(r.stdout);
      expect(meta['quality']).toBe('draft');
      expect(meta['resolution']).toBe('2048x1152');
      const dims = pngDims(out);
      expect(dims.width).toBe(2048);
      expect(dims.height).toBe(1152);
    } finally {
      fx.dispose();
    }
  });

  it('场景7.P3 [real-process] 仅 --style 无 --char：exit 0 且 char 字段空', { timeout: 60_000 }, async () => {
    const fx = makeFixture('h3-s7p3-');
    stubRuntime(fx.runtime, 'new');
    try {
      const out = path.join(fx.outDir, 'only-style.png');
      const r = await runH3Cli(
        ['image', 'edit', EDIT_SCENE, '--style', 'picturebook', '-o', out, '--json'],
        { env: fx.env() },
      );
      expect(r.code).toBe(0);
      const meta = lastJsonLine(r.stdout);
      expect(meta['style']).toBe('picturebook');
      // CONTRACT_AMBIGUOUS: 谓词只说「char 字段空」，空档表示法（''/null）未冻结——两者都算空，其余都算违约
      const charEmpty = meta['char'] === '' || meta['char'] === null || meta['char'] === undefined;
      expect(charEmpty).toBe(true);
    } finally {
      fx.dispose();
    }
  });

  it('场景7.P4 [real-process] 仅 --char 无 --style：exit 0 且 style 字段空', { timeout: 60_000 }, async () => {
    const fx = makeFixture('h3-s7p4-');
    stubRuntime(fx.runtime, 'new');
    try {
      const out = path.join(fx.outDir, 'only-char.png');
      const r = await runH3Cli(
        ['image', 'edit', EDIT_SCENE, '--char', 'pipi', '-o', out, '--json'],
        { env: fx.env() },
      );
      expect(r.code).toBe(0);
      const meta = lastJsonLine(r.stdout);
      expect(meta['char']).toBe('pipi');
      // CONTRACT_AMBIGUOUS: 同 7.P3，style 空档表示法未冻结
      const styleEmpty = meta['style'] === '' || meta['style'] === null || meta['style'] === undefined;
      expect(styleEmpty).toBe(true);
    } finally {
      fx.dispose();
    }
  });
});
