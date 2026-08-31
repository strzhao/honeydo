/**
 * 红队验收 — 场景 9（错误处理）
 *
 * 场景9.P1 [det-machine] batch -m 文件不存在（exit 2）/ 存在但空或非法 JSON（exit 1）
 *                        均非零退出、stderr 非空、清单不被写入（sha256 不变，negate）
 * 场景9.P2 [det-machine] 非法数值参数（--rolls 0 / -3 / abc）非零退出且输出目录文件数不变
 * 场景9.P3 [det-machine] 库清单被破坏为非法 JSON 后任一清单操作：非零退出、
 *                        错误输出含解析/损坏关键字、清单原始字节不变（negate: 静默重建）
 *
 * 分域铁律（设计文档）：文件不存在=2；文件存在但内容坏（空/非法 JSON）=1。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { runCli, sha256File, synthTone, tmpDir } from './helpers/sfx-utils';

let dir = '';
let manifestPath = '';

beforeAll(() => {
  dir = tmpDir('rb-errors-');
  // 合法清单（供参数非法场景使用，确保失败只可能来自参数而非清单）
  manifestPath = path.join(dir, 'manifest.json');
  fs.writeFileSync(
    manifestPath,
    JSON.stringify([{ key: 'bear', prompt: 'low bear growl, close perspective' }], null, 2),
  );
  // 音频 fixture（供清单操作使用）
  synthTone(dir, 'ui-ding.wav', { amp: 0.3, freq: 880, dur: 0.5 });
});

afterAll(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

function emptyOutDir(name: string): string {
  const d = path.join(dir, name);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function fileCount(d: string): number {
  return fs.existsSync(d) ? fs.readdirSync(d).length : -1;
}

describe('场景9 错误处理', () => {
  test('场景9.P1 batch 清单不存在=2，空/非法 JSON=1，stderr 可读且清单不被写入', { timeout: 180_000 }, async () => {
    // —— 用例 A：清单文件不存在 → exit 2（文件不存在域）——
    const missing = path.join(dir, 'no-such-manifest.json');
    const outA = emptyOutDir('out-missing');
    expect(fs.existsSync(missing)).toBe(false);
    const resA = await runCli(['sfx', 'batch', '-m', missing, '-o', outA], { timeoutMs: 170_000 });
    expect(resA.code).toBe(2);
    expect(resA.stderr.trim().length).toBeGreaterThan(0);
    // negate：不得把清单写出来
    expect(fs.existsSync(missing)).toBe(false);
    expect(fileCount(outA)).toBe(0);

    // —— 用例 B：清单存在但非法 JSON → exit 1（内容坏域）——
    const broken = path.join(dir, 'broken.json');
    fs.writeFileSync(broken, '{"items": [ {"key": "bear", ');
    const beforeBroken = sha256File(broken);
    const outB = emptyOutDir('out-broken');
    const resB = await runCli(['sfx', 'batch', '-m', broken, '-o', outB], { timeoutMs: 170_000 });
    expect(resB.code).toBe(1);
    expect(resB.stderr.trim().length).toBeGreaterThan(0);
    expect(sha256File(broken)).toBe(beforeBroken);
    expect(fileCount(outB)).toBe(0);

    // —— 用例 C：清单存在但为空文件 → exit 1（内容坏域）——
    const empty = path.join(dir, 'empty.json');
    fs.writeFileSync(empty, '');
    const beforeEmpty = sha256File(empty);
    const outC = emptyOutDir('out-empty');
    const resC = await runCli(['sfx', 'batch', '-m', empty, '-o', outC], { timeoutMs: 170_000 });
    expect(resC.code).toBe(1);
    expect(resC.stderr.trim().length).toBeGreaterThan(0);
    expect(sha256File(empty)).toBe(beforeEmpty);
    expect(fileCount(outC)).toBe(0);

    // 任一失败路径都不得产出 batch 结果
    for (const d of [outA, outB, outC]) {
      expect(fs.existsSync(path.join(d, 'report.json'))).toBe(false);
    }
  });

  test('场景9.P2 非法 --rolls（0 / -3 / abc）非零退出且输出目录文件数不变', { timeout: 240_000 }, async () => {
    for (const bad of ['0', '-3', 'abc']) {
      const out = emptyOutDir(`out-rolls-${bad.replace('-', 'neg')}`);
      const before = fileCount(out);
      const res = await runCli(['sfx', 'batch', '-m', manifestPath, '-o', out, '--rolls', bad], {
        timeoutMs: 230_000,
      });
      expect(res.code).not.toBe(0);
      expect(res.all.trim().length).toBeGreaterThan(0);
      expect(fileCount(out)).toBe(before);
      expect(fileCount(out)).toBe(0);
    }
  });

  test('场景9.P3 库清单损坏后清单操作非零退出、报解析/损坏、原始字节不变', { timeout: 180_000 }, async () => {
    const libRoot = tmpDir('rb-lib-corrupt-');
    const index = path.join(libRoot, 'index.json');
    try {
      fs.mkdirSync(libRoot, { recursive: true });
      fs.writeFileSync(index, '{"version": 1, "items": [ {"key": "door-close", ');
      const before = fs.readFileSync(index);

      for (const op of ['list', 'verify']) {
        const res = await runCli(['sfx', 'lib', op], {
          env: { LMEDIA_SFX_LIB: libRoot },
          timeoutMs: 170_000,
        });
        expect(res.code).not.toBe(0);
        expect(res.all).toMatch(/解析|损坏/);
        // negate：禁止静默重建清单
        expect(fs.readFileSync(index).equals(before)).toBe(true);
      }
    } finally {
      fs.rmSync(libRoot, { recursive: true, force: true });
    }
  });
});
