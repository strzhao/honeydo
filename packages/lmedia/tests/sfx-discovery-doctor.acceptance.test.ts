/**
 * 红队验收 — 场景 2（能力发现）+ 场景 3（音频栈自检）
 *
 * 场景2.P1 [det-machine]  `lmedia --help` exit 0 且 stdout 含 `sfx`
 * 场景2.P2 [det-machine]  `lmedia sfx --help` exit 0 且暴露
 *                         生成/质量/剪裁/归一化/清单 五类动作词中 ≥3 类
 * 场景3.P1 [det-machine]  环境就绪时 `lmedia sfx doctor` exit 0 且
 *                         venv/模型缓存两项各给通过标记
 * 场景3.P2 [det-machine]  HF_HUB_CACHE=空目录 时 exit 1 或 缓存项≠通过，
 *                         且输出含缺失/指引关键字；不得出现「全部就绪」
 */
import * as fs from 'node:fs';
import { describe, expect, test } from 'vitest';
import { audioEnvReady, runCli, tmpDir } from './helpers/sfx-utils';

/** 场景3.P1 的谓词前置条件是「环境就绪」——门控的是前置条件本身，门内断言全部硬断言 */
const ENV_READY = audioEnvReady();

describe('场景2 能力发现', () => {
  test('场景2.P1 顶层 help 暴露 sfx 能力域', { timeout: 60_000 }, async () => {
    const res = await runCli(['--help'], { timeoutMs: 50_000 });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('sfx');
  });

  test('场景2.P2 sfx help 暴露 ≥3 类动作词（生成/质量/剪裁/归一化/清单）', { timeout: 60_000 }, async () => {
    const res = await runCli(['sfx', '--help'], { timeoutMs: 50_000 });
    expect(res.code).toBe(0);

    // 五类动作词 → 具体动作名（子命令名即契约，逐字取自设计文档子命令面）
    const categories: Array<[string, RegExp]> = [
      ['生成', /\bgen\b|\bbatch\b/],
      ['质量', /\baccept\b/],
      ['剪裁', /\btrim\b|\brecut\b/],
      ['归一化', /\bnormalize\b/],
      ['清单', /\blib\b/],
    ];
    const exposed = categories.filter(([, re]) => re.test(res.stdout)).map(([name]) => name);
    expect(exposed.length).toBeGreaterThanOrEqual(3);
  });
});

describe('场景3 音频栈自检', () => {
  test.skipIf(!ENV_READY)(
    '场景3.P1 环境就绪时 sfx doctor 全过并给出通过标记',
    { timeout: 120_000 },
    async () => {
      const res = await runCli(['sfx', 'doctor'], { timeoutMs: 110_000 });
      expect(res.code).toBe(0);
      const passMarks = (res.stdout.match(/✓/g) ?? []).length;
      expect(passMarks).toBeGreaterThanOrEqual(2); // venv + 模型缓存 两项各有通过标记
      expect(res.stdout).toMatch(/venv/i);
      expect(res.stdout).toMatch(/模型|缓存|model/i);
    },
  );

  test('场景3.P2 空 HF 缓存注入 → 失败信号 + 缺失/指引关键字，且不得宣称全部就绪', { timeout: 120_000 }, async () => {
    const emptyHub = tmpDir('rb-empty-hub-');
    try {
      const res = await runCli(['sfx', 'doctor'], {
        env: { HF_HUB_CACHE: emptyHub },
        timeoutMs: 110_000,
      });
      // 谓词允许两种形态：exit 1，或 exit 0 但缓存项非通过标记（硬断言二选一成立）
      const cacheLines = res.all.split('\n').filter((l) => /缓存|模型|model|hub|Dasheng/i.test(l));
      const cachePass = cacheLines.some((l) => l.includes('✓'));
      expect(res.code === 1 || !cachePass).toBe(true);

      // 含缺失/指引关键字（仓库惯例错误走 stderr，故在 stdout∪stderr 上匹配）
      // CONTRACT_AMBIGUOUS: 谓词写"stdout 含"，而设计文档 stdout 契约又写"错误 stderr 中文可读" —— 取并集
      expect(res.all).toMatch(/缺失|未找到|不存在|未下载|缺少|请运行|指引|安装|setup/i);
      // negate: 不得出现「全部就绪」
      expect(res.stdout).not.toMatch(/全部就绪/);
    } finally {
      fs.rmSync(emptyHub, { recursive: true, force: true });
    }
  });
});
