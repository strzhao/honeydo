/** h3 python 脚本单测：run-python 协议（单行 JSON）/ stderr 阶段标记 / mock PNG 合法性 / 条目级失败隔离 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENCODE = path.join(PKG, 'python', 'h3_encode.py');
const GENERATE = path.join(PKG, 'python', 'h3_generate.py');

let dir = '';
let work = '';

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'h3-python-'));
  work = path.join(dir, 'work');
  fs.mkdirSync(work, { recursive: true });
});

afterAll(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

function py(script: string, payload: unknown): { status: number; stdout: string; stderr: string } {
  const r = spawnSync('python3', [script, JSON.stringify(payload)], { encoding: 'utf-8' });
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function lastLineJson(stdout: string): Record<string, unknown> {
  const lines = stdout.trim().split('\n').filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}

describe('h3_encode.py（mock）', () => {
  it('协议：stdout 末行单行 JSON；stderr 带 [h3:encode] 标记；.pt/.encode.json 落盘', () => {
    const r = py(ENCODE, {
      runtime: dir,
      work,
      mock: true,
      prompt_refs: [{ prompt: '一只鹤立于浅滩', images: [] }],
    });
    expect(r.status).toBe(0);
    const res = lastLineJson(r.stdout);
    expect(res.failed).toBe(0);
    const items = res.items as { index: number; pt: string; embeds_shape: number[] }[];
    expect(items.length).toBe(1);
    expect(items[0].index).toBe(0);
    expect(fs.existsSync(items[0].pt)).toBe(true);
    expect(fs.existsSync(path.join(work, '0.encode.json'))).toBe(true);
    expect(r.stderr).toContain('[h3:encode]');
    // 单行 compact JSON（内部无换行）
    const last = r.stdout.trim().split('\n').pop()!;
    expect(last).not.toContain('\n');
    expect(last).toBe(JSON.stringify(JSON.parse(last)));
  });

  it('多条目 index 对位落盘（batch 时序：encode 一次全量）', () => {
    const r = py(ENCODE, {
      runtime: dir,
      work,
      mock: true,
      prompt_refs: [
        { prompt: 'a', images: [] },
        { prompt: 'b', images: [path.join(PKG, 'assets', 'h3-chars', 'pipi', 'ref-official.png')] },
      ],
    });
    expect(r.status).toBe(0);
    const items = (lastLineJson(r.stdout).items as { index: number; pt: string }[]);
    expect(items.map((i) => i.index)).toEqual([0, 1]);
    expect(fs.existsSync(path.join(work, '1.pt'))).toBe(true);
  });
});

describe('h3_generate.py（mock）', () => {
  it('draft：2048x1152 合法 PNG；stderr [h3:denoise]；输出无临时文件残留', () => {
    const out = path.join(dir, 'draft.png');
    const r = py(GENERATE, {
      runtime: dir,
      work,
      mock: true,
      items: [{ index: 0, seed: 42, size: '2048x1152', quality: 'draft', out }],
    });
    expect(r.status).toBe(0);
    const res = lastLineJson(r.stdout);
    const item = (res.items as { index: number; out: string; resolution: string }[])[0];
    expect(item.resolution).toBe('2048x1152');
    expect(item.out).toBe(out);
    expect(r.stderr).toContain('[h3:denoise]');
    const head = fs.readFileSync(out).subarray(0, 8);
    expect(head.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);
    const dims = fs.readFileSync(out).subarray(16, 24);
    expect(dims.readUInt32BE(0)).toBe(2048);
    expect(dims.readUInt32BE(4)).toBe(1152);
    expect(fs.readdirSync(dir).filter((f) => f.includes('.tmp')).length).toBe(0);
  });

  it('publish：最终名义尺寸 2736x1536（缩回后），resolution 回显一致', () => {
    const out = path.join(dir, 'pub.png');
    const r = py(GENERATE, {
      runtime: dir,
      work,
      mock: true,
      items: [{ index: 0, seed: 7, size: '5472x3072', quality: 'publish', out }],
    });
    expect(r.status).toBe(0);
    const item = (lastLineJson(r.stdout).items as { resolution: string }[])[0];
    expect(item.resolution).toBe('2736x1536');
    const dims = fs.readFileSync(out).subarray(16, 24);
    expect(dims.readUInt32BE(0)).toBe(2736);
    expect(dims.readUInt32BE(4)).toBe(1536);
  });

  it('encode.pt 缺失 → 条目失败隔离：exit 1 + failed:1 + error 非空，不中断其余', () => {
    const emptyWork = path.join(dir, 'empty-work');
    fs.mkdirSync(emptyWork, { recursive: true });
    const okOut = path.join(dir, 'ok.png');
    const badOut = path.join(dir, 'bad.png');
    // 0 有 .pt，1 没有 → 单条失败不中断
    fs.writeFileSync(path.join(emptyWork, '0.pt'), '{}');
    const r = py(GENERATE, {
      runtime: dir,
      work: emptyWork,
      mock: true,
      items: [
        { index: 0, seed: 1, size: '2048x1152', quality: 'draft', out: okOut },
        { index: 1, seed: 2, size: '2048x1152', quality: 'draft', out: badOut },
      ],
    });
    expect(r.status).toBe(1);
    const res = lastLineJson(r.stdout);
    expect(res.failed).toBe(1);
    const items = res.items as { index: number; failed?: boolean; error?: string }[];
    expect(items[0].failed).toBeUndefined();
    expect(fs.existsSync(okOut)).toBe(true);
    expect(items[1].failed).toBe(true);
    expect(items[1].error).toBeTruthy();
    expect(fs.existsSync(badOut)).toBe(false); // 失败条目无输出文件
  });

  it('未知 quality → 条目失败（failed + reason）', () => {
    const r = py(GENERATE, {
      runtime: dir,
      work,
      mock: true,
      items: [{ index: 0, seed: 1, size: '2048x1152', quality: 'ultra', out: path.join(dir, 'u.png') }],
    });
    expect(r.status).toBe(1);
    const item = (lastLineJson(r.stdout).items as { failed?: boolean }[])[0];
    expect(item.failed).toBe(true);
  });
});
