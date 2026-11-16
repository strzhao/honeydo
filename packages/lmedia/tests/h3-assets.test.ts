/** h3-assets 单测：双轴库生命周期 / 出厂预设解析 / builtin 保护 / 损坏 fail-closed（隔离 tmp 库根） */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  InvalidArgsError,
  KEY_RE,
  ManifestCorruptError,
  addChar,
  addStyle,
  builtinAssetsRoot,
  builtinChars,
  builtinStyles,
  charsLibRoot,
  isBuiltinChar,
  isBuiltinStyle,
  listAssets,
  readManifest,
  removeEntry,
  resolveChar,
  resolveStyle,
  stylesLibRoot,
  verifyAssets,
} from '../src/lib/h3-assets.js';

const PKG = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const ANCHOR = path.join(PKG, 'assets', 'h3-styles', 'picturebook', 'anchor-pga-p0.png');
const REF = path.join(PKG, 'assets', 'h3-chars', 'pipi', 'ref-official.png');

let dir = '';
let stylesRoot = '';
let charsRoot = '';

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'h3-assets-'));
  stylesRoot = path.join(dir, 'styles-lib');
  charsRoot = path.join(dir, 'chars-lib');
  // fixture 图：小 PNG（避免测试依赖出厂大图的存在性）
  for (const [name, w] of [['a.png', 8], ['b.png', 16]] as const) {
    const p = path.join(dir, name);
    // 1x1 PNG 最小字节模板：不同尺寸用不同文件内容即可（sha256 查重依据）
    fs.writeFileSync(p, Buffer.alloc(w * 1024, w));
  }
});

afterAll(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

const fixtureA = () => path.join(dir, 'a.png');
const fixtureB = () => path.join(dir, 'b.png');

describe('用户库生命周期（style 轴）', () => {
  it('add → 清单 +1、资产拷贝进库（不引用原路径）', () => {
    const { item, duplicated } = addStyle(stylesRoot, { key: 'my-style', anchor: fixtureA(), note: '测试风格' });
    expect(duplicated).toBe(false);
    expect(item.kind).toBe('style');
    expect(item.path.startsWith(path.resolve(stylesRoot))).toBe(true);
    expect(item.files.anchor).toBe(item.path);
    expect(fs.existsSync(item.path)).toBe(true);
    const m = readManifest(stylesRoot);
    expect(m.items.length).toBe(1);
    expect(m.version).toBe(1);
  });

  it('同 key 重登记 → 覆写；同内容不同 key → sha256 幂等跳过', () => {
    const again = addStyle(stylesRoot, { key: 'my-style', anchor: fixtureB() });
    expect(again.duplicated).toBe(false);
    expect(readManifest(stylesRoot).items.filter((i) => i.key === 'my-style').length).toBe(1);

    const dup = addStyle(stylesRoot, { key: 'other-style', anchor: fixtureB() });
    expect(dup.duplicated).toBe(true);
    expect(dup.item.key).toBe('my-style'); // 指向已有条目
  });

  it('remove → 记录与库内文件一并移除；不存在 → null', () => {
    expect(removeEntry(stylesRoot, 'style', 'other-style')).toBeNull();
    const removed = removeEntry(stylesRoot, 'style', 'my-style');
    expect(removed?.key).toBe('my-style');
    expect(fs.existsSync(removed!.path)).toBe(false);
    expect(readManifest(stylesRoot).items.length).toBe(0);
  });
});

describe('用户库 style 模板以文件内容参与组装（回归）', () => {
  it('resolveStyle().template = txt 内容（含 {scene} 槽位），而非文件路径', () => {
    // 回归背景：曾把 template.txt 的「路径字符串」当模板下发——路径无槽位，
    // composePrompt 槽位替换全空转，scene 与分工句被整体丢掉（实测 prompt 只剩路径+负向表）
    const tpl = path.join(dir, 'tpl.txt');
    fs.writeFileSync(tpl, 'Picture 1 是角色参考：{char_identity}。\nPicture 2 是画风参考：{style_sentence}。\n{scene}\n{negatives}\n');
    addStyle(stylesRoot, { key: 'tpl-style', anchor: fixtureA(), template: tpl });
    const resolved = resolveStyle('tpl-style', stylesRoot);
    expect(resolved?.template).toContain('{scene}');
    expect(resolved?.template).toContain('{char_identity}');
    expect(resolved?.template).not.toContain('tpl.txt');
    expect(resolved?.template!.startsWith('Picture 1')).toBe(true);
    // 清场：sha256 幂等会让同内容 fixture 影响后续用例的注册
    removeEntry(stylesRoot, 'style', 'tpl-style');
  });
});

describe('用户库生命周期（char 轴，与 style 同语义）', () => {
  it('add/list/remove 全链路', () => {
    addChar(charsRoot, { key: 'my-char', ref: fixtureA(), identity: path.join(dir, 'a.png') });
    const listed = listAssets(charsRoot, 'char').filter((i) => i.source === 'user');
    expect(listed.map((i) => i.key)).toContain('my-char');
    const removed = removeEntry(charsRoot, 'char', 'my-char');
    expect(removed?.key).toBe('my-char');
    expect(listAssets(charsRoot, 'char').filter((i) => i.source === 'user').length).toBe(0);
  });
});

describe('参数校验（exit 2 域）', () => {
  it('非法 key（大写/下划线）→ InvalidArgsError，含 KEY 规则线索', () => {
    expect(() => addStyle(stylesRoot, { key: 'Bad_Key', anchor: fixtureA() })).toThrow(InvalidArgsError);
    expect(() => addStyle(stylesRoot, { key: 'Bad_Key', anchor: fixtureA() })).toThrow(/a-z0-9-/);
    expect(KEY_RE.test('ok-key-123')).toBe(true);
    expect(KEY_RE.test('Bad_Key')).toBe(false);
  });

  it('资产文件不存在 → InvalidArgsError', () => {
    expect(() => addChar(charsRoot, { key: 'x', ref: '/nope/missing.png' })).toThrow(InvalidArgsError);
  });
});

describe('出厂预设（builtin）', () => {
  it('包内 assets 可解析：picturebook + pipi，锚页/角色卡文件在位', () => {
    const styles = builtinStyles();
    const chars = builtinChars();
    expect(styles.map((s) => s.key)).toContain('picturebook');
    expect(chars.map((c) => c.key)).toContain('pipi');
    expect(fs.existsSync(styles.find((s) => s.key === 'picturebook')!.anchor)).toBe(true);
    expect(fs.existsSync(chars.find((c) => c.key === 'pipi')!.ref)).toBe(true);
    expect(styles.find((s) => s.key === 'picturebook')!.styleSentence).toContain('水彩');
    expect(chars.find((c) => c.key === 'pipi')!.identity).toContain('皮皮');
  });

  it('解析优先级：用户库 > 出厂预设', () => {
    addStyle(stylesRoot, { key: 'picturebook', anchor: fixtureA() });
    const resolved = resolveStyle('picturebook', stylesRoot);
    expect(resolved?.source).toBe('user');
    removeEntry(stylesRoot, 'style', 'picturebook');
    expect(resolveStyle('picturebook', stylesRoot)?.source).toBe('builtin');

    addChar(charsRoot, { key: 'pipi', ref: fixtureB() });
    expect(resolveChar('pipi', charsRoot)?.source).toBe('user');
    removeEntry(charsRoot, 'char', 'pipi');
    expect(resolveChar('pipi', charsRoot)?.source).toBe('builtin');
  });

  it('builtin key 判定 + verify 标记 builtin 条目', () => {
    expect(isBuiltinStyle('picturebook')).toBe(true);
    expect(isBuiltinStyle('nope')).toBe(false);
    expect(isBuiltinChar('pipi')).toBe(true);
    const { problems } = verifyAssets(stylesRoot, 'style');
    const builtinProblems = problems.filter((p) => p.source === 'builtin');
    expect(builtinProblems.length).toBe(0); // 出厂资产完整 → 无漂移
  });
});

describe('损坏 fail-closed（不重建）', () => {
  it('index.json 非法 JSON → ManifestCorruptError；解析/入账一律拒绝', () => {
    const corruptRoot = path.join(dir, 'corrupt-lib');
    fs.mkdirSync(corruptRoot, { recursive: true });
    fs.writeFileSync(path.join(corruptRoot, 'index.json'), '{ broken');
    expect(() => readManifest(corruptRoot)).toThrow(ManifestCorruptError);
    expect(() => addChar(corruptRoot, { key: 'x', ref: fixtureA() })).toThrow(ManifestCorruptError);
    expect(fs.readFileSync(path.join(corruptRoot, 'index.json'), 'utf-8')).toBe('{ broken'); // 未被重建
  });

  it('结构不对（缺 items）→ ManifestCorruptError', () => {
    const bad = path.join(dir, 'bad-structure');
    fs.mkdirSync(bad, { recursive: true });
    fs.writeFileSync(path.join(bad, 'index.json'), '{"version":1}');
    expect(() => readManifest(bad)).toThrow(/items/);
  });

  it('缺失清单 = 空清单（不写盘）', () => {
    const fresh = path.join(dir, 'fresh-lib');
    expect(readManifest(fresh).items.length).toBe(0);
    expect(fs.existsSync(path.join(fresh, 'index.json'))).toBe(false);
  });
});

describe('verify 漂移', () => {
  it('用户资产文件被覆盖（内容漂移）→ verify 报 ✗', () => {
    const root = path.join(dir, 'drift-lib');
    const src = path.join(dir, 'drift-src.png');
    fs.writeFileSync(src, 'v1');
    const { item } = addChar(root, { key: 'drift', ref: src });
    fs.writeFileSync(item.path, 'v2-overwritten');
    const { problems } = verifyAssets(root, 'char');
    const p = problems.find((x) => x.key === 'drift' && x.source === 'user');
    expect(p).toBeDefined();
    expect(p!.issues.join(';')).toMatch(/漂移|sha256/);
  });
});

describe('库根 env 默认值', () => {
  it('默认根 ~/.config/limg/h3-styles|chars', () => {
    expect(stylesLibRoot()).toBe(path.join(os.homedir(), '.config', 'limg', 'h3-styles'));
    expect(charsLibRoot()).toBe(path.join(os.homedir(), '.config', 'limg', 'h3-chars'));
    expect(fs.existsSync(builtinAssetsRoot())).toBe(true);
  });
});

/** spawn 冒烟：fixture PNG 确实是可拷贝文件（防 beforeAll 静默失败） */
describe('fixture 自检', () => {
  it('fixture 文件在位', () => {
    for (const f of [fixtureA(), fixtureB()]) {
      expect(fs.existsSync(f)).toBe(true);
      expect(fs.statSync(f).size).toBeGreaterThan(0);
    }
  });
});
