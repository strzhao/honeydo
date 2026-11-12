/**
 * H3 风格/角色双轴 SSOT 资产库（照搬 sfx-library 结构与损坏语义）。
 *
 * - 用户库：~/.config/limg/h3-styles/index.json 与 h3-chars/index.json（H3_STYLES_LIB / H3_CHARS_LIB env 覆盖，测试隔离）
 * - 出厂预设：包内 assets/h3-styles/<key>/style.json + assets/h3-chars/<key>/char.json
 *   （import.meta.url 相对定位，repo 与发布 tarball 布局一致）
 * - 清单结构：{version:1, generatedAt, items:[{key, kind, path, files, created_at, note}]}
 * - 损坏 → ManifestCorruptError，绝不重建（防丢账，同 sfx-library）；写操作 tmp+rename 原子
 * - 入库：资产文件拷贝进库（不引用原路径），sha256 查重幂等；key 同 sfx KEY_RE
 * - 解析优先级：用户库 > 出厂预设
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export type H3AssetKind = 'style' | 'char';

/** style 轴文件角色 → char 轴文件角色 */
export const STYLE_FILE_ROLES = ['anchor', 'template'] as const;
export const CHAR_FILE_ROLES = ['ref', 'identity'] as const;

export interface H3AssetItem {
  key: string;
  kind: H3AssetKind;
  /** 主资产绝对路径（style=anchor，char=ref） */
  path: string;
  /** 全部资产文件：角色名 → 库内绝对路径 */
  files: Record<string, string>;
  /** 主资产 sha256（查重幂等） */
  content_hash: string;
  created_at: string;
  note: string;
}

export interface H3AssetManifest {
  version: 1;
  generatedAt: string;
  items: H3AssetItem[];
}

export interface BuiltinStyle {
  key: string;
  kind: 'style';
  dir: string;
  anchor: string;
  styleSentence: string;
  negatives?: string;
  template?: string;
  note: string;
}

export interface BuiltinChar {
  key: string;
  kind: 'char';
  dir: string;
  ref: string;
  identity: string;
  note: string;
}

export type BuiltinAsset = BuiltinStyle | BuiltinChar;

/** 解析后的资产（组合用户库与出厂两种来源，prompt 组装/encode 消费） */
export interface ResolvedStyle {
  key: string;
  source: 'user' | 'builtin';
  anchor: string;
  styleSentence?: string;
  negatives?: string;
  template?: string;
}

export interface ResolvedChar {
  key: string;
  source: 'user' | 'builtin';
  ref: string;
  identity?: string;
}

/** 清单损坏（空/非法 JSON/结构不对）——调用方 exit 1，绝不覆写重建 */
export class ManifestCorruptError extends Error {}
/** 参数非法 / 输入文件不存在 / 出厂资产不可删——调用方 exit 2 */
export class InvalidArgsError extends Error {}

export const KEY_RE = /^[a-z0-9-]+$/;

export function validateKey(key: string, what = 'key'): string {
  if (!KEY_RE.test(key)) {
    throw new InvalidArgsError(`${what} 仅允许小写字母/数字/短横线（${KEY_RE.source}）: ${key}`);
  }
  return key;
}

// ———————————————————————————— 库根解析 ————————————————————————————

export function defaultStylesLibRoot(): string {
  return path.join(os.homedir(), '.config', 'limg', 'h3-styles');
}

export function defaultCharsLibRoot(): string {
  return path.join(os.homedir(), '.config', 'limg', 'h3-chars');
}

export function stylesLibRoot(): string {
  const env = process.env.H3_STYLES_LIB;
  if (env && env.trim()) return path.resolve(env.trim());
  return defaultStylesLibRoot();
}

export function charsLibRoot(): string {
  const env = process.env.H3_CHARS_LIB;
  if (env && env.trim()) return path.resolve(env.trim());
  return defaultCharsLibRoot();
}

export function libRootFor(kind: H3AssetKind): string {
  return kind === 'style' ? stylesLibRoot() : charsLibRoot();
}

// ———————————————————————————— 出厂预设（包内 assets） ————————————————————————————

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 包内出厂资产根：dist 与 tsx 源码两种运行形态都兼容 */
export function builtinAssetsRoot(): string {
  const candidates = [
    path.resolve(HERE, '..', 'assets'),      // dist/lib/h3-assets.js → <pkg>/assets
    path.resolve(HERE, '..', '..', 'assets'), // src/lib/h3-assets.ts（tsx dev）→ <pkg>/assets
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'h3-styles'))) return c;
  }
  return candidates[0];
}

function readBuiltinJson<T>(file: string): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
  } catch (e) {
    throw new ManifestCorruptError(`出厂预设损坏（无法解析）: ${file}（${(e as Error).message}）`);
  }
}

export function builtinStyles(root = builtinAssetsRoot()): BuiltinStyle[] {
  const dir = path.join(root, 'h3-styles');
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir).filter((d) => !d.startsWith('.'));
  } catch {
    return [];
  }
  const out: BuiltinStyle[] = [];
  for (const key of entries) {
    const metaFile = path.join(dir, key, 'style.json');
    if (!fs.existsSync(metaFile)) continue;
    const meta = readBuiltinJson<Partial<BuiltinStyle> & { style_sentence?: string }>(metaFile);
    out.push({
      key: meta.key ?? key,
      kind: 'style',
      dir: path.join(dir, key),
      anchor: path.join(dir, key, meta.anchor ?? 'anchor.png'),
      styleSentence: meta.styleSentence ?? meta.style_sentence ?? '',
      negatives: meta.negatives,
      template: meta.template,
      note: meta.note ?? '',
    });
  }
  return out;
}

export function builtinChars(root = builtinAssetsRoot()): BuiltinChar[] {
  const dir = path.join(root, 'h3-chars');
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir).filter((d) => !d.startsWith('.'));
  } catch {
    return [];
  }
  const out: BuiltinChar[] = [];
  for (const key of entries) {
    const metaFile = path.join(dir, key, 'char.json');
    if (!fs.existsSync(metaFile)) continue;
    const meta = readBuiltinJson<Partial<BuiltinChar>>(metaFile);
    out.push({
      key: meta.key ?? key,
      kind: 'char',
      dir: path.join(dir, key),
      ref: path.join(dir, key, meta.ref ?? 'ref.png'),
      identity: meta.identity ?? '',
      note: meta.note ?? '',
    });
  }
  return out;
}

export function isBuiltinStyle(key: string): boolean {
  return builtinStyles().some((s) => s.key === key);
}

export function isBuiltinChar(key: string): boolean {
  return builtinChars().some((c) => c.key === key);
}

// ———————————————————————————— 用户库清单（SSOT） ————————————————————————————

function manifestPath(root: string): string {
  return path.join(root, 'index.json');
}

function emptyManifest(): H3AssetManifest {
  return { version: 1, generatedAt: new Date().toISOString(), items: [] };
}

/** 读清单：缺失 → 空清单（不写盘）；损坏 → ManifestCorruptError（不重建） */
export function readManifest(root: string): H3AssetManifest {
  const p = manifestPath(root);
  if (!fs.existsSync(p)) return emptyManifest();
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch (e) {
    throw new ManifestCorruptError(
      `H3 资产库清单损坏，无法解析: ${p}\n${(e as Error).message}\n请手工修复或移走该文件（不会自动重建以免丢账）。`,
    );
  }
  const m = parsed as Partial<H3AssetManifest> | null;
  if (!m || typeof m !== 'object' || !Array.isArray(m.items)) {
    throw new ManifestCorruptError(
      `H3 资产库清单结构不符合预期（缺 items 数组）: ${p}\n请手工修复（不会自动重建以免丢账）。`,
    );
  }
  return { version: 1, generatedAt: m.generatedAt ?? '', items: m.items as H3AssetItem[] };
}

/** 原子写：tmp + rename，防并发/中断写坏 SSOT */
export function writeManifest(root: string, manifest: H3AssetManifest): void {
  fs.mkdirSync(root, { recursive: true });
  const p = manifestPath(root);
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(manifest, null, 1)}\n`, 'utf-8');
  fs.renameSync(tmp, p);
}

export function sha256File(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// ———————————————————————————— 入库（拷贝进库 + 落账） ————————————————————————————

interface AddOpts {
  key: string;
  /** 主资产（style=锚页图，char=角色卡图） */
  primary: string;
  primaryRole: string;
  /** 辅文件（style=模板 txt，char=身份锁定句 txt） */
  extra?: string;
  extraRole?: string;
  note?: string;
}

function addEntry(root: string, kind: H3AssetKind, opts: AddOpts): { item: H3AssetItem; duplicated: boolean } {
  validateKey(opts.key, 'key');
  for (const [role, f] of [['primary', opts.primary], ['extra', opts.extra]] as const) {
    if (f !== undefined && !fs.existsSync(f)) {
      throw new InvalidArgsError(`${role === 'primary' ? '资产文件' : '辅文件'}不存在: ${f}`);
    }
  }
  const hash = sha256File(opts.primary);
  const dup = readManifest(root).items.find((i) => i.kind === kind && i.content_hash === hash);
  if (dup) return { item: dup, duplicated: true };

  // 拷贝入库（库根 assets/<key>/ 下，不引用原路径；保留原扩展名）
  const dstDir = path.join(root, 'assets', opts.key);
  fs.mkdirSync(dstDir, { recursive: true });
  const files: Record<string, string> = {};
  const copy = (src: string, role: string): string => {
    const dst = path.join(dstDir, `${role}${path.extname(src) || '.bin'}`);
    fs.copyFileSync(src, dst);
    files[role] = dst;
    return dst;
  };
  const primaryDst = copy(opts.primary, opts.primaryRole);
  if (opts.extra) copy(opts.extra, opts.extraRole ?? 'extra');

  const item: H3AssetItem = {
    key: opts.key,
    kind,
    path: primaryDst,
    files,
    content_hash: hash,
    created_at: new Date().toISOString(),
    note: opts.note ?? '',
  };
  const next = readManifest(root);
  const idx = next.items.findIndex((i) => i.kind === kind && i.key === opts.key);
  if (idx >= 0) next.items[idx] = item; // 同 (kind,key) 重登记 → 覆写旧记录
  else next.items.push(item);
  writeManifest(root, next);
  return { item, duplicated: false };
}

export function addStyle(
  root: string,
  opts: { key: string; anchor: string; template?: string; note?: string },
): { item: H3AssetItem; duplicated: boolean } {
  return addEntry(root, 'style', {
    key: opts.key,
    primary: opts.anchor,
    primaryRole: 'anchor',
    extra: opts.template,
    extraRole: 'template',
    note: opts.note,
  });
}

export function addChar(
  root: string,
  opts: { key: string; ref: string; identity?: string; note?: string },
): { item: H3AssetItem; duplicated: boolean } {
  return addEntry(root, 'char', {
    key: opts.key,
    primary: opts.ref,
    primaryRole: 'ref',
    extra: opts.identity,
    extraRole: 'identity',
    note: opts.note,
  });
}

/** 移除记录（连同库内资产文件）；找不到 → null */
export function removeEntry(root: string, kind: H3AssetKind, key: string): H3AssetItem | null {
  const manifest = readManifest(root);
  const idx = manifest.items.findIndex((i) => i.kind === kind && i.key === key);
  if (idx < 0) return null;
  const [removed] = manifest.items.splice(idx, 1);
  writeManifest(root, manifest);
  for (const f of Object.values(removed.files)) fs.rmSync(f, { force: true });
  return removed;
}

// ———————————————————————————— 解析（用户库 > 出厂预设） ————————————————————————————

function userStyleToResolved(item: H3AssetItem): ResolvedStyle {
  return {
    key: item.key,
    source: 'user',
    anchor: item.files.anchor ?? item.path,
    styleSentence: undefined,
    negatives: undefined,
    template: item.files.template,
  };
}

function userCharToResolved(item: H3AssetItem): ResolvedChar {
  return {
    key: item.key,
    source: 'user',
    ref: item.files.ref ?? item.path,
    identity: undefined,
  };
}

/** 风格解析：用户库 > 出厂预设；都无 → null（调用方 exit 2）。
 * 用户库条目的 style_sentence/negatives 存在清单记录上（files.template 可覆写模板） */
export function resolveStyle(key: string, root = stylesLibRoot()): ResolvedStyle | null {
  const user = readManifest(root).items.find((i) => i.kind === 'style' && i.key === key);
  if (user) {
    const r = userStyleToResolved(user);
    // style.json 才带句式；用户库条目无句式字段 → 仅锚页 + 可选模板（分工句由 h3-prompt 默认表补齐）
    return r;
  }
  const b = builtinStyles().find((s) => s.key === key);
  if (!b) return null;
  return { key: b.key, source: 'builtin', anchor: b.anchor, styleSentence: b.styleSentence, negatives: b.negatives, template: b.template };
}

/** 角色解析：用户库 > 出厂预设；都无 → null */
export function resolveChar(key: string, root = charsLibRoot()): ResolvedChar | null {
  const user = readManifest(root).items.find((i) => i.kind === 'char' && i.key === key);
  if (user) return userCharToResolved(user);
  const b = builtinChars().find((c) => c.key === key);
  if (!b) return null;
  return { key: b.key, source: 'builtin', ref: b.ref, identity: b.identity };
}

// ———————————————————————————— 对账 ————————————————————————————

export interface VerifyProblem {
  key: string;
  source: 'user' | 'builtin';
  issues: string[];
}

function verifyUserItem(item: H3AssetItem): string[] {
  const issues: string[] = [];
  if (!fs.existsSync(item.path)) issues.push(`主资产缺失: ${item.path}`);
  for (const [role, f] of Object.entries(item.files)) {
    if (!fs.existsSync(f)) issues.push(`文件缺失（${role}）: ${f}`);
  }
  if (fs.existsSync(item.path)) {
    const actual = sha256File(item.path);
    if (actual !== item.content_hash) issues.push('主资产内容漂移（sha256 不一致，文件被覆盖）');
  }
  return issues;
}

/** 对账：出厂预设（文件在位 + json 可解析）+ 用户库（记录 ↔ 文件 ↔ 内容一致）。kind 可选过滤 */
export function verifyAssets(root: string, kind?: H3AssetKind): { items: H3AssetItem[]; builtin: BuiltinAsset[]; problems: VerifyProblem[] } {
  const items = kind ? readManifest(root).items.filter((i) => i.kind === kind) : readManifest(root).items;
  const builtin = kind === 'char' ? builtinChars() : kind === 'style' ? builtinStyles() : [...builtinStyles(), ...builtinChars()];
  const problems: VerifyProblem[] = [];
  for (const item of items) {
    if (kind && item.kind !== kind) continue;
    const issues = verifyUserItem(item);
    if (issues.length) problems.push({ key: item.key, source: 'user', issues });
  }
  for (const b of builtin) {
    const primary = b.kind === 'style' ? b.anchor : b.ref;
    const issues: string[] = [];
    if (!fs.existsSync(primary)) issues.push(`出厂资产缺失: ${primary}`);
    if (issues.length) problems.push({ key: b.key, source: 'builtin', issues });
  }
  return { items, builtin, problems };
}

/** 展示合并视图：出厂预设（[builtin] 标记）+ 用户库条目 */
export function listAssets(root: string, kind: H3AssetKind): { key: string; source: 'user' | 'builtin'; path: string; note: string; created_at: string }[] {
  const out: { key: string; source: 'user' | 'builtin'; path: string; note: string; created_at: string }[] = [];
  for (const b of kind === 'char' ? builtinChars() : builtinStyles()) {
    out.push({
      key: b.key,
      source: 'builtin',
      path: b.kind === 'style' ? b.anchor : b.ref,
      note: `[builtin] ${b.note}`,
      created_at: '',
    });
  }
  for (const item of readManifest(root).items) {
    if (item.kind !== kind) continue;
    out.push({ key: item.key, source: 'user', path: item.path, note: item.note, created_at: item.created_at });
  }
  return out;
}
