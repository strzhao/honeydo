/** sfx-library SSOT 清单模块单测（纯 Node + ffmpeg fixture，无模型依赖） */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ManifestCorruptError,
  addEntry,
  defaultLibraryRoot,
  initLibrary,
  listEntries,
  manifestPath,
  readManifest,
  removeEntry,
  resolveLibraryRoot,
  verifyLibrary,
  writeManifest,
} from '../src/lib/sfx-library.js';

const FFMPEG = 'ffmpeg';
let dir = '';

function fixture(name: string, build: (out: string) => void): string {
  const out = path.join(dir, name);
  build(out);
  return out;
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lmedia-sfx-lib-'));
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function toneWav(out: string, db = -6): void {
  execFileSync(FFMPEG, [
    '-y', '-v', 'error', '-f', 'lavfi', '-i', `sine=f=440:d=0.4:r=44100`,
    '-af', `volume=${db}dB`, '-ac', '1', '-ar', '44100', out,
  ]);
}

describe('库根解析', () => {
  it('优先级 --lib > LMEDIA_SFX_LIB > 默认 ~/.config/limg/sfx-library', () => {
    expect(resolveLibraryRoot('/tmp/a')).toBe('/tmp/a');
    process.env.LMEDIA_SFX_LIB = '/tmp/b';
    expect(resolveLibraryRoot()).toBe('/tmp/b');
    expect(resolveLibraryRoot('/tmp/a')).toBe('/tmp/a');
    delete process.env.LMEDIA_SFX_LIB;
    expect(resolveLibraryRoot()).toBe(defaultLibraryRoot());
  });
});

describe('init', () => {
  it('创建库根 + 空清单', () => {
    const root = path.join(dir, 'lib-init');
    initLibrary(root);
    expect(fs.existsSync(root)).toBe(true);
    const m = JSON.parse(fs.readFileSync(manifestPath(root), 'utf-8'));
    expect(m.version).toBe(1);
    expect(Array.isArray(m.items)).toBe(true);
    expect(m.items).toHaveLength(0);
    expect(fs.existsSync(path.join(root, 'sfx'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'ambient'))).toBe(true);
  });

  it('重复 init 不破坏既有清单', () => {
    const root = path.join(dir, 'lib-init');
    const m = readManifest(root);
    m.items.push({
      key: 'x', library: 'default', type: 'sfx', path: '/tmp/x.mp3', duration: 1,
      sample_rate: 44100, tags: [], title: '', note: '', status: 'ready',
      content_hash: 'h', created_at: 't',
    });
    writeManifest(root, m);
    initLibrary(root);
    expect(readManifest(root).items).toHaveLength(1);
  });
});

describe('add', () => {
  it('落库字段齐全 + 自动建根 + 转码 mp3', () => {
    const wav = fixture('add-in.wav', (o) => toneWav(o));
    const root = path.join(dir, 'lib-add'); // 故意不存在 → 自动创建
    const { item, duplicated } = addEntry(root, {
      file: wav, key: 'bear', type: 'sfx', library: 'storybook',
      title: '熊叫', note: 'IP 签名', tags: ['animal', 'ui-click'],
    });
    expect(duplicated).toBe(false);
    expect(fs.existsSync(root)).toBe(true);
    expect(item.library).toBe('storybook');
    expect(item.type).toBe('sfx');
    expect(item.tags).toEqual(['animal', 'ui-click']);
    expect(item.title).toBe('熊叫');
    expect(item.note).toBe('IP 签名');
    expect(item.status).toBe('ready');
    expect(item.sample_rate).toBe(44100);
    expect(item.duration).toBeGreaterThan(0.3);
    expect(item.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(item.created_at).toBeTruthy();
    expect(item.path).toBe(path.join(root, 'sfx', 'bear.mp3'));
    expect(fs.existsSync(item.path)).toBe(true);
    // 记录与清单一致
    const m = readManifest(root);
    expect(m.items).toHaveLength(1);
    expect(m.version).toBe(1);
  });

  it('同 content_hash 重复登记幂等（条目数保持 1）', () => {
    const wav = fixture('add-idem.wav', (o) => toneWav(o, -10));
    const root = path.join(dir, 'lib-add');
    addEntry(root, { file: wav, key: 'bear2' });
    const second = addEntry(root, { file: wav, key: 'bear3' });
    expect(second.duplicated).toBe(true);
    const hashes = readManifest(root).items.filter((i) => i.content_hash === second.item.content_hash);
    expect(hashes).toHaveLength(1);
  });

  it('ambient 类型落到 ambient/ 目录', () => {
    const wav = fixture('add-ambient.wav', (o) => toneWav(o, -20));
    const root = path.join(dir, 'lib-add');
    const { item } = addEntry(root, { file: wav, key: 'rain', type: 'ambient' });
    expect(item.path).toBe(path.join(root, 'ambient', 'rain.mp3'));
    expect(fs.existsSync(item.path)).toBe(true);
  });

  it('输入文件不存在抛参数错误（不建目录）', () => {
    const root = path.join(dir, 'lib-add-missing');
    expect(() => addEntry(root, { file: path.join(dir, 'nope.wav'), key: 'x' })).toThrow(/不存在/);
    expect(fs.existsSync(root)).toBe(false);
  });
});

describe('list / remove', () => {
  it('过滤 type/status；remove 只删记录不删文件', () => {
    const root = path.join(dir, 'lib-list');
    const wav = fixture('list-in.wav', (o) => toneWav(o, -14));
    const wav2 = fixture('list-in2.wav', (o) => toneWav(o, -15));
    addEntry(root, { file: wav, key: 'dog', type: 'sfx', library: 'd1' });
    addEntry(root, { file: wav2, key: 'wind', type: 'ambient', library: 'd1' });
    expect(listEntries(root)).toHaveLength(2);
    expect(listEntries(root, { type: 'ambient' }).map((i) => i.key)).toEqual(['wind']);
    expect(listEntries(root, { type: 'sfx', status: 'ready' }).map((i) => i.key)).toEqual(['dog']);

    const dog = path.join(root, 'sfx', 'dog.mp3');
    expect(fs.existsSync(dog)).toBe(true);
    const removed = removeEntry(root, 'dog', 'sfx');
    expect(removed?.key).toBe('dog');
    expect(fs.existsSync(dog)).toBe(true); // 源文件保留
    expect(listEntries(root)).toHaveLength(1);
    expect(listEntries(root, { type: 'sfx' })).toHaveLength(0);
    expect(removeEntry(root, 'dog', 'sfx')).toBeNull(); // 已不存在
  });

  it('type 过滤后 key 不存在 → null（CLI 映射 exit 1）', () => {
    const root = path.join(dir, 'lib-list');
    expect(removeEntry(root, 'absent-key')).toBeNull();
  });
});

describe('verify', () => {
  it('完整库零漂移；删文件后报漂移', () => {
    const root = path.join(dir, 'lib-verify');
    const wav = fixture('verify-in.wav', (o) => toneWav(o, -8));
    const { item } = addEntry(root, { file: wav, key: 'cat' });
    expect(verifyLibrary(root).problems).toHaveLength(0);

    fs.rmSync(item.path);
    const v = verifyLibrary(root);
    expect(v.problems).toHaveLength(1);
    expect(v.problems[0].key).toBe('cat');
    expect(v.problems[0].issues.join()).toMatch(/缺失/);
  });

  it('时长漂移 >0.1s 报问题', () => {
    const root = path.join(dir, 'lib-verify-drift');
    const wav = fixture('verify-drift.wav', (o) => toneWav(o, -9));
    const { item } = addEntry(root, { file: wav, key: 'bird' });
    const m = readManifest(root);
    m.items[0].duration = item.duration + 5;
    writeManifest(root, m);
    const v = verifyLibrary(root);
    expect(v.problems).toHaveLength(1);
    expect(v.problems[0].issues.join()).toMatch(/时长/);
  });
});

describe('损坏防护', () => {
  it('清单非法 JSON → ManifestCorruptError，且不静默重建', () => {
    const root = path.join(dir, 'lib-corrupt');
    initLibrary(root);
    const p = manifestPath(root);
    fs.writeFileSync(p, '{ broken json!!!', 'utf-8');
    const before = fs.readFileSync(p, 'utf-8');
    expect(() => readManifest(root)).toThrow(ManifestCorruptError);
    expect(() => listEntries(root)).toThrow(ManifestCorruptError);
    expect(() => verifyLibrary(root)).toThrow(ManifestCorruptError);
    expect(fs.readFileSync(p, 'utf-8')).toBe(before); // 字节不变（未重建）
  });

  it('空文件清单 → ManifestCorruptError', () => {
    const root = path.join(dir, 'lib-empty');
    initLibrary(root);
    fs.writeFileSync(manifestPath(root), '', 'utf-8');
    expect(() => readManifest(root)).toThrow(ManifestCorruptError);
  });

  it('清单缺失 → 空清单（不写盘）', () => {
    const root = path.join(dir, 'lib-fresh');
    const m = readManifest(root);
    expect(m.items).toHaveLength(0);
    expect(m.version).toBe(1);
    expect(fs.existsSync(manifestPath(root))).toBe(false);
  });
});
