/**
 * 红队验收 — 场景 4（质量门审计 + 劣质拦截）
 *
 * 场景4.P1 [det-machine] 存在含多候选分数的 report.json 时：
 *                        每 prompt winner.score ≥ max(被淘汰候选 score)
 *                        且每个被淘汰候选 reason 非空
 *                        （driver: 纯 Node 解析 report JSON，fixture 自造、无模型；
 *                          同一裁决函数也被场景 1 真实推理冒烟复用）
 * 场景4.P2 [det-machine] 对静音/削波 fixture 跑 accept：
 *                        非通过记录 ≥1（行尾 status=fail 或 ✗ 行），
 *                        且不触碰任何清单（sha256 前后一致）
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  auditReport,
  Fixtures,
  readJson,
  runCli,
  sha256File,
  synthFixtures,
  tmpDir,
} from './helpers/sfx-utils';

let dir = '';
let fx: Fixtures;

beforeAll(() => {
  dir = tmpDir('rb-quality-');
  fx = synthFixtures(dir);
});

afterAll(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

describe('场景4 质量门审计 + 劣质拦截', () => {
  test('场景4.P1 多候选 report.json：winner 分数支配被淘汰候选，且淘汰必附理由', { timeout: 30_000 }, () => {
    // fixture 自造（谓词声明允许，无模型）：两个 prompt，一个有合格掷样、一个全废
    const reportPath = path.join(dir, 'report.fixture.json');
    const roll = (n: number, key: string) => path.join(dir, `${key}.roll${n}.wav`);
    const report = {
      generatedAt: '2026-08-31T00:00:00.000Z',
      rolls: 3,
      items: [
        {
          key: 'bear',
          prompt: 'low bear growl, close perspective',
          // 注意：淘汰候选分数走 peak 口径、合格候选走 snr 口径（与设计文档同源规则）
          candidates: [
            { roll: 1, path: roll(1, 'bear'), peak: -8.2, snr: 18.4, pass: true },
            { roll: 2, path: roll(2, 'bear'), peak: -30.1, pass: false, reason: 'peak -30.1dBFS 低于质量门 -25dBFS' },
            { roll: 3, path: roll(3, 'bear'), peak: -5.0, pass: false, reason: '近削波 max -5.0dBFS' },
            { roll: 4, path: roll(4, 'bear'), peak: -14.7, snr: 22.1, pass: true },
          ],
          winner: { path: path.join(dir, 'bear.best.wav'), score: 22.1 },
          anyPass: true,
          genSec: 34.2,
        },
        {
          key: 'wind',
          prompt: 'cold wind gust, outdoor ambience',
          candidates: [
            { roll: 1, path: roll(1, 'wind'), peak: -28.0, pass: false, reason: 'peak 低于质量门' },
            { roll: 2, path: roll(2, 'wind'), peak: -19.0, pass: false, reason: 'peak 低于质量门' },
          ],
          winner: { path: path.join(dir, 'wind.best.wav'), score: -19.0 }, // 全废取 peak
          anyPass: false,
          genSec: 31.0,
        },
      ],
    };
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

    const parsed = readJson(reportPath);
    // 前提：确实是「含多候选分数」的 report
    const items = (parsed as { items: Array<{ candidates: unknown[] }> }).items;
    expect(items.length).toBe(2);
    for (const it of items) expect(it.candidates.length).toBeGreaterThanOrEqual(2);

    // 权威谓词：winner.score ≥ max(被淘汰候选 score)，且被淘汰候选 reason 非空
    const violations = auditReport(parsed);
    expect(violations).toEqual([]);

    // 反向对照（证明裁决函数不是恒真）：把 winner 改成输家、理由清空后必须能抓出来
    const broken = JSON.parse(JSON.stringify(report)) as typeof report;
    broken.items[0].winner = { path: roll(2, 'bear'), score: -60.0 };
    (broken.items[0].candidates as Array<{ reason?: string }>)[1].reason = '   ';
    const brokenViolations = auditReport(broken);
    expect(brokenViolations.length).toBeGreaterThanOrEqual(2);
    expect(brokenViolations.join('\n')).toMatch(/winner\.score/);
    expect(brokenViolations.join('\n')).toMatch(/reason/);
  });

  test('场景4.P2 accept 对静音/削波产物给出非通过记录，且不触碰 SSOT 清单', { timeout: 180_000 }, async () => {
    // 隔离库根：谓词要求 accept 不得触碰任何清单（用契约内的 lib init 生成合法空清单）
    const libRoot = tmpDir('rb-lib-accept-');
    const index = path.join(libRoot, 'index.json');

    try {
      const init = await runCli(['sfx', 'lib', 'init'], { env: { LMEDIA_SFX_LIB: libRoot }, timeoutMs: 120_000 });
      expect(init.code).toBe(0);
      expect(fs.existsSync(index)).toBe(true);
      expect(readJson<{ items?: unknown[] }>(index).items?.length).toBe(0);
      const before = sha256File(index);

      const res = await runCli(['sfx', 'accept', fx.allSilence, fx.clipping], {
        env: { LMEDIA_SFX_LIB: libRoot },
        timeoutMs: 170_000,
      });

      // 设计文档退出码契约：accept 有 flag → 1
      expect(res.code).toBe(1);

      // 非通过记录 ≥1：行尾机读 token status=fail 或 ✗ 行
      const nonPass = res.stdout
        .split('\n')
        .filter((l) => /status=fail/.test(l) || l.includes('✗'));
      expect(nonPass.length).toBeGreaterThanOrEqual(1);
      // 证明处理的是我们传入的产物，而非空转报错
      expect(res.all).toContain(path.basename(fx.clipping));
      expect(res.all).toContain(path.basename(fx.allSilence));

      // negate：不得触碰清单（字节级一致）
      expect(fs.existsSync(index)).toBe(true);
      expect(sha256File(index)).toBe(before);
      expect(readJson<{ items: unknown[] }>(index).items.length).toBe(0);
    } finally {
      fs.rmSync(libRoot, { recursive: true, force: true });
    }
  });
});
