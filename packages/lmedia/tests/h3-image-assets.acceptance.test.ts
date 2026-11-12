/**
 * 红队验收测试 · 场景 3 / 场景12.P1-P2（风格/角色双轴资产库生命周期 + 出厂预设 + 损坏语义）。
 *
 * 场景 3：资产库生命周期 + 出厂预设        → P1 P2 P3 P4 P5 P6 P7
 * 场景12.P1：用户库 index.json 写坏 → exit 1 报损坏且绝不重建（二次运行仍报损坏）
 * 场景12.P2：非法 key add → exit 2 且 stderr 含 KEY 规则线索
 *
 * 黑盒铁律：只 spawn 真实 CLI + 文件系统观测，绝不 import 实现模块、绝不手改 index.json 造假资产
 * （5.P5 fixture 约定同源：非默认资产一律经 CLI add 注入隔离库）。
 * 资产库隔离：H3_STYLES_LIB / H3_CHARS_LIB → 临时目录（LMEDIA_SFX_LIB 同款「库根」语义）。
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  findIndexPath,
  makeFixture,
  readJson,
  runH3Cli,
  writeMinimalPng,
  PROJECT_ROOT,
} from './helpers/h3-utils';

const STYLE_KEY = 'mypage';
const CHAR_KEY = 'testchar';

describe('场景 3：风格/角色资产库生命周期 + 出厂预设', () => {
  it('场景3.P1 [real-process] style add 合法资产 → exit 0，list 包含该资产', { timeout: 60_000 }, async () => {
    const fx = makeFixture('h3-s3p1-');
    try {
      const anchor = writeMinimalPng(path.join(fx.workDir, 'anchor.png'));
      const add = await runH3Cli(['image', 'style', 'add', STYLE_KEY, '--anchor', anchor], { env: fx.env() });
      expect(add.code).toBe(0);
      const list = await runH3Cli(['image', 'style', 'list'], { env: fx.env() });
      expect(list.code).toBe(0);
      expect(list.stdout.includes(STYLE_KEY)).toBe(true);
    } finally {
      fx.dispose();
    }
  });

  it('场景3.P2 [real-process] verify 在库资产 → exit 0', { timeout: 60_000 }, async () => {
    const fx = makeFixture('h3-s3p2-');
    try {
      const anchor = writeMinimalPng(path.join(fx.workDir, 'anchor.png'));
      const add = await runH3Cli(['image', 'style', 'add', STYLE_KEY, '--anchor', anchor], { env: fx.env() });
      expect(add.code).toBe(0);
      const verify = await runH3Cli(['image', 'style', 'verify', STYLE_KEY], { env: fx.env() });
      expect(verify.code).toBe(0);
    } finally {
      fx.dispose();
    }
  });

  it('场景3.P3 [det-machine] remove 后 list 不再包含', { timeout: 60_000 }, async () => {
    const fx = makeFixture('h3-s3p3-');
    try {
      const anchor = writeMinimalPng(path.join(fx.workDir, 'anchor.png'));
      const add = await runH3Cli(['image', 'style', 'add', STYLE_KEY, '--anchor', anchor], { env: fx.env() });
      expect(add.code).toBe(0);
      const rm = await runH3Cli(['image', 'style', 'remove', STYLE_KEY], { env: fx.env() });
      expect(rm.code).toBe(0);
      const list = await runH3Cli(['image', 'style', 'list'], { env: fx.env() });
      expect(list.code).toBe(0);
      expect(list.stdout.includes(STYLE_KEY)).toBe(false);
    } finally {
      fx.dispose();
    }
  });

  it('场景3.P4 [real-process] verify/remove 不存在资产 → 非零退出且 stderr 指名', { timeout: 60_000 }, async () => {
    const fx = makeFixture('h3-s3p4-');
    try {
      const v = await runH3Cli(['image', 'style', 'verify', 'ghost-style'], { env: fx.env() });
      expect(v.code).not.toBe(0);
      expect(v.stderr.includes('ghost-style')).toBe(true);
      const rm = await runH3Cli(['image', 'style', 'remove', 'ghost-style'], { env: fx.env() });
      expect(rm.code).not.toBe(0);
      expect(rm.stderr.includes('ghost-style')).toBe(true);
    } finally {
      fx.dispose();
    }
  });

  it('场景3.P5 [det-machine] 出厂预设文件随包存在（picturebook 锚页/模板 + pipi 角色卡）', { timeout: 60_000 }, async () => {
    // driver: fs 扫描包 assets（出厂预设以包内 assets 解析，repo 与发布布局一致）
    const styleDir = path.join(PROJECT_ROOT, 'assets', 'h3-styles', 'picturebook');
    const charDir = path.join(PROJECT_ROOT, 'assets', 'h3-chars', 'pipi');
    expect(fs.existsSync(styleDir)).toBe(true);
    expect(fs.existsSync(charDir)).toBe(true);
    const styleFiles = fs.readdirSync(styleDir);
    const charFiles = fs.readdirSync(charDir);
    // 模板/负向表与角色卡元数据
    expect(styleFiles.includes('style.json')).toBe(true);
    expect(charFiles.includes('char.json')).toBe(true);
    // 锚页/角色卡图像在位（至少一个非 json 资产文件）
    const isImage = (f: string): boolean => /\.(png|jpe?g|webp)$/i.test(f);
    expect(styleFiles.some(isImage)).toBe(true);
    expect(charFiles.some(isImage)).toBe(true);
    // 元数据可解析（存在且合法 JSON）
    expect(() => readJson(path.join(styleDir, 'style.json'))).not.toThrow();
    expect(() => readJson(path.join(charDir, 'char.json'))).not.toThrow();
  });

  it('场景3.P6 [real-process] 出厂 key remove → exit 2 且 stderr 报 builtin 不可删', { timeout: 60_000 }, async () => {
    const fx = makeFixture('h3-s3p6-');
    try {
      const r = await runH3Cli(['image', 'style', 'remove', 'picturebook'], { env: fx.env() });
      expect(r.code).toBe(2);
      expect(r.stderr.includes('builtin')).toBe(true);
      expect(r.stderr.includes('不可删')).toBe(true);
    } finally {
      fx.dispose();
    }
  });

  it('场景3.P7 [real-process] char 轴同生命周期：add→list 含→verify 0→remove 后不含，exit 语义与 style 轴一致', { timeout: 60_000 }, async () => {
    const fx = makeFixture('h3-s3p7-');
    try {
      const ref = writeMinimalPng(path.join(fx.workDir, 'charcard.png'));
      const add = await runH3Cli(['image', 'char', 'add', CHAR_KEY, '--ref', ref], { env: fx.env() });
      expect(add.code).toBe(0);
      const list1 = await runH3Cli(['image', 'char', 'list'], { env: fx.env() });
      expect(list1.code).toBe(0);
      expect(list1.stdout.includes(CHAR_KEY)).toBe(true);
      const verify = await runH3Cli(['image', 'char', 'verify', CHAR_KEY], { env: fx.env() });
      expect(verify.code).toBe(0);
      const rm = await runH3Cli(['image', 'char', 'remove', CHAR_KEY], { env: fx.env() });
      expect(rm.code).toBe(0);
      const list2 = await runH3Cli(['image', 'char', 'list'], { env: fx.env() });
      expect(list2.code).toBe(0);
      expect(list2.stdout.includes(CHAR_KEY)).toBe(false);
    } finally {
      fx.dispose();
    }
  });
});

describe('场景 12（资产库契约闭集）', () => {
  it('场景12.P1 [real-process] index.json 写坏 → 依赖库命令 exit 1 报损坏且不重建（二次运行仍报损坏）', { timeout: 60_000 }, async () => {
    const fx = makeFixture('h3-s12p1-');
    try {
      // 经 CLI add 注入（绝不手改 index.json 造库），随后才实施「写坏」这一步破坏注入
      const anchor = writeMinimalPng(path.join(fx.workDir, 'anchor.png'));
      const add = await runH3Cli(['image', 'style', 'add', STYLE_KEY, '--anchor', anchor], { env: fx.env() });
      expect(add.code).toBe(0);
      const indexPath = findIndexPath(fx.stylesLib);
      const corrupt = '{ broken json';
      fs.writeFileSync(indexPath, corrupt);
      const before = fs.readFileSync(indexPath, 'utf-8');

      const list1 = await runH3Cli(['image', 'style', 'list'], { env: fx.env() });
      expect(list1.code).toBe(1);
      expect(/ManifestCorrupt|损坏|corrupt/i.test(list1.all)).toBe(true);
      // 绝不重建：坏文件字节原样保留
      expect(fs.readFileSync(indexPath, 'utf-8')).toBe(before);
      // 二次运行仍报损坏（fail-closed 持续，而非首次报错后偷偷重建）
      const list2 = await runH3Cli(['image', 'style', 'list'], { env: fx.env() });
      expect(list2.code).toBe(1);
      expect(/ManifestCorrupt|损坏|corrupt/i.test(list2.all)).toBe(true);
      expect(fs.readFileSync(indexPath, 'utf-8')).toBe(before);
    } finally {
      fx.dispose();
    }
  });

  it('场景12.P2 [real-process] style add 非法 key（Bad_Key）→ exit 2 且 stderr 含 KEY 规则线索', { timeout: 60_000 }, async () => {
    const fx = makeFixture('h3-s12p2-');
    try {
      const anchor = writeMinimalPng(path.join(fx.workDir, 'anchor.png'));
      const r = await runH3Cli(['image', 'style', 'add', 'Bad_Key', '--anchor', anchor], { env: fx.env() });
      expect(r.code).toBe(2);
      expect(r.stderr.toLowerCase().includes('key')).toBe(true);
      // KEY_RE = ^[a-z0-9-]+$ 的规则线索（正则原文 / 小写字母提示 / lowercase 任一形态）
      expect(/a-z0-9|小写|lowercase/i.test(r.stderr)).toBe(true);
    } finally {
      fx.dispose();
    }
  });
});
