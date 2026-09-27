import { describe, expect, it } from "vitest";
import { type PickerEntry, renderPickerRows } from "./cli.js";

// ============================================================================
// 红队验收 — provider picker 会话数（渲染层：会话固定列 + 末行缺口提示）
//
// 断言独立推导自 state.md ## 设计文档 §2（渲染层）、§3（token 防泄漏）与
// ## 验收场景 P2/P3/P4，零实现代码读取。驱动面 = 设计 §4 声明的既有 export
// renderPickerRows(entries, selectedIndex, noColor, unattributedCount?)（第 4
// 参向后兼容扩参，缺省 = 0）与 PickerEntry.sessions?: number。
//
// 帧结构（既有单测锁定）：[标题1, 标题2, 分隔线, ...条目N, 末行] → 条目行起
// rows[3]，末行 rows[entries.length+3]，总行数恒 entries.length+4。
//
// CONTRACT_AMBIGUOUS（P3 =0 分支末行文案）——已裁决（编排器裁决 2026-09-27）：
// **P3 SSOT 谓词胜出，末行文案全分支统一为 `Esc 不切换`**。依据：
//   E1 P3 谓词先于实现冻结（「=0 与缺省 → 末行仅含 `Esc 不切换`」），是
//      全链路唯一权威源；
//   E2 brainstorm.md 用户逐题确认的 mockup 末行即 `Esc 不切换`（用户看到
//      的预览即此文案）；
//   E3 被改前既有断言锁的 `Esc 退出` 系陈旧文案、与 SSOT 冲突（且与标题
//      键位行本就不一致），随本任务一并修正不算破坏 P6。
// 故本文件 =0/缺省分支断言翻转为 `Esc 不切换`（原按「P6 现状=`Esc 退出`」
// 读法所锁的红灯，由编排器铁律例外闭合）。
// ============================================================================

const DIM = "\x1b[2m";
const DIM_OFF = "\x1b[22m";

function stripAnsi(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 测试断言 ANSI 序列属控制字符的正当使用场景
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/\r/g, "");
}

// P2 fixture：name 长度 3/11/9/8 → name 列宽 = 11+2 = 13，quota 起始列 =
// 2(❯/缩进) + 13 = 15；quota 可见长 20/—/19/— → 会话列 = 15+20 = 35。
// 覆盖四态：sessions=0（falsy 不得吞段）、sessions=3、有 quota 无 sessions、
// 纯 hermes 条目（无 quota 无 sessions）。
const P2_ENTRIES: PickerEntry[] = [
  { name: "GLM", quota: "5h:42% wk:17% ↻2h13m", sessions: 0 },
  { name: "Kimi Coding", sessions: 3 },
  { name: "Zeta Labs", quota: "5h:91% wk:4% ↻2h13m" },
  { name: "Hermes P" },
];
const QUOTA_COL = 15;
const QUOTA_VISIBLE_MAX = "5h:42% wk:17% ↻2h13m".length; // 20

describe("P2 会话固定列 // renderPickerRows 彩色模式", () => {
  const rows = renderPickerRows(P2_ENTRIES, 0, false);
  const stripped = rows.slice(3, 3 + P2_ENTRIES.length).map(stripAnsi);

  it("帧结构不因新列变化：总行数 = 条目+4（标题2+分隔1+条目N+末行1）", () => {
    expect(rows).toHaveLength(P2_ENTRIES.length + 4);
  });

  it("sessions=0 真实渲染「0会话」（falsy 0 不得吞段）且恒 dim（\\x1b[2m 包裹）", () => {
    expect(stripped[0]).toContain("0会话");
    // biome-ignore lint/suspicious/noControlCharactersInRegex: 断言 dim 包裹会话段，控制字符为被测对象
    expect(rows[3]).toMatch(/\x1b\[2m[^\x1b]*0会话/);
    // 段间单项关闭码纪律：dim 段以 \x1b[22m 收口（行尾才全复位）
    const tail = rows[3].slice(rows[3].indexOf("0会话"));
    expect(tail.indexOf(DIM_OFF)).toBeGreaterThan(-1);
  });

  it("sessions=3 同样渲染「3会话」恒 dim（无 quota 条目由 — 占位承接 pad）", () => {
    expect(stripped[1]).toContain("3会话");
    // biome-ignore lint/suspicious/noControlCharactersInRegex: 断言 dim 包裹会话段，控制字符为被测对象
    expect(rows[4]).toMatch(/\x1b\[2m[^\x1b]*3会话/);
    expect(stripped[1].indexOf("—")).toBe(QUOTA_COL);
  });

  it("跨行会话段起始列对齐（固定列承诺；段间 pad 按 JS .length）", () => {
    const col0 = stripped[0].indexOf("0会话");
    const col1 = stripped[1].indexOf("3会话");
    expect(col0).toBe(col1);
    // 会话列 = quota 列 + max(quota 可见长)（±1：` <n>会话` 前导空格归属实现）
    expect(col0).toBeGreaterThanOrEqual(QUOTA_COL + QUOTA_VISIBLE_MAX);
    expect(col0).toBeLessThanOrEqual(QUOTA_COL + QUOTA_VISIBLE_MAX + 1);
  });

  it("quota 文本逐字节原样（契约 4：formatQuota 输出不被触碰），pad 只落在其后的空格", () => {
    const q = "5h:42% wk:17% ↻2h13m";
    expect(stripped[0]).toContain(q);
    const qStart = stripped[0].indexOf(q);
    expect(qStart).toBe(QUOTA_COL);
    const between = stripped[0].slice(
      qStart + q.length,
      stripped[0].indexOf("0会话"),
    );
    expect(between).toMatch(/^[ ]*$/);
    // 无 sessions 条目 quota 起点同列（本列行为不回归）
    expect(stripped[2].indexOf("5h:91%")).toBe(QUOTA_COL);
  });

  it("无 sessions 条目（hermes 退化）零「会话」子串", () => {
    expect(stripped[2]).not.toContain("会话");
    expect(stripped[3]).not.toContain("会话");
  });
});

describe("P2 NO_COLOR // 会话段纯文本、排版保留（设计 §2.5 + 契约 6）", () => {
  it("NO_COLOR 模式：全帧零 ANSI，会话段/列对齐保留，无 sessions 条目零「会话」", () => {
    const rows = renderPickerRows(P2_ENTRIES, 0, true);
    for (const row of rows) expect(row.includes("\x1b")).toBe(false);
    const entryRows = rows.slice(3, 3 + P2_ENTRIES.length);
    expect(entryRows[0]).toContain("0会话");
    expect(entryRows[1]).toContain("3会话");
    expect(entryRows[0].indexOf("0会话")).toBe(entryRows[1].indexOf("3会话"));
    expect(entryRows[0].indexOf("5h:42%")).toBe(QUOTA_COL);
    expect(entryRows[2]).not.toContain("会话");
    expect(entryRows[3]).not.toContain("会话");
  });
});

describe("P3 末行提示 // unattributedCount 第 4 参", () => {
  const P3_ENTRIES: PickerEntry[] = [
    { name: "Alpha", quota: "5h:42%", sessions: 1 },
    { name: "Beta", sessions: 2 },
  ];

  it("unattributedCount=5 → 末行含「另有 5 个裸 claude 会话未归属」与「Esc 不切换」（谓词逐字），同行合并 rowCount 不变 = entries+4", () => {
    const rows = renderPickerRows(P3_ENTRIES, 0, false, 5);
    expect(rows).toHaveLength(P3_ENTRIES.length + 4);
    const footer = rows[rows.length - 1];
    expect(stripAnsi(footer)).toContain("另有 5 个裸 claude 会话未归属");
    // 谓词字面；已裁决（编排器 2026-09-27），见文件头 E1-E3
    expect(stripAnsi(footer)).toContain("Esc 不切换");
    // 末行 = dim（设计 §2.4）
    // biome-ignore lint/suspicious/noControlCharactersInRegex: 断言 dim 包裹末行，控制字符为被测对象
    expect(footer).toMatch(/\x1b\[2m[^\x1b]*另有 5 个裸 claude 会话未归属/);
    // 同行合并证据：提示与 Esc 尾巴在同一个数组元素里（行数已断言 +4）
    expect(stripAnsi(footer)).toMatch(/另有 5 个裸 claude 会话未归属.*Esc/);
  });

  it("unattributedCount=0 与缺省 → 末行恒 `Esc 不切换`（编排器裁决 2026-09-27：P3 SSOT 全分支统一），无未归属提示", () => {
    for (const rows of [
      renderPickerRows(P3_ENTRIES, 0, false, 0),
      renderPickerRows(P3_ENTRIES, 0, false),
      renderPickerRows(P3_ENTRIES, 0, true, 0),
      renderPickerRows(P3_ENTRIES, 0, true),
    ]) {
      expect(rows).toHaveLength(P3_ENTRIES.length + 4);
      expect(stripAnsi(rows[rows.length - 1])).toBe("Esc 不切换");
      expect(rows.join("\n")).not.toContain("未归属");
    }
  });

  it("dim 会话段关闭码符合段间单项关闭码纪律（无 sessions 行不受牵连）", () => {
    const rows = renderPickerRows(P3_ENTRIES, 1, false, 0);
    // Beta 行（选中，index 1）含 sessions=2 → dim 段 + 选中行行尾全复位
    expect(rows[4]).toContain(DIM);
    expect(rows[4].slice(rows[4].indexOf("2会话"))).toContain(DIM_OFF);
    expect(rows[4].endsWith("\x1b[0m")).toBe(true);
  });
});

describe("P4 token 防泄漏 // 渲染全量输出（纯层 belt；集成层 braces 在 runtime 文件）", () => {
  const TOKENS = [
    "tok-A-111",
    "tok-B-222",
    "tok-X-999-unknown",
    "sk-ant-secret-3",
  ];

  it("彩色 + NO_COLOR + 提示在场三种帧：全量输出不含任一 fixture token 子串", () => {
    const frames = [
      renderPickerRows(P2_ENTRIES, 0, false, 7),
      renderPickerRows(P2_ENTRIES, 0, true, 7),
      renderPickerRows(
        [
          { name: "GLM", quota: "5h:42% wk:17% ↻2h13m", sessions: 3 },
          { name: "Kimi Coding", sessions: 0 },
        ],
        1,
        false,
        2,
      ),
    ];
    for (const frame of frames) {
      const all = frame.join("\n");
      for (const t of TOKENS) expect(all).not.toContain(t);
    }
  });
});
