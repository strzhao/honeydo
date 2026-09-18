import { afterEach, describe, expect, it, vi } from "vitest";
import { pickProviderInteractive, run } from "./cli.js";

// ============================================================================
// 红队验收 — picker 渲染重写（B 骨架 ANSI 主题色 + truecolor Limit 染色）
//
// 断言独立推导自 state.md ## 设计文档（视觉规格 / 结构改造 / YAGNI 边界）、
// ## 契约规约 1-7 与 ## 验收场景 P3/P4，零实现代码读取（cli.ts 基线仅作
// 注入 seam 依据）。
//
// 可观测 seam（设计要求的验收路径）：
//   1. 生产 picker 经 deps.pickProvider 注入 run()（镜像 main() 的生产装配
//      pickProvider: (entries, i) => pickProviderInteractive(entries, i)），
//      渲染全部走 stderr（契约 2）→ vi.spyOn(process.stderr, "write") 捕获。
//      → 因此本文件要求 pickProviderInteractive 可从 ./cli.js 导入；这是
//      P4「红队 acceptance 断言」路径的最小可观测 seam 要求。
//   2. 键盘注入：pickProvider 被调时排一个「双微任务跳」的 keypress 发射——
//      run() 的 await 续体是单跳，双跳必然落在生产 picker 注册完 keypress
//      监听之后（微任务先于一切宏任务 IO，天然规避 stdin EOF 竞态）。
//
// CONTRACT_AMBIGUOUS 汇总：
//   1. 选中前缀 ❯ 的颜色：视觉规格 1 写「绿色 sage」、结构色 2 写
//      「cyan 或 bold」，两处冲突 → 只断言 ❯ 前缀存在与缩进对齐，不断言
//      其颜色码。
//   2. 无 quota 行的「—」位置：「name 后 dim — 占位（列对齐的关键）」按其
//      陈述目的（列对齐）理解为落在 quota 列（与 quota 起始列相同）；若
//      design 意为紧跟 name，需改断言列值。
//   3. ctrl-c → 恢复终端 + exit 130：process.exit 在接缝层不可观测（进程内
//      驱动会杀死测试进程），沿用仓内既有 acceptance 文件同一裁决，不断言。
//
// 变更留痕（红队自修，编排器裁决 2026-09-18）：
//   「escape → skip」用例初版断言「不 spawn claude」系从「不切换」字面误推，
//   与契约矛盾（契约 1 + 既有 D3 矩阵：skip 语义 = 不切换 provider、不动
//   memory、仍以 claude 默认配置照常启动）。已重锁为强形式：runClaudeInteractive
//   恰 1 次 + 参数无 --settings（默认 spawn）+ 无 -p + 不写记忆。
// ============================================================================

type KeyLike = { name?: string; ctrl?: boolean; meta?: boolean };

// 设计声明的色值/属性码（视觉规格 2/3 + 结构改造 4，逐字）
const RED = "\x1b[38;2;217;79;61m"; // 朱红 #D94F3D（pct ≥ 85）
const AMBER = "\x1b[38;2;212;146;10m"; // 琥珀 #D4920A（pct ≥ 60）
const GREEN = "\x1b[38;2;58;125;104m"; // 苔绿 #3A7D68（else）
const BG = "\x1b[48;2;41;46;66m"; // 选中行 truecolor 背景 #292e42
const CYAN = "\x1b[36m"; // ●上次 / 标题
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";

// fixtures：DB 原序 GLM → Kimi Coding → Zeta Labs。
// name 长度 3 / 11 / 9 → name 列宽 = max(11) + 2 = 13，quota 起始列 = 2 前缀 + 13 = 15。
const RAW = [
  {
    name: "GLM",
    settingsConfig: JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: "https://open.bigmodel.cn/api/anthropic",
        ANTHROPIC_AUTH_TOKEN: "glm-t",
        ANTHROPIC_MODEL: "glm-5.2",
      },
    }),
  },
  {
    name: "Kimi Coding",
    settingsConfig: JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: "https://api.kimi.com/coding/",
        ANTHROPIC_AUTH_TOKEN: "kimi-t",
      },
    }),
  },
  {
    name: "Zeta Labs",
    settingsConfig: JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: "https://api.zeta.dev/v1",
        ANTHROPIC_AUTH_TOKEN: "zeta-t",
      },
    }),
  },
];
const NAMES = ["GLM", "Kimi Coding", "Zeta Labs"];
const QUOTA_COLUMN = 15; // 2(❯ /缩进) + max(name)+2
const REDRAW_UP = 7; // 标题2 + 分隔线1 + 条目3 + 末行1

const QUOTA_MAP = new Map<string, string>([
  ["GLM", "5h:42% wk:17% ↻2h13m"], // 42/17 双窗均 < 60 → 仅苔绿
  ["Kimi Coding", "5h:91% wk:4% ↻2h13m"], // 91 朱红 + 4 苔绿 同行（P2 投影）
]);

function stripAnsi(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 测试断言 ANSI 序列属控制字符的正当使用场景
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/\r/g, "");
}

function makeCapture() {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stderr, "write").mockImplementation(((
    chunk: unknown,
  ) => {
    chunks.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  }) as typeof process.stderr.write);
  const text = () => chunks.join("");
  return {
    spy,
    text,
    lines: () =>
      stripAnsi(text())
        .split("\n")
        .filter((l) => l.length > 0),
    entryLines: (names: string[] = NAMES) =>
      text()
        .split("\n")
        .filter((l) => names.some((n) => stripAnsi(l).includes(n))),
  };
}

function planKeys(...keys: KeyLike[]): void {
  Promise.resolve().then(() => {
    Promise.resolve().then(() => {
      for (const key of keys) {
        process.stdin.emit("keypress", "", key);
      }
    });
  });
}

type EntryShape = { name: string; quota?: string; tag?: string };

function makeDeps(opts: { remembered?: string; keys?: KeyLike[] } = {}) {
  const entrySpy: { current: EntryShape[] } = { current: [] };
  return {
    entrySpy,
    readCcSwitchProvider: vi.fn(async () => ({
      ok: true as const,
      providers: RAW,
    })),
    runClaude: vi.fn(async () => ({
      stdout: "claude-ok",
      stderr: "",
      exitCode: 0,
    })),
    runAgy: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
    runApi: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    readStdin: vi.fn(async () => ""),
    runClaudeInteractive: vi.fn(async () => ({ exitCode: 0 })),
    runAgyInteractive: vi.fn(async () => ({ exitCode: 0 })),
    isInteractive: vi.fn(() => true),
    // 生产 picker 经 deps 注入（镜像 main() 装配）+ 透传 entries 供数据流断言
    pickProvider: vi.fn(
      (
        entries: EntryShape[],
        initialIndex: number,
      ): Promise<
        | {
            kind: "select";
            entry: EntryShape;
          }
        | { kind: "skip" }
      > => {
        entrySpy.current = entries;
        if (opts.keys !== undefined) planKeys(...opts.keys);
        return pickProviderInteractive(entries, initialIndex);
      },
    ),
    fetchProviderQuotas: vi.fn(async () => QUOTA_MAP),
    readLastProvider: vi.fn(async () => opts.remembered),
    writeLastProvider: vi.fn(async () => {}),
    runHermes: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
    readTextFile: vi.fn(async () => undefined),
    writeTextFileAtomic: vi.fn(async () => ({ ok: true as const })),
    copyFile: vi.fn(async () => ({ ok: true as const })),
    queryLastSessionModel: vi.fn(async () => undefined),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// 首绘结构（视觉规格 1：标题两行 → dim 分隔线 → 条目 N 行 → dim 末行提示）
// ---------------------------------------------------------------------------

describe("首绘 B 骨架 // 视觉规格 1", () => {
  it("标题两行 + `─`×50 分隔线 + 3 条目 + 末行 `Esc 退出`，恰 7 行；旧文案消失", async () => {
    vi.stubEnv("NO_COLOR", ""); // 对照组：强制非 NO_COLOR（空串 ≠ 非空）
    const cap = makeCapture();
    const deps = makeDeps({ keys: [{ name: "escape" }] });
    const r = await run([], deps);
    cap.spy.mockRestore();
    expect(r.exitCode).toBe(0);
    const text = cap.text();
    // 标题行 1：◆ gcli（cyan+bold）+ · 选择 provider（默认色）
    expect(text).toContain("◆ gcli");
    expect(text).toContain("· 选择 provider");
    expect(text).toContain(CYAN);
    expect(text).toContain(BOLD);
    // 标题行 2（dim）
    expect(text).toContain("↑↓/j/k 移动 · Enter 确认 · Esc 退出");
    expect(text).toContain(DIM);
    // 结构恰 7 行：标题2 + 分隔线1 + 条目3 + 末行1
    const lines = cap.lines();
    expect(lines).toHaveLength(7);
    expect(lines.filter((l) => l === "─".repeat(50))).toHaveLength(1);
    expect(lines[lines.length - 1]).toBe("Esc 退出");
    for (const name of NAMES) {
      expect(lines.some((l) => l.includes(name))).toBe(true);
    }
    // 旧实现痕迹必须消失：自有「不切换」行、quota 内拼（上次）
    expect(text).not.toContain("不切换（使用 cc-switch 当前生效配置）");
    expect(text).not.toContain("（上次）");
    // YAGNI 边界：不加光标隐藏
    expect(text).not.toContain("\x1b[?25l");
    // 契约 2：TUI 路径 run() 返回 stdout byte-clean
    expect(r.stdout).toBe("");
  });
});

// ---------------------------------------------------------------------------
// 选中行渲染（视觉规格 1 条目行 + 结构改造 4 truecolor 背景）
// ---------------------------------------------------------------------------

describe("选中行 // truecolor 背景 + ❯ 前缀", () => {
  it("选中行（index 0）含背景 #292e42 与行尾 \\x1b[0m\\x1b[K；未选中行无背景", async () => {
    vi.stubEnv("NO_COLOR", "");
    const cap = makeCapture();
    const deps = makeDeps({ keys: [{ name: "escape" }] });
    await run([], deps);
    cap.spy.mockRestore();
    const entryLines = cap.entryLines();
    expect(entryLines).toHaveLength(3);
    const stripped = entryLines.map(stripAnsi);
    // CONTRACT_AMBIGUOUS 1：只断言前缀形状，不断言 ❯ 颜色
    expect(stripped[0].startsWith("❯ ")).toBe(true);
    expect(stripped[1].startsWith("  ")).toBe(true);
    expect(stripped[2].startsWith("  ")).toBe(true);
    expect(entryLines[0]).toContain(BG);
    expect(entryLines[0]).toContain("\x1b[0m\x1b[K");
    expect(entryLines[1]).not.toContain(BG);
    expect(entryLines[2]).not.toContain(BG);
  });
});

// ---------------------------------------------------------------------------
// quota 染色（渲染层 P1/P2 投影）+ ↻ 恒 dim
// ---------------------------------------------------------------------------

describe("quota 段染色 // 逐窗独立（渲染层 P2 投影）", () => {
  it("Kimi 行 5h:91% 朱红 + wk:4% 苔绿同帧；GLM 行 42% 仅苔绿不沾红/琥珀", async () => {
    vi.stubEnv("NO_COLOR", "");
    const cap = makeCapture();
    const deps = makeDeps({ keys: [{ name: "escape" }] });
    await run([], deps);
    cap.spy.mockRestore();
    const entryLines = cap.entryLines();
    const glm = entryLines[0];
    const kimi = entryLines[1];
    expect(stripAnsi(kimi)).toContain("5h:91%");
    expect(stripAnsi(kimi)).toContain("wk:4%");
    expect(kimi).toContain(RED);
    expect(kimi).toContain(GREEN);
    expect(stripAnsi(glm)).toContain("5h:42%");
    expect(glm).toContain(GREEN);
    expect(glm).not.toContain(RED);
    expect(glm).not.toContain(AMBER);
  });

  it("↻<rel> 段恒 dim：Kimi 行 ↻ 紧前为 dim 码", async () => {
    vi.stubEnv("NO_COLOR", "");
    const cap = makeCapture();
    const deps = makeDeps({ keys: [{ name: "escape" }] });
    await run([], deps);
    cap.spy.mockRestore();
    const kimi = cap.entryLines()[1];
    const i = kimi.indexOf("↻");
    expect(i).toBeGreaterThan(-1);
    expect(stripAnsi(kimi)).toContain("↻2h13m");
    expect(kimi.slice(Math.max(0, i - 12), i)).toContain(DIM);
  });
});

// ---------------------------------------------------------------------------
// tag 数据流（结构改造 2）：entries.tag='上次' → 渲染 ●上次（cyan）
// ---------------------------------------------------------------------------

describe("tag ●上次 // 数据流 + 渲染", () => {
  it("记忆行 entries.tag='上次' → 渲染 ` ●上次`（cyan）仅记忆行；旧（上次）拼接消失", async () => {
    vi.stubEnv("NO_COLOR", "");
    const cap = makeCapture();
    const deps = makeDeps({
      remembered: "Kimi Coding",
      keys: [{ name: "escape" }],
    });
    await run([], deps);
    cap.spy.mockRestore();
    // 数据面：tag 字段（设计声明的 PickerEntry.tag）只落在记忆行
    const entries = deps.entrySpy.current;
    expect(entries.find((e) => e.name === "Kimi Coding")?.tag).toBe("上次");
    expect(entries.find((e) => e.name === "GLM")?.tag).toBeUndefined();
    expect(entries.find((e) => e.name === "Zeta Labs")?.tag).toBeUndefined();
    // 渲染面：●上次 cyan 仅记忆行
    const entryLines = cap.entryLines();
    expect(stripAnsi(entryLines[1])).toContain(" ●上次");
    expect(entryLines[1]).toContain(CYAN);
    expect(stripAnsi(entryLines[0])).not.toContain("●");
    expect(stripAnsi(entryLines[2])).not.toContain("●");
    expect(cap.text()).not.toContain("（上次）");
  });
});

// ---------------------------------------------------------------------------
// 列对齐（视觉规格 1：name 列宽 = max+2；无 quota 行 — 占位）
// ---------------------------------------------------------------------------

describe("列对齐 // name 列宽 = max+2", () => {
  it("两条 quota 行 5h: 起始列均 = 15；无 quota 行 — 占位同列（CONTRACT_AMBIGUOUS 2）", async () => {
    vi.stubEnv("NO_COLOR", "");
    const cap = makeCapture();
    const deps = makeDeps({ keys: [{ name: "escape" }] });
    await run([], deps);
    cap.spy.mockRestore();
    const stripped = cap.entryLines().map(stripAnsi);
    expect(stripped[0].indexOf("5h:")).toBe(QUOTA_COLUMN);
    expect(stripped[1].indexOf("5h:")).toBe(QUOTA_COLUMN);
    expect(stripped[2].indexOf("—")).toBe(QUOTA_COLUMN);
  });
});

// ---------------------------------------------------------------------------
// redraw rowCount（结构改造 3：\x1b[<n>A 用 标题2+分隔线1+条目+末行1）
// ---------------------------------------------------------------------------

describe("redraw 一致性 // 结构改造 3", () => {
  it("down 触发重绘：光标回退恰 \\x1b[7A\\r；重绘把选中背景画到新行", async () => {
    vi.stubEnv("NO_COLOR", "");
    const cap = makeCapture();
    const deps = makeDeps({
      keys: [{ name: "down" }, { name: "escape" }],
    });
    await run([], deps);
    cap.spy.mockRestore();
    const text = cap.text();
    // biome-ignore lint/suspicious/noControlCharactersInRegex: 断言 redraw 光标回退序列，控制字符为被测对象
    const ups = [...text.matchAll(/\x1b\[(\d+)A\r/g)].map((m) => m[1]);
    expect(ups.length).toBeGreaterThanOrEqual(1);
    for (const n of ups) {
      expect(n).toBe(String(REDRAW_UP));
    }
    const entryLines = cap.entryLines();
    expect(entryLines.some((l) => l.includes("GLM") && l.includes(BG))).toBe(
      true,
    );
    expect(
      entryLines.some((l) => l.includes("Kimi Coding") && l.includes(BG)),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 键位契约经生产 picker（契约 1：applyPickerKey/环形 wrap/resolve 语义不动）
// ---------------------------------------------------------------------------

describe("键位契约 // 生产 picker 端到端", () => {
  it("k 自首项环形 wrap → return 确认末项 Zeta Labs（返回 entry.name 语义不变）", async () => {
    vi.stubEnv("NO_COLOR", "");
    const cap = makeCapture();
    const deps = makeDeps({ keys: [{ name: "k" }, { name: "return" }] });
    const r = await run([], deps);
    cap.spy.mockRestore();
    expect(r.exitCode).toBe(0);
    expect(deps.writeLastProvider).toHaveBeenCalledTimes(1);
    expect(deps.writeLastProvider).toHaveBeenCalledWith("Zeta Labs");
    expect(deps.runClaudeInteractive).toHaveBeenCalledTimes(1);
    expect(r.stdout).toBe("");
  });

  it("escape → skip：不写记忆、不 spawn 任何后端、exit 0 + 退出提示", async () => {
    vi.stubEnv("NO_COLOR", "");
    const cap = makeCapture();
    const deps = makeDeps({ keys: [{ name: "escape" }] });
    const r = await run([], deps);
    cap.spy.mockRestore();
    // 语义变更（2026-09 用户裁定）：Esc = 退出，不启动 claude
    expect(r.exitCode).toBe(0);
    expect(deps.writeLastProvider).toHaveBeenCalledTimes(0);
    expect(deps.runClaudeInteractive).toHaveBeenCalledTimes(0);
    expect(deps.runClaude).toHaveBeenCalledTimes(0);
    expect(r.stdout).toBe("");
    // 退出反馈：stderr 有确认提示（防「按了没反应」体验）
    expect(r.stderr).toContain("已退出");
  });
});

// ---------------------------------------------------------------------------
// P4 NO_COLOR（验收场景 P4 逐字 + 设计 NO_COLOR 降级）
// ---------------------------------------------------------------------------

describe("P4 NO_COLOR // 无任何 ANSI 颜色/属性码，纯文本排版保留", () => {
  it("NO_COLOR=1：不含 \\x1b[38;2 与 \\x1b[48;2（谓词逐字），且零 SGR；❯/列对齐/— 保留", async () => {
    vi.stubEnv("NO_COLOR", "1");
    const cap = makeCapture();
    const deps = makeDeps({ keys: [{ name: "escape" }] });
    const r = await run([], deps);
    cap.spy.mockRestore();
    expect(r.exitCode).toBe(0);
    const text = cap.text();
    // P4 谓词逐字（substring）
    expect(text).not.toContain("\x1b[38;2");
    expect(text).not.toContain("\x1b[48;2");
    // 设计：无任何 ANSI 颜色/属性码 → 零 SGR 序列（颜色/属性码均以 m 结尾；
    // 光标移动 A/K/J 属控制非属性，不在禁列）
    // biome-ignore lint/suspicious/noControlCharactersInRegex: 断言零 SGR，控制字符为被测对象
    expect(text.match(/\x1b\[[0-9;]*m/g)).toBeNull();
    // 纯文本排版保留：结构 7 行 + ❯ 缩进 + 列对齐 + — 占位
    expect(cap.lines()).toHaveLength(7);
    const stripped = cap.entryLines().map(stripAnsi);
    expect(stripped[0].startsWith("❯ ")).toBe(true);
    expect(stripped[0].indexOf("5h:")).toBe(QUOTA_COLUMN);
    expect(stripped[1].indexOf("5h:")).toBe(QUOTA_COLUMN);
    expect(stripped[2].indexOf("—")).toBe(QUOTA_COLUMN);
    expect(text).toContain("◆ gcli");
    expect(text).toContain("─".repeat(50));
  });
});

// ---------------------------------------------------------------------------
// hermes 式退化（设计：hermes 调用点不传 tag 不受影响；无 quota 同函数退化）
// ---------------------------------------------------------------------------

describe("hermes 式退化 // 无 quota 无 tag 直驱生产 picker", () => {
  it("无 quota 条目：— 占位列对齐、无 ●、无（上次）、escape → skip", async () => {
    const cap = makeCapture();
    const p = pickProviderInteractive([{ name: "Alpha" }, { name: "Beta" }], 0);
    process.stdin.emit("keypress", "", { name: "escape" });
    const outcome = await p;
    cap.spy.mockRestore();
    expect(outcome).toEqual({ kind: "skip" });
    const text = cap.text();
    expect(text).toContain("◆ gcli");
    const lines = cap
      .text()
      .split("\n")
      .filter((l) => ["Alpha", "Beta"].some((n) => stripAnsi(l).includes(n)));
    expect(lines).toHaveLength(2);
    expect(stripAnsi(lines[0]).indexOf("—")).toBe(9); // 2 + max(5)+2
    expect(stripAnsi(lines[1]).indexOf("—")).toBe(9);
    expect(text).not.toContain("●");
    expect(text).not.toContain("（上次）");
  });
});
