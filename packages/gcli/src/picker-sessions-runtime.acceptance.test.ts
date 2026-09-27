import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyPickerKey,
  type PickerEntry,
  pickProviderInteractive,
  run,
} from "./cli.js";

// ============================================================================
// 红队验收 — provider picker 会话数（集成路径：RunDeps mock，无真实 spawn）
//
// 断言独立推导自 state.md ## 设计文档 §1.4（时点）/§3（安全红线）与
// ## 验收场景 P4/P5/P6，零实现代码读取。驱动面 = 设计 §4 声明的集成 seam：
// RunDeps 新增可选注入 listClaudeProcessArgs?: () => Promise<string[]>，
// countProviderSessions 不导出（deps 胶水）——红队经该 mock 驱动 claude 后端
// TTY picker 路径，并以其 spy 计数实现 P5「非 TTY 零触发」。
//
// Mental Mutation 自检：P5 三用例对 no-op 实现天然通过（现状本就不扫描），
// 故以「正向对比」用例（扫描恰 1 次 + sessions 落位 + 渲染在场）kill 全局
// no-op mutation；P5 用例锁的是「特性不得外溢到非交互路径」。
//
// 键位契约 ctrl-c → exit 130：process.exit 在进程内驱动不可观测（会杀死测试
// 进程），沿用仓内既有裁决（picker-render.acceptance.test.ts CONTRACT_AMBIGUOUS
// 3），不断言；P6 谓词的「全量 npm test 全绿」由 QA 以套件运行求值，本文件
// 仅覆盖其中可自动化子集（键位形状 / NO_COLOR / stdout 纪律 / 退出码）。
// ============================================================================

const U_GLM = "https://open.bigmodel.cn/api/anthropic";
const U_KIMI = "https://api.kimi.com/coding/";
const U_ZETA = "https://api.zeta.dev/v1";
const T_GLM = "tok-int-glm-9";
const T_KIMI = "tok-int-kimi-7";
const T_ZETA = "tok-int-zeta-3";
const ALL_TOKENS = [T_GLM, T_KIMI, T_ZETA];

const DB_PROVIDERS = [
  {
    name: "GLM",
    settingsConfig: JSON.stringify({
      env: { ANTHROPIC_BASE_URL: U_GLM, ANTHROPIC_AUTH_TOKEN: T_GLM },
    }),
  },
  {
    name: "Kimi Coding",
    settingsConfig: JSON.stringify({
      env: { ANTHROPIC_BASE_URL: U_KIMI, ANTHROPIC_AUTH_TOKEN: T_KIMI },
    }),
  },
  {
    name: "Zeta Labs",
    settingsConfig: JSON.stringify({
      env: { ANTHROPIC_BASE_URL: U_ZETA, ANTHROPIC_AUTH_TOKEN: T_ZETA },
    }),
  },
];

const settingsLine = (base: string, token: string, tail?: string) =>
  `claude --settings ${JSON.stringify({ env: { ANTHROPIC_BASE_URL: base, ANTHROPIC_AUTH_TOKEN: token } })}${tail ? ` ${tail}` : ""}`;

// GLM×2、Kimi×1、裸×2 → counts={GLM:2, Kimi Coding:1, Zeta Labs:0}、
// unattributed=2（末行提示应出现「另有 2 个…」）。
const SCAN_LINES = [
  settingsLine(U_GLM, T_GLM, "-p a"),
  settingsLine(U_GLM, T_GLM),
  settingsLine(U_KIMI, T_KIMI, "-p b"),
  "claude -p bare-1",
  "claude --resume xyz",
];

const QUOTA_MAP = new Map<string, string>([
  ["GLM", "5h:42% wk:17% ↻2h13m"],
  ["Kimi Coding", "5h:91% wk:4% ↻2h13m"],
]);

type KeyLike = { name?: string; ctrl?: boolean; meta?: boolean };
type EntryShape = {
  name: string;
  quota?: string;
  tag?: string;
  sessions?: number;
};

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
  return { spy, text };
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

function makeDeps(
  opts: {
    remembered?: string;
    keys?: KeyLike[];
    interactive?: boolean;
    scan?: "mock" | "absent" | "throw";
    throwMessage?: string;
  } = {},
) {
  const entrySpy: { current: EntryShape[] } = { current: [] };
  const scan =
    opts.scan === "absent"
      ? undefined
      : vi.fn(async (): Promise<string[]> => {
          if (opts.scan === "throw") {
            throw new Error(opts.throwMessage ?? "ps -ww failed");
          }
          return SCAN_LINES;
        });
  const pickProvider =
    opts.keys !== undefined
      ? vi.fn((entries: EntryShape[], initialIndex: number) => {
          entrySpy.current = entries;
          if (opts.keys !== undefined) planKeys(...opts.keys);
          return pickProviderInteractive(entries, initialIndex);
        })
      : vi.fn(
          async (
            _entries: EntryShape[],
            _i: number,
          ): Promise<{ kind: "skip" }> => ({ kind: "skip" }),
        );
  return {
    entrySpy,
    readCcSwitchProvider: vi.fn(async () => ({
      ok: true as const,
      providers: DB_PROVIDERS,
    })),
    pickProvider,
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
    isInteractive: vi.fn(() => opts.interactive ?? true),
    fetchProviderQuotas: vi.fn(async () => QUOTA_MAP),
    readLastProvider: vi.fn(async () => opts.remembered),
    writeLastProvider: vi.fn(async () => {}),
    runHermes: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
    readTextFile: vi.fn(async () => undefined),
    writeTextFileAtomic: vi.fn(async () => ({ ok: true as const })),
    copyFile: vi.fn(async () => ({ ok: true as const })),
    queryLastSessionModel: vi.fn(async () => undefined),
    ...(scan ? { listClaudeProcessArgs: scan } : {}),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// 正向对比（no-op mutation 的 kill 面）+ 设计 §1.4 时点 + P4 集成防泄漏
// ---------------------------------------------------------------------------

describe("claude TTY picker // 扫描恰 1 次、sessions 落位、端到端可见", () => {
  it("listClaudeProcessArgs 恰 1 次（与 quota 并行时点）；entries.sessions 按 counts 落位，0 为真值非 undefined", async () => {
    vi.stubEnv("NO_COLOR", "");
    const cap = makeCapture();
    const deps = makeDeps({ keys: [{ name: "escape" }] });
    const r = await run([], deps);
    cap.spy.mockRestore();
    expect(r.exitCode).toBe(0);
    expect(deps.listClaudeProcessArgs).toHaveBeenCalledTimes(1);
    expect(deps.fetchProviderQuotas).toHaveBeenCalledTimes(1);
    const entries: EntryShape[] = deps.entrySpy.current;
    expect(entries).toHaveLength(3);
    expect(entries.find((e) => e.name === "GLM")?.sessions).toBe(2);
    expect(entries.find((e) => e.name === "Kimi Coding")?.sessions).toBe(1);
    expect(entries.find((e) => e.name === "Zeta Labs")?.sessions).toBe(0);
    // 渲染面端到端：会话段 + 裸会话末行提示在场
    const visible = stripAnsi(cap.text());
    expect(visible).toContain("2会话");
    expect(visible).toContain("1会话");
    expect(visible).toContain("0会话");
    expect(visible).toContain("另有 2 个裸 claude 会话未归属");
    // 契约 2：stderr 纪律（stdout byte-clean）
    expect(r.stdout).toBe("");
    // P4 集成：真实 token 经 providers 注入，全量输出（stdout+stderr）零泄漏
    const allOut = `${r.stdout}\n${cap.text()}`;
    for (const t of ALL_TOKENS) expect(allOut).not.toContain(t);
  });

  it("导航不刷新：down 触发重绘后扫描仍恰 1 次（设计 §1.4「导航中不刷新」）", async () => {
    vi.stubEnv("NO_COLOR", "");
    const cap = makeCapture();
    const deps = makeDeps({ keys: [{ name: "down" }, { name: "escape" }] });
    await run([], deps);
    cap.spy.mockRestore();
    expect(deps.listClaudeProcessArgs).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 扫描退化（契约 8：picker 功能完整可用，宁缺勿谎）+ P4 错误信息红线
// ---------------------------------------------------------------------------

describe("扫描退化 // 抛错 / 未注入 → 退化不阻塞选型", () => {
  it("扫描抛错（错误信息含 token）→ exit 0、sessions 全 undefined、无缺口提示、token 零泄漏（P4 红线）", async () => {
    vi.stubEnv("NO_COLOR", "");
    const cap = makeCapture();
    const deps = makeDeps({
      keys: [{ name: "escape" }],
      scan: "throw",
      throwMessage: `ps -ww failed: ${T_GLM}`,
    });
    const r = await run([], deps);
    cap.spy.mockRestore();
    expect(r.exitCode).toBe(0);
    const entries: EntryShape[] = deps.entrySpy.current;
    expect(entries).toHaveLength(3);
    for (const e of entries) expect(e.sessions).toBeUndefined();
    const allOut = `${r.stdout}\n${cap.text()}`;
    for (const t of ALL_TOKENS) expect(allOut).not.toContain(t);
    const visible = stripAnsi(allOut);
    expect(visible).not.toContain("未归属"); // 宁缺勿谎：扫描失败不提示
    expect(visible).not.toContain("会话"); // 退化帧零会话段/零提示
  });

  it("未注入 listClaudeProcessArgs → 同样退化，picker 照常工作（既有 RunDeps mock 零破坏）", async () => {
    vi.stubEnv("NO_COLOR", "");
    const cap = makeCapture();
    const deps = makeDeps({ keys: [{ name: "escape" }], scan: "absent" });
    const r = await run([], deps);
    cap.spy.mockRestore();
    expect(r.exitCode).toBe(0);
    const entries: PickerEntry[] = deps.entrySpy.current;
    expect(entries).toHaveLength(3);
    for (const e of entries) expect(e.sessions).toBeUndefined();
    const visible = stripAnsi(cap.text());
    expect(visible).not.toContain("会话");
    expect(visible).not.toContain("未归属");
  });
});

// ---------------------------------------------------------------------------
// P5 非 TTY 零触发（契约 5 收紧项：spy 计数 = 0；正向 kill 面见上一节）
// ---------------------------------------------------------------------------

describe("P5 非 TTY 零触发 // listClaudeProcessArgs 调用次数 = 0", () => {
  it("print 模式（-p hi，非 TTY）：扫描 0 次、菜单 0 次、runClaude 照常、exit 0", async () => {
    const deps = makeDeps({ interactive: false });
    const r = await run(["-p", "hi"], deps);
    expect(r.exitCode).toBe(0);
    expect(deps.listClaudeProcessArgs).toHaveBeenCalledTimes(0);
    expect(deps.pickProvider).toHaveBeenCalledTimes(0);
    expect(deps.runClaude).toHaveBeenCalledTimes(1);
  });

  it("非 TTY 无 -p：exit 2（TTY guard 不回归），扫描 0 次", async () => {
    const deps = makeDeps({ interactive: false });
    const r = await run([], deps);
    expect(r.exitCode).toBe(2);
    expect(deps.listClaudeProcessArgs).toHaveBeenCalledTimes(0);
  });

  it("--pick 非 TTY：exit 2 逐字文案，扫描 0 次", async () => {
    const deps = makeDeps({ interactive: false });
    const r = await run(["--pick"], deps);
    expect(r.exitCode).toBe(2);
    expect(r.stderr.trim()).toBe("gcli: --pick requires a TTY");
    expect(deps.listClaudeProcessArgs).toHaveBeenCalledTimes(0);
  });

  it("显式 claude / agy 子命令非 TTY：同样零扫描", async () => {
    const deps = makeDeps({ interactive: false });
    await run(["claude", "-p", "hi"], deps);
    await run(["agy", "-p", "hi"], deps);
    expect(deps.listClaudeProcessArgs).toHaveBeenCalledTimes(0);
  });
});

// ---------------------------------------------------------------------------
// P6 契约回归（可自动化子集；「全量 npm test 全绿」由 QA 以套件运行求值）
// ---------------------------------------------------------------------------

describe("P6 契约回归 // 本任务不得触碰的既有锁（抽查）", () => {
  it("applyPickerKey 返回闭集形状不变：环形 wrap / C-n / Esc skip / M-> clamp / noop", () => {
    expect(applyPickerKey({ name: "k" }, 0, 5)).toEqual({
      type: "move",
      index: 4,
    });
    expect(applyPickerKey({ name: "down" }, 4, 5)).toEqual({
      type: "move",
      index: 0,
    });
    expect(applyPickerKey({ name: "n", ctrl: true }, 4, 5)).toEqual({
      type: "move",
      index: 0,
    });
    expect(applyPickerKey({ name: "escape" }, 2, 5)).toEqual({
      type: "skip",
    });
    expect(applyPickerKey({ name: ">", meta: true }, 0, 1)).toEqual({
      type: "move",
      index: 0,
    });
    expect(applyPickerKey({ name: "x" }, 2, 5)).toEqual({ type: "noop" });
  });

  it("NO_COLOR=1：会话段/末行提示零 ANSI 纯文本在场（契约 6 覆盖新增段）+ stdout byte-clean", async () => {
    vi.stubEnv("NO_COLOR", "1");
    const cap = makeCapture();
    const deps = makeDeps({ keys: [{ name: "escape" }] });
    const r = await run([], deps);
    cap.spy.mockRestore();
    expect(r.exitCode).toBe(0);
    const text = cap.text();
    // biome-ignore lint/suspicious/noControlCharactersInRegex: 断言零 SGR，控制字符为被测对象
    expect(text.match(/\x1b\[[0-9;]*m/g)).toBeNull();
    expect(text).toContain("2会话");
    expect(text).toContain("另有 2 个裸 claude 会话未归属");
    expect(r.stdout).toBe("");
  });
});
