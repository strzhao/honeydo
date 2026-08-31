/**
 * 红队验收 — 场景 1（真实模型推理冒烟，real-process）
 *
 * // REAL_PROCESS: QA 编排器以 LMEDIA_SMOKE=1 运行（设计文档验证方案声明）
 *
 * 未设置 LMEDIA_SMOKE=1 时整个文件跳过（跳的是"真实推理预算"，不是断言；
 * 门内每条断言均为硬断言，失败必挂）。
 *
 * 覆盖断言：
 *   - `sfx batch -m <2 prompts> -o <dir> --rolls 2` exit 0
 *   - 每个 prompt ≥1 个 `<key>.best.wav` 落盘且 RIFF 头有效
 *   - 每个产物时长 0.2 ≤ d ≤ 30 秒
 *   - report.json 存在且每项 candidates ≥ 2
 *   - winner.path 形如 `<dir>/<key>.best.wav` 且磁盘存在
 *   - winner.score ≥ 其余候选（复用场景 4.P1 的裁决函数）
 *   - stdout 结尾汇总 JSON（{dir, report, items, genSec}）可解析且字段齐备
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  auditReport,
  CLI_ENTRY,
  probeDuration,
  readJson,
  runCli,
  tmpDir,
  wavInfo,
} from './helpers/sfx-utils';

// REAL_PROCESS: QA 编排器以 LMEDIA_SMOKE=1 运行（设计文档验证方案声明）
const RUN = process.env.LMEDIA_SMOKE === '1';

interface BatchItem {
  key?: unknown;
  candidates?: unknown;
  winner?: { path?: unknown; score?: unknown };
  anyPass?: unknown;
  genSec?: unknown;
}

let dir = '';
let manifest = '';

beforeAll(() => {
  dir = tmpDir('rb-smoke-');
  manifest = path.join(dir, 'manifest.json');
  fs.writeFileSync(
    manifest,
    JSON.stringify(
      [
        { key: 'smoke-thunder', prompt: 'distant thunder rumble rolling across a valley' },
        { key: 'smoke-knock', prompt: 'three knocks on a wooden door' },
      ],
      null,
      2,
    ),
  );
});

afterAll(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!RUN)('场景1 真实模型推理冒烟（LMEDIA_SMOKE=1）', () => {
  test(
    '场景1.P1 batch 两 prompt × 2 掷：exit 0，逐 key 落盘 best 产物，report 多候选且 winner 支配',
    { timeout: 600_000 },
    async () => {
      const outDir = path.join(dir, 'batch-out');
      const res = await runCli(['sfx', 'batch', '-m', manifest, '-o', outDir, '--rolls', '2'], {
        timeoutMs: 590_000,
      });
      expect(res.code).toBe(0);

      // stdout 汇总 JSON：{dir, report, items:[{key, winner, anyPass}], genSec}
      // [2026-08-31 auto-fix #2] 契约声明「对齐 image/video 既有约定」= pretty 多行 JSON，
      // 解析改为整段优先、逐行兜底（断言机制错经用户确认放行，实现零改动）
      let summary: Record<string, unknown> | undefined;
      try {
        const whole = JSON.parse(res.stdout) as Record<string, unknown>;
        if (whole && 'items' in whole && 'dir' in whole) summary = whole;
      } catch { /* 非 single-JSON，走逐行兜底 */ }
      if (!summary) {
        const lines = res.stdout.trim().split('\n').filter((l) => l.trim().startsWith('{'));
        summary = lines
          .reverse()
          .map((l) => {
            try { return JSON.parse(l) as Record<string, unknown>; } catch { return null; }
          })
          .find((o): o is Record<string, unknown> => !!o && 'items' in o && 'dir' in o);
      }
      expect(summary).toBeDefined();
      expect(path.resolve(String(summary?.dir))).toBe(path.resolve(outDir));
      expect(Number(summary?.genSec)).toBeGreaterThan(0);
      expect(Array.isArray(summary?.items)).toBe(true);
      expect((summary?.items as unknown[]).length).toBe(2);

      // report.json 契约
      const reportPath = path.join(outDir, 'report.json');
      expect(fs.existsSync(reportPath)).toBe(true);
      const report = readJson<{ items?: BatchItem[] }>(reportPath);
      const items = report.items ?? [];
      expect(items.length).toBe(2);

      for (const item of items) {
        const key = String(item.key);
        expect(key).toMatch(/^[a-z0-9-]+$/);

        // 每个候选的掷样记录 ≥2（rolls=2）
        const cands = (item.candidates as unknown[] | undefined) ?? [];
        expect(cands.length).toBeGreaterThanOrEqual(2);

        // winner 产物：<dir>/<key>.best.wav，且磁盘存在、RIFF 有效、时长在界内
        const bestPath = path.join(outDir, `${key}.best.wav`);
        expect(fs.existsSync(bestPath)).toBe(true);
        expect(String(item.winner?.path)).toBe(bestPath);

        const info = wavInfo(bestPath);
        expect(info.isRiff).toBe(true);
        expect(info.isWave).toBe(true);
        const dur = probeDuration(bestPath);
        expect(dur).toBeGreaterThanOrEqual(0.2);
        expect(dur).toBeLessThanOrEqual(30);

        expect(typeof item.winner?.score).toBe('number');
        expect(typeof item.anyPass).toBe('boolean');
        expect(Number(item.genSec)).toBeGreaterThan(0);
      }

      // 质量门审计：winner.score ≥ max(被淘汰候选 score)，淘汰必附理由
      expect(auditReport(report)).toEqual([]);
    },
  );

  test('场景1 附带：driver 前提自检（CLI 入口 src/index.ts 存在）', { timeout: 60_000 }, async () => {
    // 冒烟文件自身的 driver 前提：CLI_ENTRY 必须真实存在（防止路径漂移导致假通过/假失败）
    expect(fs.existsSync(CLI_ENTRY)).toBe(true);
    expect(CLI_ENTRY.endsWith('src/index.ts')).toBe(true);
  });
});
