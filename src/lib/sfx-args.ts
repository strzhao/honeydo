/** sfx 子命令参数解析/校验（纯函数，供单测直测）。
 * 语义：参数非法/越界/互斥/文件不存在 → InvalidArgsError（exit 2）；
 *      清单存在但内容坏（空/非法 JSON/结构错）→ ManifestCorruptError（exit 1）。
 */
import * as fs from 'node:fs';
import {
  InvalidArgsError,
  KEY_RE,
  ManifestCorruptError,
} from './sfx-library.js';

function num(v: string | undefined, name: string): number {
  const n = parseFloat(v as string);
  if (!Number.isFinite(n)) throw new InvalidArgsError(`${name} 需为数字: ${v}`);
  return n;
}

function inRange(n: number, name: string, min: number, max: number): number {
  if (n < min || n > max) throw new InvalidArgsError(`${name} 取值 ${min} - ${max}: ${n}`);
  return n;
}

/** 整数参数（如 rolls），可带默认值 */
export function parseInteger(v: string | undefined, name: string, min: number, max: number, def: number): number {
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new InvalidArgsError(`${name} 需为整数: ${v}`);
  return inRange(n, name, min, max);
}

export function parseFloatIn(v: string | undefined, name: string, min: number, max: number, def: number): number {
  if (v === undefined || v === '') return def;
  return inRange(num(v, name), name, min, max);
}

export const parseRolls = (v?: string): number => parseInteger(v, '--rolls', 1, 10, 3);

/** --thresh 形如 -35dB */
export function parseThreshDb(v: string | undefined, def: number): number {
  if (v === undefined || v === '') return def;
  if (!/^-\d+dB$/.test(v)) throw new InvalidArgsError(`--thresh 需形如 -35dB: ${v}`);
  return parseFloat(v.slice(0, -2));
}

export const parsePad = (v?: string): number => parseFloatIn(v, '--pad', 0.01, 2.0, 0.15);
export const parseCap = (v?: string): number => parseFloatIn(v, '--cap', 0.5, 10.0, 3.5);
/** 峰值归一目标 dBFS */
export const parseTarget = (v?: string): number => parseFloatIn(v, '--target', -60.0, -0.5, -6.0);
/** loudnorm 目标 LUFS */
export const parseLoudness = (v?: string): number => parseFloatIn(v, '--loudness', -40.0, -5.0, -23.0);

export function parseMinDur(v?: string): number {
  return parseFloatIn(v, '--min-dur', 0.05, 3600, 0.4);
}

export function parseMaxDur(v?: string, minDur = 0.4): number {
  const max = parseFloatIn(v, '--max-dur', 0.1, 3600, 4.0);
  if (minDur >= max) throw new InvalidArgsError(`--min-dur（${minDur}）需小于 --max-dur（${max}）`);
  return max;
}

/** --target / --loudness 互斥（同给 exit 2） */
export function assertMutuallyExclusive(a: unknown, b: unknown, nameA: string, nameB: string): void {
  if (a !== undefined && b !== undefined) {
    throw new InvalidArgsError(`${nameA} 与 ${nameB} 互斥，只给其一`);
  }
}

/** 输入文件必须全部存在（任一缺失 exit 2，整批不执行） */
export function assertFilesExist(files: string[], flagName = '输入文件'): void {
  const missing = files.filter((f) => !fs.existsSync(f));
  if (missing.length) {
    throw new InvalidArgsError(`${flagName}不存在: ${missing.join(', ')}`);
  }
}

export function validateKey(key: string): string {
  if (!KEY_RE.test(key)) throw new InvalidArgsError(`key 仅允许小写字母/数字/短横线: ${key}`);
  return key;
}

export interface BatchItem {
  key: string;
  prompt: string;
}

/** batch 清单解析：结构坏 → ManifestCorruptError(1)；key 非法/重复 → InvalidArgsError(2) */
export function parseBatchManifest(text: string, keysFilter?: string[]): BatchItem[] {
  if (!text.trim()) {
    throw new ManifestCorruptError('批清单为空（需 [{"key":"bear","prompt":"..."}]）');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new ManifestCorruptError(`批清单解析失败（非法 JSON）: ${(e as Error).message}`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new ManifestCorruptError('批清单需为非空数组 [{"key":"bear","prompt":"..."}]');
  }
  const items: BatchItem[] = [];
  for (const raw of parsed) {
    const it = raw as Partial<BatchItem> | null;
    if (!it || typeof it !== 'object' || typeof it.key !== 'string' || typeof it.prompt !== 'string'
      || !it.prompt.trim()) {
      throw new ManifestCorruptError('批清单条目需含非空 key 与 prompt 字符串');
    }
    items.push({ key: it.key, prompt: it.prompt });
  }
  const seen = new Set<string>();
  for (const it of items) {
    validateKey(it.key);
    if (seen.has(it.key)) throw new InvalidArgsError(`批清单 key 重复: ${it.key}`);
    seen.add(it.key);
  }
  if (!keysFilter?.length) return items;
  const unknown = keysFilter.filter((k) => !seen.has(k));
  if (unknown.length) throw new InvalidArgsError(`--keys 含清单外 key: ${unknown.join(', ')}`);
  const wanted = new Set(keysFilter); // Set 去重：--keys bear,bear 只取一次
  const picked = items.filter((it) => wanted.has(it.key));
  if (!picked.length) throw new InvalidArgsError('--keys 过滤后无可用条目');
  return picked;
}

export interface AbGroup {
  name: string;
  candidates: string[];
}

/** ab groups JSON 解析：坏内容 → ManifestCorruptError(1)；候选文件缺失由调用方按 exit 2 处理 */
export function parseAbGroups(text: string): AbGroup[] {
  if (!text.trim()) throw new ManifestCorruptError('A/B groups 为空（需 [{"name":"...","candidates":["a.wav"]}]）');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new ManifestCorruptError(`A/B groups 解析失败（非法 JSON）: ${(e as Error).message}`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new ManifestCorruptError('A/B groups 需为非空数组 [{"name":"...","candidates":[...]}]');
  }
  return parsed.map((raw, i) => {
    const g = raw as Partial<AbGroup> | null;
    if (!g || typeof g !== 'object' || !Array.isArray(g.candidates) || g.candidates.some((c) => typeof c !== 'string' || !c.trim())) {
      throw new ManifestCorruptError(`A/B groups 第 ${i + 1} 组需含 candidates 路径数组`);
    }
    return { name: typeof g.name === 'string' && g.name.trim() ? g.name : `组${i + 1}`, candidates: g.candidates };
  });
}
