import { describe, expect, it } from "vitest";
import {
  colorQuota,
  formatQuota,
  levelColor,
  QUOTA_HIGH,
  QUOTA_MID,
} from "./cli.js";

// ============================================================================
// 红队验收 — P1 染色阈值 / P2 独立判定（预注册谓词 SSOT）
//
// 断言独立推导自 state.md ## 设计文档「视觉规格 3」与 ## 验收场景 P1/P2，
// 零实现代码读取。P1 observe 即「node 驱动 dist 导出函数」→ 设计预期
// colorQuota / levelColor / QUOTA_HIGH / QUOTA_MID 为可导出面；本文件
// 以同构的 src 导入驱动（vitest acceptance 惯例）。
//
// 设计声明（视觉规格 3，逐字依据）：
//   QUOTA_HIGH = 85 / QUOTA_MID = 60（对齐 statusline-sage）
//   levelColor(pct)：pct ≥ 85 → 朱红 #D94F3D；pct ≥ 60 → 琥珀 #D4920A；
//                    else / 非有限数 → 苔绿 #3A7D68
//   每个窗口独立判定（5h: 与 wk: 各自选色）；↻<rel> 段恒 dim 不参与染色
// ============================================================================

const RED = "\x1b[38;2;217;79;61m"; // 朱红 #D94F3D
const AMBER = "\x1b[38;2;212;146;10m"; // 琥珀 #D4920A
const GREEN = "\x1b[38;2;58;125;104m"; // 苔绿 #3A7D68
const DIM = "\x1b[2m";

const NOW = Date.parse("2026-09-18T00:00:00Z");
const FUTURE_SHORT = "2026-09-18T02:13:00Z"; // NOW + 2h13m
const FUTURE_WEEK = "2026-09-25T00:00:00Z";

describe("P1 染色阈值 // colorQuota / levelColor", () => {
  it("谓词逐字：pct 91 → 朱红 / 75 → 琥珀 / 4 → 苔绿（substring 匹配）", () => {
    expect(
      colorQuota({ short: { pct: 91, resetIso: FUTURE_SHORT } }, NOW),
    ).toContain(RED);
    expect(
      colorQuota({ short: { pct: 75, resetIso: FUTURE_SHORT } }, NOW),
    ).toContain(AMBER);
    expect(
      colorQuota({ short: { pct: 4, resetIso: FUTURE_SHORT } }, NOW),
    ).toContain(GREEN);
  });

  it("阈值常量逐字 + 边界 59/60/84/85（≥85 红 / ≥60 琥珀 / else 苔绿）", () => {
    expect(QUOTA_HIGH).toBe(85);
    expect(QUOTA_MID).toBe(60);
    expect(levelColor(85)).toBe(RED);
    expect(levelColor(84)).toBe(AMBER);
    expect(levelColor(60)).toBe(AMBER);
    expect(levelColor(59)).toBe(GREEN);
  });

  it("非有限数 → 苔绿（设计明文 else/非有限数 分支：NaN / +Infinity）", () => {
    expect(levelColor(Number.NaN)).toBe(GREEN);
    expect(levelColor(Number.POSITIVE_INFINITY)).toBe(GREEN);
    expect(
      colorQuota({ short: { pct: Number.NaN, resetIso: FUTURE_SHORT } }, NOW),
    ).toContain(GREEN);
  });

  it("染色不破坏可见文本：5h:/wk:/↻ 段与 formatQuota 同构且次序不变", () => {
    const plain = formatQuota(
      {
        short: { pct: 91, resetIso: FUTURE_SHORT },
        weekly: { pct: 4, resetIso: FUTURE_WEEK },
      },
      NOW,
    );
    const out = colorQuota(
      {
        short: { pct: 91, resetIso: FUTURE_SHORT },
        weekly: { pct: 4, resetIso: FUTURE_WEEK },
      },
      NOW,
    );
    expect(out).toContain("5h:91%");
    expect(out).toContain("wk:4%");
    expect(out).toContain("↻2h13m");
    for (const seg of ["5h:91%", "wk:4%", "↻2h13m"]) {
      expect(plain).toContain(seg);
      expect(out.indexOf(seg)).toBeGreaterThan(-1);
    }
    expect(out.indexOf("5h:")).toBeLessThan(out.indexOf("wk:"));
    expect(out.indexOf("wk:")).toBeLessThan(out.indexOf("↻"));
  });

  it("↻<rel> 段恒 dim：rel 段紧前存在 dim 码，不沾窗色", () => {
    const out = colorQuota({ short: { pct: 91, resetIso: FUTURE_SHORT } }, NOW);
    const i = out.indexOf("↻");
    expect(i).toBeGreaterThan(-1);
    expect(out.slice(Math.max(0, i - 12), i)).toContain(DIM);
  });

  it("仅周窗：weekly 91 → 朱红（周窗独立走 levelColor，非 short 专属）", () => {
    expect(
      colorQuota({ weekly: { pct: 91, resetIso: FUTURE_WEEK } }, NOW),
    ).toContain(RED);
  });
});

describe("P2 独立判定 // 5h 与 wk 各自选色", () => {
  it("谓词逐字：short 4（苔绿）+ weekly 75（琥珀）同一输出共存", () => {
    const out = colorQuota(
      {
        short: { pct: 4, resetIso: FUTURE_SHORT },
        weekly: { pct: 75, resetIso: FUTURE_WEEK },
      },
      NOW,
    );
    expect(out).toContain(GREEN);
    expect(out).toContain(AMBER);
  });

  it("反向组合 short 75 / weekly 91 → 琥珀 + 朱红（两窗互不覆盖）", () => {
    const out = colorQuota(
      {
        short: { pct: 75, resetIso: FUTURE_SHORT },
        weekly: { pct: 91, resetIso: FUTURE_WEEK },
      },
      NOW,
    );
    expect(out).toContain(AMBER);
    expect(out).toContain(RED);
  });
});
