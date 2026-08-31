/**
 * 红队验收 — 场景 7（SSOT 管理）+ 场景 8（非绘本通用性）+ 场景 12（SSOT 对账漂移）
 * 全部使用隔离库根（LMEDIA_SFX_LIB env / --lib 指向临时目录），绝不触碰 ~/.config/limg 真实库。
 *
 * [2026-08-31 auto-fix #1] 首轮 Tier 0 六处失败同源：lib add 漏传契约必填的 --key
 * （契约规约：`lib add <file> --key <k>`）。经用户确认按「修红队测试补 --key」放行，
 * 实现与契约零改动。
 *
 * 场景7.P1 [det-machine] add 后清单 count+1、新记录含 path/duration/sample_rate/tags/created_at
 *                        全部必备字段、list 行数==清单条数
 * 场景7.P2 [det-machine] remove 后该 key 计数==0 且源音频文件仍存在（negate: 删文件）
 * 场景7.P3 [det-machine] 同一路径重复 add 两次：同 content_hash 条目数==1（幂等）
 * 场景8.P1 [det-machine] 自定义 --library mylib --tags ui-click 入库：
 *                        record.library=="mylib" 且 tags 含 "ui-click" 且
 *                        record.path 以 --lib 指定目录为前缀
 * 场景8.P2 [det-machine] --lib 指向不存在目录首次 add：目录自动创建且 exit 0
 * 场景12.P1 [det-machine] 库内条目音频文件删除后 verify：exit 1 且 stdout 含该 key 的 ✗ 记录
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  readJson,
  runCli,
  runSfxWithLib,
  synthTone,
  tmpDir,
} from './helpers/sfx-utils';

interface LibRecord {
  key?: unknown;
  library?: unknown;
  type?: unknown;
  path?: unknown;
  duration?: unknown;
  sample_rate?: unknown;
  tags?: unknown;
  status?: unknown;
  content_hash?: unknown;
  created_at?: unknown;
}

interface LibIndex {
  version?: unknown;
  items?: LibRecord[];
}

let dir = '';
let doorWav = '';
let dingWav = '';

beforeAll(() => {
  dir = tmpDir('rb-lib-');
  doorWav = synthTone(dir, 'door-close.wav', { amp: 0.4, freq: 220, dur: 0.7 });
  dingWav = synthTone(dir, 'ui-ding.wav', { amp: 0.3, freq: 880, dur: 0.5 });
});

afterAll(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

function libIndexPath(libRoot: string): string {
  return path.join(libRoot, 'index.json');
}

/** 记录必备字段（谓词点名的 5 项 + 库 schema 声明的核心项） */
function expectRecordWellFormed(rec: LibRecord, libRoot: string): void {
  for (const field of ['path', 'duration', 'sample_rate', 'tags', 'created_at'] as const) {
    expect(rec[field]).toBeDefined();
  }
  expect(typeof rec.duration).toBe('number');
  expect(rec.duration as number).toBeGreaterThan(0);
  expect(rec.sample_rate).toBe(44100);
  expect(Array.isArray(rec.tags)).toBe(true);
  expect((rec.tags as unknown[]).length).toBeGreaterThanOrEqual(0);
  expect(typeof rec.created_at).toBe('string');
  expect((rec.created_at as string).length).toBeGreaterThan(0);
  expect(typeof rec.key).toBe('string');
  expect((rec.key as string).length).toBeGreaterThan(0);
  expect(typeof rec.content_hash).toBe('string');
  expect((rec.content_hash as string).length).toBeGreaterThan(0);
  expect(rec.status).toBe('ready');
  // 落盘路径必须在库根之内（SSOT 单一事实源）
  expect(path.resolve(rec.path as string).startsWith(path.resolve(libRoot) + path.sep)).toBe(true);
  expect(fs.existsSync(rec.path as string)).toBe(true);
}

describe('场景7 SSOT 管理', () => {
  test('场景7.P1 add 后清单 count+1、记录字段齐备、list 行数==清单条数', { timeout: 180_000 }, async () => {
    const libRoot = tmpDir('rb-lib-p1-');
    const env = { LMEDIA_SFX_LIB: libRoot };
    try {
      const init = await runCli(['sfx', 'lib', 'init'], { env, timeoutMs: 120_000 });
      expect(init.code).toBe(0);
      expect(fs.existsSync(libIndexPath(libRoot))).toBe(true);
      expect(readJson<LibIndex>(libIndexPath(libRoot)).items?.length).toBe(0);

      const add1 = await runCli(['sfx', 'lib', 'add', doorWav, '--key', 'door-close'], { env, timeoutMs: 120_000 });
      expect(add1.code).toBe(0);
      let items = readJson<LibIndex>(libIndexPath(libRoot)).items ?? [];
      expect(items.length).toBe(1);
      expectRecordWellFormed(items[0], libRoot);

      const add2 = await runCli(['sfx', 'lib', 'add', dingWav, '--key', 'ui-ding'], { env, timeoutMs: 120_000 });
      expect(add2.code).toBe(0);
      items = readJson<LibIndex>(libIndexPath(libRoot)).items ?? [];
      expect(items.length).toBe(2);

      // list 表格行数 == 清单条数（按 key 行匹配计数）
      const list = await runCli(['sfx', 'lib', 'list'], { env, timeoutMs: 120_000 });
      expect(list.code).toBe(0);
      const keys = items.map((i) => i.key as string);
      expect(keys.length).toBe(2);
      const rows = list.stdout.split('\n').filter((l) => keys.some((k) => l.includes(k)));
      expect(rows.length).toBe(items.length);
    } finally {
      fs.rmSync(libRoot, { recursive: true, force: true });
    }
  });

  test('场景7.P2 remove 后该 key 计数==0，且库内落盘音频与源文件都仍在', { timeout: 180_000 }, async () => {
    const libRoot = tmpDir('rb-lib-p2-');
    const env = { LMEDIA_SFX_LIB: libRoot };
    try {
      const add = await runCli(['sfx', 'lib', 'add', doorWav, '--key', 'door-close'], { env, timeoutMs: 120_000 });
      expect(add.code).toBe(0);
      const items = readJson<LibIndex>(libIndexPath(libRoot)).items ?? [];
      expect(items.length).toBe(1);
      const key = items[0].key as string;
      const stored = items[0].path as string;
      expect(fs.existsSync(stored)).toBe(true);

      const rm = await runCli(['sfx', 'lib', 'remove', key], { env, timeoutMs: 120_000 });
      expect(rm.code).toBe(0);

      const after = readJson<LibIndex>(libIndexPath(libRoot)).items ?? [];
      expect(after.filter((i) => i.key === key).length).toBe(0);
      expect(after.length).toBe(0);

      // negate：remove 仅删记录不删文件
      expect(fs.existsSync(stored)).toBe(true);
      expect(fs.existsSync(doorWav)).toBe(true);
    } finally {
      fs.rmSync(libRoot, { recursive: true, force: true });
    }
  });

  test('场景7.P3 同一路径重复 add 两次：同 content_hash 条目数恒为 1（幂等）', { timeout: 180_000 }, async () => {
    const libRoot = tmpDir('rb-lib-p3-');
    const env = { LMEDIA_SFX_LIB: libRoot };
    try {
      const add1 = await runCli(['sfx', 'lib', 'add', dingWav, '--key', 'ui-ding'], { env, timeoutMs: 120_000 });
      expect(add1.code).toBe(0);
      const add2 = await runCli(['sfx', 'lib', 'add', dingWav, '--key', 'ui-ding'], { env, timeoutMs: 120_000 });
      expect(add2.code).toBe(0);

      const items = readJson<LibIndex>(libIndexPath(libRoot)).items ?? [];
      expect(items.length).toBe(1);
      const hashes = items.map((i) => i.content_hash as string);
      expect(new Set(hashes).size).toBe(1);
    } finally {
      fs.rmSync(libRoot, { recursive: true, force: true });
    }
  });
});

describe('场景8 非绘本通用性', () => {
  test('场景8.P1 --library/--tags 自定义入库生效，且落盘路径以 --lib 目录为前缀', { timeout: 180_000 }, async () => {
    const libRoot = tmpDir('rb-lib-mylib-');
    try {
      // 谓词点名使用 --lib 指定目录（CONTRACT_AMBIGUOUS: --lib 挂载层级未声明，按三种位置尝试）
      const res = await runSfxWithLib(['lib', 'add', dingWav, '--key', 'ui-ding', '--library', 'mylib', '--tags', 'ui-click'], libRoot, {
        timeoutMs: 120_000,
      });
      expect(res.code).toBe(0);

      const items = readJson<LibIndex>(libIndexPath(libRoot)).items ?? [];
      expect(items.length).toBe(1);
      const rec = items[0];
      expect(rec.library).toBe('mylib');
      expect(rec.tags as string[]).toContain('ui-click');
      expect(path.resolve(rec.path as string).startsWith(path.resolve(libRoot) + path.sep)).toBe(true);
    } finally {
      fs.rmSync(libRoot, { recursive: true, force: true });
    }
  });

  test('场景8.P2 --lib 指向不存在目录时首次 add 自动建目录且 exit 0', { timeout: 180_000 }, async () => {
    const holder = tmpDir('rb-lib-new-');
    const freshRoot = path.join(holder, 'not-yet-created');
    try {
      expect(fs.existsSync(freshRoot)).toBe(false);
      const res = await runSfxWithLib(['lib', 'add', doorWav, '--key', 'door-close'], freshRoot, { timeoutMs: 120_000 });
      expect(res.code).toBe(0);
      expect(fs.existsSync(freshRoot)).toBe(true);
      expect(fs.existsSync(libIndexPath(freshRoot))).toBe(true);
      expect(readJson<LibIndex>(libIndexPath(freshRoot)).items?.length).toBe(1);
    } finally {
      fs.rmSync(holder, { recursive: true, force: true });
    }
  });
});

describe('场景12 SSOT 对账漂移', () => {
  test('场景12.P1 库内条目音频被删后 verify 报 exit 1 并逐项给出该 key 的 ✗ 记录', { timeout: 180_000 }, async () => {
    const libRoot = tmpDir('rb-lib-drift-');
    const env = { LMEDIA_SFX_LIB: libRoot };
    try {
      const add = await runCli(['sfx', 'lib', 'add', doorWav, '--key', 'door-close'], { env, timeoutMs: 120_000 });
      expect(add.code).toBe(0);
      const items = readJson<LibIndex>(libIndexPath(libRoot)).items ?? [];
      expect(items.length).toBe(1);
      const key = items[0].key as string;
      const stored = path.resolve(items[0].path as string);
      expect(fs.existsSync(stored)).toBe(true);

      // 制造漂移：删掉库内条目音频
      fs.rmSync(stored);
      expect(fs.existsSync(stored)).toBe(false);

      const verify = await runCli(['sfx', 'lib', 'verify'], { env, timeoutMs: 120_000 });
      expect(verify.code).toBe(1);
      const flagged = verify.stdout.split('\n').find((l) => l.includes('✗') && l.includes(key));
      expect(flagged).toBeDefined();
    } finally {
      fs.rmSync(libRoot, { recursive: true, force: true });
    }
  });
});
