/**
 * 红队验收 — 场景 11（ab 可用性）
 *
 * 场景11.P1 [det-machine] 1 组 2 候选生成 ab 页：exit 0 且 html count("<audio") >= 2
 *                         且含 2 个候选名且不含绝对路径引用
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { runCli, synthTone, tmpDir, type CliResult } from './helpers/sfx-utils';

let dir = '';
let candA = '';
let candB = '';

beforeAll(() => {
  dir = tmpDir('rb-ab-');
  candA = synthTone(dir, 'cand-alpha.wav', { amp: 0.4, freq: 330, dur: 0.9 });
  candB = synthTone(dir, 'cand-beta.wav', { amp: 0.4, freq: 550, dur: 0.9 });
});

afterAll(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

describe('场景11 ab 可用性', () => {
  test('场景11.P1 1 组 2 候选生成 ab 试听页：≥2 个 <audio>、含候选名、无绝对路径引用', { timeout: 120_000 }, async () => {
    const htmlPath = path.join(dir, 'ab.html');
    const groupsFile = path.join(dir, 'groups.json');

    // CONTRACT_AMBIGUOUS: groups.json 的字段命名未在契约中固化（name/key/label ×
 // candidates/items × 字符串路径或对象），按常见形态依次尝试；
 // 全部失败则由下方硬断言挂掉，不做任何宽容跳过。
    const variants: unknown[] = [
      [{ name: 'group-1', candidates: [candA, candB] }],
      [{
        key: 'group-1',
        candidates: [
          { path: candA, label: 'A' },
          { path: candB, label: 'B' },
        ],
      }],
      [{ label: 'group-1', items: [candA, candB] }],
      { groups: [{ name: 'group-1', candidates: [candA, candB] }] },
    ];

    let res: CliResult | null = null;
    let used: unknown[] | null = null;
    for (const variant of variants) {
      fs.writeFileSync(groupsFile, JSON.stringify(variant, null, 2));
      const r = await runCli(['sfx', 'ab', '-m', groupsFile, '-o', htmlPath], { timeoutMs: 110_000 });
      if (r.code === 0 && fs.existsSync(htmlPath)) {
        res = r;
        used = variant as unknown[];
        break;
      }
      res = r;
    }
    expect(res).not.toBeNull();
    expect(res?.code).toBe(0);
    expect(used).not.toBeNull();
    expect(fs.existsSync(htmlPath)).toBe(true);

    const html = fs.readFileSync(htmlPath, 'utf-8');
    expect(html.length).toBeGreaterThan(0);

    const audioTags = html.match(/<audio/g) ?? [];
    expect(audioTags.length).toBeGreaterThanOrEqual(2);

    // 两个候选名都必须出现（人耳可分辨谁是谁）
    expect(html).toContain('cand-alpha');
    expect(html).toContain('cand-beta');

    // negate：不得用绝对路径引用候选音频（设计要求相对路径引用）
    expect(/(?:src|href)\s*=\s*["']\//.test(html)).toBe(false);
  });
});
