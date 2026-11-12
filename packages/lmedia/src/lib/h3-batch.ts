/**
 * H3 batch 清单解析（纯函数，供单测直测）。
 * 语义（契约规约）：文件级损坏（空/非法 JSON/非数组）→ ManifestCorruptError（exit 1）；
 * 条目字段非法（key 不合法/size 格式错）→ InvalidArgsError（exit 2，指明条目与字段）。
 */
import * as fs from 'node:fs';
import { InvalidArgsError, ManifestCorruptError, validateKey } from './h3-assets.js';
import { parseSize } from './h3-prompt.js';

export interface BatchManifestItem {
  scene: string;
  out: string;
  style?: string;
  char?: string;
  seed?: number;
  size?: string;
}

/** 读取清单文本：'-' = stdin */
export function readManifestText(file: string): string {
  if (file === '-') return fs.readFileSync(0, 'utf-8');
  if (!fs.existsSync(file)) throw new InvalidArgsError(`批清单不存在: ${file}`);
  return fs.readFileSync(file, 'utf-8');
}

export function parseH3BatchManifest(text: string): BatchManifestItem[] {
  if (!text.trim()) {
    throw new ManifestCorruptError('批清单损坏（空文件，ManifestCorruptError；需 [{"scene":"...","out":"page.png"}]）');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new ManifestCorruptError(`批清单损坏（非法 JSON，ManifestCorruptError）: ${(e as Error).message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new ManifestCorruptError('批清单损坏（需为 JSON 数组 [{"scene":"...","out":"page.png"}]）');
  }
  return parsed.map((raw, i) => {
    const it = raw as Partial<BatchManifestItem> | null;
    if (!it || typeof it !== 'object') {
      throw new ManifestCorruptError(`批清单条目 #${i + 1} 需为对象`);
    }
    if (typeof it.scene !== 'string' || !it.scene.trim()) {
      throw new InvalidArgsError(`批清单条目 #${i + 1} scene 需为非空字符串`);
    }
    const tag = `批清单条目 #${i + 1}（scene=${it.scene.slice(0, 30)}）`;
    if (typeof it.out !== 'string' || !it.out.trim()) {
      throw new InvalidArgsError(`${tag} out 需为非空路径字符串`);
    }
    if (it.style !== undefined) validateKey(String(it.style), `${tag} style key`);
    if (it.char !== undefined) validateKey(String(it.char), `${tag} char key`);
    if (it.seed !== undefined && (!Number.isInteger(Number(it.seed)))) {
      throw new InvalidArgsError(`${tag} seed 需为整数: ${it.seed}`);
    }
    try {
      parseSize(it.size as string | undefined);
    } catch (e) {
      throw new InvalidArgsError(`${tag} size 非法: ${(e as Error).message}`);
    }
    return {
      scene: it.scene,
      out: it.out,
      style: it.style as string | undefined,
      char: it.char as string | undefined,
      seed: it.seed === undefined ? undefined : Number(it.seed),
      size: it.size as string | undefined,
    };
  });
}
