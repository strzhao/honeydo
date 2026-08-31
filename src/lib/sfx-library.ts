/** SSOT 音效库：~/.config/limg/sfx-library/（--lib flag > LMEDIA_SFX_LIB env > 默认）
 * <root>/index.json 唯一清单；<root>/sfx|ambient/<key>.mp3 规范产物（44.1kHz mono 160k mp3）。
 * 与 lora 注册表（首次自动播种）不同：清单损坏一律抛 ManifestCorruptError，禁止静默重建。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export type SfxType = 'sfx' | 'ambient';

export interface SfxLibraryItem {
  key: string;
  library: string;
  type: SfxType;
  path: string;
  duration: number;
  sample_rate: number;
  tags: string[];
  title: string;
  note: string;
  status: 'ready';
  content_hash: string;
  created_at: string;
}

export interface SfxManifest {
  version: 1;
  generatedAt: string;
  items: SfxLibraryItem[];
}

export interface VerifyProblem {
  key: string;
  type: SfxType;
  issues: string[];
}

/** 清单损坏（空/非法 JSON/结构不对）——调用方 exit 1，绝不覆写重建 */
export class ManifestCorruptError extends Error {}
/** 参数非法 / 输入文件不存在——调用方 exit 2 */
export class InvalidArgsError extends Error {}
/** 环境缺失（venv/ffmpeg）——调用方 exit 1 */
export class SfxEnvError extends Error {}

export const KEY_RE = /^[a-z0-9-]+$/;

export function defaultLibraryRoot(): string {
  return path.join(os.homedir(), '.config', 'limg', 'sfx-library');
}

/** 解析优先级：--lib flag > LMEDIA_SFX_LIB env > ~/.config/limg/sfx-library */
export function resolveLibraryRoot(flag?: string): string {
  if (flag && flag.trim()) return path.resolve(flag.trim());
  const env = process.env.LMEDIA_SFX_LIB;
  if (env && env.trim()) return path.resolve(env.trim());
  return defaultLibraryRoot();
}

export function manifestPath(root: string): string {
  return path.join(root, 'index.json');
}

function emptyManifest(): SfxManifest {
  return { version: 1, generatedAt: new Date().toISOString(), items: [] };
}

/** 读清单：缺失 → 空清单（不写盘）；损坏 → ManifestCorruptError（不重建） */
export function readManifest(root: string): SfxManifest {
  const p = manifestPath(root);
  if (!fs.existsSync(p)) return emptyManifest();
  const raw = fs.readFileSync(p, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ManifestCorruptError(
      `音效库清单损坏，无法解析: ${p}\n请手工修复或移走该文件（不会自动重建以免丢账）。`,
    );
  }
  const m = parsed as Partial<SfxManifest> | null;
  if (!m || typeof m !== 'object' || !Array.isArray(m.items)) {
    throw new ManifestCorruptError(
      `音效库清单结构不符合预期（缺 items 数组）: ${p}\n请手工修复（不会自动重建以免丢账）。`,
    );
  }
  return { version: 1, generatedAt: m.generatedAt ?? '', items: m.items as SfxLibraryItem[] };
}

/** 原子写：tmp + rename，防并发/中断写坏 SSOT */
export function writeManifest(root: string, manifest: SfxManifest): void {
  fs.mkdirSync(root, { recursive: true });
  const p = manifestPath(root);
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(manifest, null, 1)}\n`, 'utf-8');
  fs.renameSync(tmp, p);
}

/** 建库根 + 目录骨架 + 空清单（幂等：已有清单不动） */
export function initLibrary(root: string): { root: string; manifest: string; created: boolean } {
  fs.mkdirSync(path.join(root, 'sfx'), { recursive: true });
  fs.mkdirSync(path.join(root, 'ambient'), { recursive: true });
  const created = !fs.existsSync(manifestPath(root));
  if (created) writeManifest(root, emptyManifest());
  return { root: path.resolve(root), manifest: manifestPath(root), created };
}

export function listEntries(
  root: string,
  filter: { type?: string; status?: string } = {},
): SfxLibraryItem[] {
  return readManifest(root).items.filter(
    (i) => (!filter.type || i.type === filter.type) && (!filter.status || i.status === filter.status),
  );
}

export function sha256File(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export interface AudioProbe {
  duration: number;
  sampleRate: number;
}

function assertFfmpeg(): void {
  for (const cmd of ['ffmpeg', 'ffprobe']) {
    if (spawnSync('which', [cmd], { stdio: 'ignore' }).status !== 0) {
      throw new SfxEnvError(`缺少 ${cmd}（brew install ffmpeg），音效库入库需要转码/探针`);
    }
  }
}

/** ffprobe 时长 + 采样率 */
export function probeAudio(file: string): AudioProbe {
  let stdout: string;
  try {
    stdout = execFileSync(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration:stream=sample_rate', '-of', 'json', file],
      { encoding: 'utf-8' },
    ) as unknown as string;
  } catch {
    throw new SfxEnvError(`ffprobe 无法解析音频: ${file}`);
  }
  const j = JSON.parse(stdout) as {
    format?: { duration?: string };
    streams?: { sample_rate?: string }[];
  };
  return {
    duration: parseFloat(j.format?.duration ?? '0'),
    sampleRate: parseInt(j.streams?.[0]?.sample_rate ?? '0', 10),
  };
}

/** 同步时长探针（verify 用；失败返回 -1 → 计入漂移） */
export function probeAudioDurationSync(file: string): number {
  try {
    return probeAudio(file).duration;
  } catch {
    return -1;
  }
}

/** ffmpeg 转码到库存规范：44.1kHz mono 160k mp3 */
function transcode(file: string, dst: string): void {
  try {
    execFileSync(
      'ffmpeg',
      ['-y', '-v', 'error', '-i', file, '-ar', '44100', '-ac', '1', '-b:a', '160k', dst],
      { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf-8' },
    );
  } catch (e) {
    throw new SfxEnvError(`转码失败: ${file} → ${dst}\n${((e as { stderr?: string }).stderr ?? '').slice(-400)}`);
  }
}

export interface AddOpts {
  file: string;
  key: string;
  type?: SfxType;
  library?: string;
  title?: string;
  note?: string;
  tags?: string[];
}

export interface AddResult {
  item: SfxLibraryItem;
  duplicated: boolean;
}

/** 入库：转码 44.1k mono 160k mp3 + 清单落账。同 content_hash 已存在 → 幂等跳过（不重复记账） */
export function addEntry(root: string, opts: AddOpts): AddResult {
  if (!KEY_RE.test(opts.key)) throw new InvalidArgsError(`key 仅允许小写字母/数字/短横线: ${opts.key}`);
  const type: SfxType = opts.type ?? 'sfx';
  if (type !== 'sfx' && type !== 'ambient') throw new InvalidArgsError(`type 仅支持 sfx|ambient: ${type}`);
  if (!fs.existsSync(opts.file)) throw new InvalidArgsError(`输入音频不存在: ${opts.file}`);

  const hash = sha256File(opts.file);
  const dup = readManifest(root).items.find((i) => i.content_hash === hash);
  if (dup) return { item: dup, duplicated: true };

  assertFfmpeg(); // 先于建库根：环境缺失时零副作用（不残留目录）
  initLibrary(root); // 库根不存在自动创建（幂等）
  const dst = path.join(root, type, `${opts.key}.mp3`);
  transcode(opts.file, dst);
  let probe: ReturnType<typeof probeAudio>;
  try {
    probe = probeAudio(dst);
  } catch (e) {
    fs.rmSync(dst, { force: true }); // 探针失败回滚，不留无账孤儿文件
    throw e;
  }
  const item: SfxLibraryItem = {
    key: opts.key,
    library: opts.library?.trim() || 'default',
    type,
    path: dst,
    duration: Math.round(probe.duration * 1000) / 1000,
    sample_rate: probe.sampleRate,
    tags: opts.tags ?? [],
    title: opts.title ?? '',
    note: opts.note ?? '',
    status: 'ready',
    content_hash: hash,
    created_at: new Date().toISOString(),
  };
  const next = readManifest(root);
  // 同 (type,key) 重登记 → 覆写旧记录；其余追加
  const idx = next.items.findIndex((i) => i.type === type && i.key === item.key);
  if (idx >= 0) next.items[idx] = item;
  else next.items.push(item);
  writeManifest(root, next);
  return { item, duplicated: false };
}

/** 移除记录（不删音频文件）；按 type 过滤后找不到 → null */
export function removeEntry(root: string, key: string, type?: string): SfxLibraryItem | null {
  const manifest = readManifest(root);
  const idx = manifest.items.findIndex((i) => i.key === key && (!type || i.type === type));
  if (idx < 0) return null;
  const [removed] = manifest.items.splice(idx, 1);
  writeManifest(root, manifest);
  return removed;
}

/** 对账：记录 ↔ 文件 ↔ 时长（±0.1s）↔ status */
export function verifyLibrary(root: string): {
  root: string;
  items: SfxLibraryItem[];
  problems: VerifyProblem[];
} {
  const items = readManifest(root).items;
  const problems: VerifyProblem[] = [];
  for (const item of items) {
    const issues: string[] = [];
    if (!fs.existsSync(item.path)) {
      issues.push(`文件缺失: ${item.path}`);
    } else {
      const dur = probeAudioDurationSync(item.path);
      if (dur < 0) issues.push(`无法读取时长: ${item.path}`);
      else if (Math.abs(dur - item.duration) > 0.1) {
        issues.push(`时长漂移: 清单 ${item.duration.toFixed(2)}s / 实际 ${dur.toFixed(2)}s`);
      }
    }
    if (item.status !== 'ready') issues.push(`状态异常: ${item.status}`);
    if (issues.length) problems.push({ key: item.key, type: item.type, issues });
  }
  return { root: path.resolve(root), items, problems };
}
