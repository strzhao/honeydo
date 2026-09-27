import { describe, expect, it } from "vitest";
import { parseSessionAttribution, type SessionAttribution } from "./cli.js";

// ============================================================================
// 红队验收 — provider picker 会话数（数据层：ps 全扫归属）
//
// 断言独立推导自 state.md ## 设计文档 §1（数据层：进程扫描与归属）与
// ## 验收场景 P1/P4，零实现代码读取。驱动面 = 设计 §4「测试 seam 声明」
// 的新 export：parseSessionAttribution(lines, providers)（纯函数，任何解析
// 失败归 unattributed、不 throw）与 SessionAttribution type。
//
// provider 匹配规则（设计逐字）：baseUrl 全等 ∧（authToken 全等 ∨ apiKey
// 全等，非空才参与）。fixture token 全为虚构值（tok-A-111 等），仅驻内存。
// ============================================================================

const URL_U = "https://open.bigmodel.cn/api/anthropic";
const TOK_A = "tok-A-111";
const TOK_B = "tok-B-222";
const TOK_X = "tok-X-999-unknown";

const PROV_A = { name: "A", baseUrl: URL_U, authToken: TOK_A };
const PROV_B = { name: "B", baseUrl: URL_U, authToken: TOK_B };

const settingsArg = (env: Record<string, string>) => JSON.stringify({ env });
const claudeLine = (settingsJson: string, tail?: string) =>
  `claude --settings ${settingsJson}${tail ? ` ${tail}` : ""}`;

// P1 fixture（谓词逐字）：A 3 行（URL=u、token=ta）、B 2 行（同域异 token
// =tb）、裸行 5、--settings 未知 token 1 → counts={A:3,B:2}、unattributed=6。
const P1_LINES = [
  claudeLine(
    settingsArg({ ANTHROPIC_BASE_URL: URL_U, ANTHROPIC_AUTH_TOKEN: TOK_A }),
    "-p hi",
  ),
  claudeLine(
    settingsArg({ ANTHROPIC_BASE_URL: URL_U, ANTHROPIC_AUTH_TOKEN: TOK_A }),
  ),
  // 括号配平声明（自首个 { 起括号配平抽取）：JSON 之后尾参含 `}`——
  // naive「取到最后一个 }」会把尾参并进 JSON → parse 失败 → 整行塌进
  // unattributed，本行即红（kill 该 mutation）。
  claudeLine(
    settingsArg({ ANTHROPIC_BASE_URL: URL_U, ANTHROPIC_AUTH_TOKEN: TOK_A }),
    "-p 'echo } ok'",
  ),
  claudeLine(
    settingsArg({ ANTHROPIC_BASE_URL: URL_U, ANTHROPIC_AUTH_TOKEN: TOK_B }),
    "--model opus",
  ),
  claudeLine(
    settingsArg({ ANTHROPIC_BASE_URL: URL_U, ANTHROPIC_AUTH_TOKEN: TOK_B }),
  ),
  // 裸 claude ×5（无 --settings）
  "claude -p hello",
  "claude",
  "claude --resume abc",
  "claude --model sonnet",
  "/usr/local/bin/claude --dangerously-skip-permissions",
  // --settings 但匹配不到任何 provider（未知 token）→ 诚实口径计 unattributed
  claudeLine(
    settingsArg({ ANTHROPIC_BASE_URL: URL_U, ANTHROPIC_AUTH_TOKEN: TOK_X }),
  ),
];

describe("P1 归属解析 // parseSessionAttribution（谓词逐字）", () => {
  it("同域异 token 各归其主；裸行 5 + 未知 token 1 → unattributed=6；深相等且不 throw", () => {
    const result: SessionAttribution = parseSessionAttribution(P1_LINES, [
      PROV_A,
      PROV_B,
    ]);
    expect(result).toEqual({ counts: { A: 3, B: 2 }, unattributed: 6 });
  });
});

describe("P1 匹配规则 // baseUrl 全等 ∧（authToken ∨ apiKey 全等，非空才参与）", () => {
  it("token 同但 baseUrl 不同 → 不归属（URL/token 合取缺一不可）", () => {
    const result = parseSessionAttribution(
      [
        claudeLine(
          settingsArg({
            ANTHROPIC_BASE_URL: "https://other.example.com",
            ANTHROPIC_AUTH_TOKEN: TOK_A,
          }),
        ),
      ],
      [PROV_A],
    );
    expect(result.unattributed).toBe(1);
    expect(result.counts.A ?? 0).toBe(0);
  });

  it("apiKey 全等可独立成立归属（authToken 缺席不阻断）", () => {
    const PROV_C = {
      name: "C",
      baseUrl: "https://api.kimi.com/coding/",
      apiKey: "ka-C-333",
    };
    const result = parseSessionAttribution(
      [
        claudeLine(
          settingsArg({
            ANTHROPIC_BASE_URL: PROV_C.baseUrl,
            ANTHROPIC_API_KEY: "ka-C-333",
          }),
        ),
      ],
      [PROV_C],
    );
    expect(result.unattributed).toBe(0);
    expect(result.counts.C).toBe(1);
  });

  it("apiKey 不同且 authToken 双缺席 → 不归属（防「双方都空即相等」假匹配）", () => {
    const PROV_C = { name: "C", baseUrl: URL_U, apiKey: "ka-C-333" };
    const result = parseSessionAttribution(
      [
        claudeLine(
          settingsArg({
            ANTHROPIC_BASE_URL: URL_U,
            ANTHROPIC_API_KEY: "ka-other-777",
          }),
        ),
      ],
      [PROV_C],
    );
    expect(result.unattributed).toBe(1);
    expect(result.counts.C ?? 0).toBe(0);
  });

  it("provider authToken 空串 + 行无任何 auth 字段 → 不归属（非空才参与，设计逐字）", () => {
    const PROV_E = { name: "E", baseUrl: URL_U, authToken: "" };
    const result = parseSessionAttribution(
      [claudeLine(settingsArg({ ANTHROPIC_BASE_URL: URL_U }))],
      [PROV_E],
    );
    expect(result.unattributed).toBe(1);
    expect(result.counts.E ?? 0).toBe(0);
  });

  it("同 URL+token 双 provider 条目各自计同数（设计声明边缘：接受重复计数）", () => {
    const D1 = { name: "D1", baseUrl: URL_U, authToken: TOK_A };
    const D2 = { name: "D2", baseUrl: URL_U, authToken: TOK_A };
    const result = parseSessionAttribution(
      [
        claudeLine(
          settingsArg({
            ANTHROPIC_BASE_URL: URL_U,
            ANTHROPIC_AUTH_TOKEN: TOK_A,
          }),
        ),
      ],
      [D1, D2],
    );
    expect(result.counts.D1).toBe(1);
    expect(result.counts.D2).toBe(1);
    expect(result.unattributed).toBe(0);
  });
});

describe("P4 容错 // 坏输入一律归 unattributed，绝不 throw", () => {
  it("坏 JSON / 缺花括号 / --settings 空尾 / 空 env / 尾参花括号干扰：全不 throw", () => {
    const BAD_LINES = [
      "claude --settings {not-json -p hi",
      "claude --settings",
      claudeLine(settingsArg({})), // 空 env：无 URL 无 token
      // 括号配平：合法 JSON 后跟含 `{` 的尾巴 → 只取配平子串且 parse 成功，
      // 但 URL 匹配不到 → unattributed（若 tail 被并进 JSON 则 parse 失败，
      // 同样 unattributed —— 本行不区分两条路径，只锁「不 throw + 计数」）
      `${claudeLine('{"env":{"ANTHROPIC_BASE_URL":"https://x.test"}}')} trailing { broken`,
    ];
    let result: SessionAttribution | undefined;
    expect(() => {
      result = parseSessionAttribution(BAD_LINES, [PROV_A, PROV_B]);
    }).not.toThrow();
    expect(result?.unattributed).toBe(BAD_LINES.length);
    expect(result?.counts.A ?? 0).toBe(0);
    expect(result?.counts.B ?? 0).toBe(0);
  });
});
