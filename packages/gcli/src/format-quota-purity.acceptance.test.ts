import { describe, expect, it } from "vitest";
import { formatQuota } from "./cli.js";

// ============================================================================
// 红队验收 — 契约规约 4「formatQuota 纯文本输出逐字节不变」（P5 支撑）
//
// 断言独立推导自 state.md ## 契约规约 4 + context.md 相关历史知识
// （现有单测锁定的字面量 "5h:42% wk:17% ↻2h13m" 等），零实现代码读取。
//
// 本文件在改动前基线即为绿：既是 harness 可执行性证明，也是
// 「formatQuota 重构为 quotaParts 拼接」的回归金丝雀——重构后任何
// 逐字节漂移（含混入 ANSI）在此挂掉。
// ============================================================================

const NOW = Date.parse("2026-08-30T12:00:00Z");
const at = (offsetMin: number): string =>
  new Date(NOW + offsetMin * 60_000).toISOString();

describe("formatQuota 无色纯文本 // 契约 4（P5 支撑）", () => {
  it("双窗/单短窗/单周窗/过期 reset/空 的字面量逐字节不变", () => {
    expect(
      formatQuota(
        {
          short: { pct: 42, resetIso: at(133) },
          weekly: { pct: 17, resetIso: at(3000) },
        },
        NOW,
      ),
    ).toBe("5h:42% wk:17% ↻2h13m");
    expect(formatQuota({ short: { pct: 7, resetIso: at(240) } }, NOW)).toBe(
      "5h:7% ↻4h",
    );
    expect(formatQuota({ weekly: { pct: 17, resetIso: at(90) } }, NOW)).toBe(
      "wk:17% ↻1h30m",
    );
    expect(formatQuota({ short: { pct: 1, resetIso: at(-5) } }, NOW)).toBe(
      "5h:1%",
    );
    expect(formatQuota({}, NOW)).toBe("");
  });

  it("任何输入形态的输出都不含 ANSI 转义（染色只允许走 colorQuota 新面）", () => {
    const samples = [
      {
        short: { pct: 91, resetIso: at(133) },
        weekly: { pct: 75, resetIso: at(3000) },
      },
      { short: { pct: 4, resetIso: at(30) } },
      { weekly: { pct: 60, resetIso: at(1440) } },
      {},
    ];
    for (const q of samples) {
      expect(formatQuota(q, NOW)).not.toContain("\x1b");
    }
  });
});
