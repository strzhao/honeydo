import { describe, expect, it, vi } from "vitest";
import { parsePickerChoice, run } from "./cli.js";

// ============================================================================
// 红队验收测试 — claude provider 交互选择器（picker）+ 默认后端翻转 run() 级
//
// 信息隔离铁律：本文件仅基于设计文档契约编写，未读蓝队实现源码。
// 若蓝队未按契约导出 parsePickerChoice / RunDeps.pickProvider，红灯失败是预期。
//
// 契约（逐字取自设计文档契约规约）：
//   C-D2  run() 分发：'agy'→agy；undefined/'claude'→claude；'api'→api。默认后端=claude。
//   C-D3  picker 触发闭集：claude 分发 && 无 --provider && isInteractive()===true
//         && 非 --version。非 TTY 下零交互、零 cc-switch DB 访问
//         （无 --provider 时不得调用 readCcSwitchProvider）。
//   C-D4  picker 结果语义：选中 name →
//         settingsEnv = buildSettingsEnv(extractProviderEnv(该行 settingsConfig).env, parsed.model)，
//         经 --settings '{"env":{...}}' 注入；skip/undefined → 不注入
//         （--model 单独给定时仍注入 {ANTHROPIC_MODEL}，同现状）。
//   C-D5  picker 降级：lookup !ok / 空列表 → stderr 警告一行 + 继续无注入，
//         exit code 不变；显式 --provider 路径硬失败不变（exit 1/2）。
//         降级警告逐字：'gcli: provider picker unavailable: ...' /
//         'gcli: no cc-switch providers configured'
//   C-D6  picker UI 只写 stderr；选择循环先于任何 spawn 完成并关闭 readline；无效输入重问。
//   C-D7  HELP 与头部注释更新：默认=claude；agy 需显式子命令；picker 行为写入 claude 段 Notes。
//   C-D8  --settings env 始终显式 pin ANTHROPIC_MODEL。
//   D3    parsePickerChoice(line, count)：
//         trim 后空串/"0" → {kind:"skip"}；整数 1..count → {kind:"select", index: n-1}；
//         其余 → {kind:"invalid"}。
//   P1    run(["--help"]) stdout 含默认=claude 语义说明。
//
// RunDeps 新增必填接缝（蓝队按此实现）：
//   pickProvider: (names: string[]) => Promise<string | undefined>
// ============================================================================

const K3_RAW = {
  name: "Kimi For Coding",
  settingsConfig: {
    env: {
      ANTHROPIC_BASE_URL: "https://kimi.koding.com",
      ANTHROPIC_API_KEY: "kimi-key",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "kimi-k3[1M]",
    },
  },
};

const GLM_RAW = {
  name: "GLM",
  settingsConfig: {
    env: {
      ANTHROPIC_BASE_URL: "https://glm.example.com",
      ANTHROPIC_API_KEY: "glm-key",
      ANTHROPIC_MODEL: "glm-5.2",
    },
  },
};

const ALL_NAMES = [K3_RAW.name, GLM_RAW.name];

type SpawnResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  signal?: string | null;
  timedOut?: boolean;
};

function makeDeps(
  overrides: Partial<{
    readCcSwitchProvider: ReturnType<typeof vi.fn>;
    pickProvider: ReturnType<typeof vi.fn>;
    runClaude: ReturnType<typeof vi.fn>;
    runAgy: ReturnType<typeof vi.fn>;
    runApi: ReturnType<typeof vi.fn>;
    readStdin: ReturnType<typeof vi.fn>;
    runClaudeInteractive: ReturnType<typeof vi.fn>;
    runAgyInteractive: ReturnType<typeof vi.fn>;
    isInteractive: ReturnType<typeof vi.fn>;
  }> = {},
) {
  return {
    readCcSwitchProvider:
      overrides.readCcSwitchProvider ??
      vi.fn(async () => ({ ok: true as const, providers: [K3_RAW, GLM_RAW] })),
    // 默认 skip（等价用户选 0/直接回车）—— 不注入 settings
    pickProvider:
      overrides.pickProvider ??
      vi.fn(async (_names: string[]): Promise<string | undefined> => undefined),
    runClaude:
      overrides.runClaude ??
      vi.fn(
        async (): Promise<SpawnResult> => ({
          stdout: "claude-ok",
          stderr: "",
          exitCode: 0,
        }),
      ),
    runAgy:
      overrides.runAgy ??
      vi.fn(
        async (): Promise<SpawnResult> => ({
          stdout: "agy-ok",
          stderr: "",
          exitCode: 0,
        }),
      ),
    runApi:
      overrides.runApi ??
      vi.fn(async () => ({ exitCode: 0, stdout: "api-ok", stderr: "" })),
    readStdin: overrides.readStdin ?? vi.fn(async () => "default-stdin"),
    runClaudeInteractive:
      overrides.runClaudeInteractive ?? vi.fn(async () => ({ exitCode: 0 })),
    runAgyInteractive:
      overrides.runAgyInteractive ?? vi.fn(async () => ({ exitCode: 0 })),
    // picker 验收主战场是 TTY；非 TTY 用例显式覆盖为 false
    isInteractive: overrides.isInteractive ?? vi.fn(() => true),
  };
}

function settingsJsonOf(args: string[]): {
  env: Record<string, string | undefined>;
} {
  const idx = args.indexOf("--settings");
  expect(idx).toBeGreaterThan(-1);
  return JSON.parse(args[idx + 1]);
}

// ----------------------------------------------------------------------------
// D3 纯函数：parsePickerChoice 边界（验收点 12）
// ----------------------------------------------------------------------------

describe("parsePickerChoice // D3 skip/select/invalid 闭集", () => {
  it("空串 → {kind:'skip'}", () => {
    expect(parsePickerChoice("", 3)).toEqual({ kind: "skip" });
  });

  it("纯空白 '   ' → {kind:'skip'}（trim 后为空）", () => {
    expect(parsePickerChoice("   ", 3)).toEqual({ kind: "skip" });
  });

  it("'0' → {kind:'skip'}（0 = 不切换）", () => {
    expect(parsePickerChoice("0", 3)).toEqual({ kind: "skip" });
  });

  it("'1'（count=3）→ {kind:'select', index:0}（1-based 转 0-based）", () => {
    expect(parsePickerChoice("1", 3)).toEqual({ kind: "select", index: 0 });
  });

  it("'3'（count=3）→ {kind:'select', index:2}（上界含端点）", () => {
    expect(parsePickerChoice("3", 3)).toEqual({ kind: "select", index: 2 });
  });

  it("'4'（count=3）→ {kind:'invalid'}（超出上界）", () => {
    expect(parsePickerChoice("4", 3)).toEqual({ kind: "invalid" });
  });

  it("'abc' → {kind:'invalid'}（非数字）", () => {
    expect(parsePickerChoice("abc", 3)).toEqual({ kind: "invalid" });
  });

  it("'1.5' → {kind:'invalid'}（小数非整数）", () => {
    expect(parsePickerChoice("1.5", 3)).toEqual({ kind: "invalid" });
  });

  it("'-1' → {kind:'invalid'}（负数不在 1..count）", () => {
    expect(parsePickerChoice("-1", 3)).toEqual({ kind: "invalid" });
  });

  it("带首尾空白的合法输入 ' 2 '（count=3）→ {kind:'select', index:1}（输入先 trim）", () => {
    expect(parsePickerChoice(" 2 ", 3)).toEqual({ kind: "select", index: 1 });
  });
});

// ----------------------------------------------------------------------------
// picker 触发闭集（C-D3）+ 选中注入（C-D4/C-D8）（验收点 3）
// ----------------------------------------------------------------------------

describe("run() picker 触发 // C-D3 闭集 + C-D4 选中注入", () => {
  it("TTY + 无 --provider + print 模式 → pickProvider 被调 1 次，入参 = lookup 全部 names", async () => {
    const pickProvider = vi.fn(
      async (_names: string[]): Promise<string | undefined> => undefined,
    );
    const deps = makeDeps({ pickProvider });
    const r = await run(["claude", "-p", "hi"], deps);
    expect(r.exitCode).toBe(0);
    expect(deps.readCcSwitchProvider).toHaveBeenCalledTimes(1);
    expect(pickProvider).toHaveBeenCalledTimes(1);
    // 入参必须正好是 lookup 返回的全部 provider name（顺序一致）
    expect(pickProvider).toHaveBeenCalledWith(ALL_NAMES);
  });

  it("默认子命令（无 'claude' 首参）TTY + -p hi → 同样触发 picker（默认=claude, C-D2）", async () => {
    const pickProvider = vi.fn(
      async (_names: string[]): Promise<string | undefined> => undefined,
    );
    const deps = makeDeps({ pickProvider });
    await run(["-p", "hi"], deps);
    expect(deps.runClaude).toHaveBeenCalledTimes(1);
    expect(pickProvider).toHaveBeenCalledTimes(1);
    expect(pickProvider).toHaveBeenCalledWith(ALL_NAMES);
  });

  it("选中 'GLM' → runClaude args 含 --settings，env.ANTHROPIC_BASE_URL=glm 且 ANTHROPIC_MODEL 显式 pin（C-D4/C-D8）", async () => {
    const runClaude = vi.fn(
      async (): Promise<SpawnResult> => ({
        stdout: "ok",
        stderr: "",
        exitCode: 0,
      }),
    );
    const pickProvider = vi.fn(
      async (_names: string[]): Promise<string | undefined> => "GLM",
    );
    const deps = makeDeps({ pickProvider, runClaude });
    const r = await run(["-p", "hi"], deps);
    expect(r.exitCode).toBe(0);
    expect(runClaude).toHaveBeenCalledTimes(1);
    const args = runClaude.mock.calls[0][0] as string[];
    const json = settingsJsonOf(args);
    // 精确名查找命中 GLM 行，其 settingsConfig.env 被注入
    expect(json.env.ANTHROPIC_BASE_URL).toBe("https://glm.example.com");
    expect(json.env.ANTHROPIC_API_KEY).toBe("glm-key");
    // C-D8：ANTHROPIC_MODEL 始终显式 pin（GLM provider 自带 glm-5.2）
    expect(json.env.ANTHROPIC_MODEL).toBe("glm-5.2");
  });

  it("选中 'Kimi For Coding'（无 ANTHROPIC_MODEL，靠 DEFAULT_SONNET 派生）→ ANTHROPIC_MODEL 仍被 pin", async () => {
    const runClaude = vi.fn(
      async (): Promise<SpawnResult> => ({
        stdout: "ok",
        stderr: "",
        exitCode: 0,
      }),
    );
    const deps = makeDeps({
      pickProvider: vi.fn(
        async (_names: string[]): Promise<string | undefined> =>
          "Kimi For Coding",
      ),
      runClaude,
    });
    await run(["-p", "hi"], deps);
    const args = runClaude.mock.calls[0][0] as string[];
    const json = settingsJsonOf(args);
    expect(String(json.env.ANTHROPIC_BASE_URL)).toContain("kimi");
    expect(json.env.ANTHROPIC_MODEL).toBe("kimi-k3[1M]");
  });

  it("C-D6 时序：picker 选择循环先于任何 spawn 完成（pickProvider 调用序号 < runClaude）", async () => {
    const runClaude = vi.fn(
      async (): Promise<SpawnResult> => ({
        stdout: "ok",
        stderr: "",
        exitCode: 0,
      }),
    );
    const pickProvider = vi.fn(
      async (_names: string[]): Promise<string | undefined> => "GLM",
    );
    const deps = makeDeps({ pickProvider, runClaude });
    await run(["-p", "hi"], deps);
    expect(pickProvider).toHaveBeenCalledTimes(1);
    expect(runClaude).toHaveBeenCalledTimes(1);
    const pickOrder = pickProvider.mock.invocationCallOrder[0];
    const spawnOrder = runClaude.mock.invocationCallOrder[0];
    expect(pickOrder).toBeLessThan(spawnOrder);
  });

  it("C-D6 UI 只写 stderr：picker 触发后 run() 的 stdout 不被菜单/prompt 污染", async () => {
    const deps = makeDeps({
      pickProvider: vi.fn(
        async (_names: string[]): Promise<string | undefined> => "GLM",
      ),
    });
    const r = await run(["-p", "hi"], deps);
    expect(r.exitCode).toBe(0);
    // stdout 仅是后端输出；不得出现 provider 菜单内容
    expect(r.stdout).toBe("claude-ok");
    expect(r.stdout).not.toContain("GLM");
    expect(r.stdout).not.toContain("Kimi For Coding");
  });
});

// ----------------------------------------------------------------------------
// picker 跳过语义（C-D4 skip 分支）（验收点 4）
// ----------------------------------------------------------------------------

describe("run() picker skip // C-D4 skip/undefined → 不注入", () => {
  it("pickProvider 返回 undefined → runClaude args 不含 --settings", async () => {
    const runClaude = vi.fn(
      async (): Promise<SpawnResult> => ({
        stdout: "ok",
        stderr: "",
        exitCode: 0,
      }),
    );
    const deps = makeDeps({
      pickProvider: vi.fn(
        async (_names: string[]): Promise<string | undefined> => undefined,
      ),
      runClaude,
    });
    const r = await run(["-p", "hi"], deps);
    expect(r.exitCode).toBe(0);
    expect(runClaude).toHaveBeenCalledTimes(1);
    const args = runClaude.mock.calls[0][0] as string[];
    expect(args).not.toContain("--settings");
  });

  it("skip + --model x → 仍注入 --settings 且 env 仅含 ANTHROPIC_MODEL=x（C-D4 现状保留）", async () => {
    const runClaude = vi.fn(
      async (): Promise<SpawnResult> => ({
        stdout: "ok",
        stderr: "",
        exitCode: 0,
      }),
    );
    const deps = makeDeps({
      pickProvider: vi.fn(
        async (_names: string[]): Promise<string | undefined> => undefined,
      ),
      runClaude,
    });
    const r = await run(["-p", "hi", "--model", "my-model-x"], deps);
    expect(r.exitCode).toBe(0);
    const args = runClaude.mock.calls[0][0] as string[];
    const json = settingsJsonOf(args);
    expect(json.env.ANTHROPIC_MODEL).toBe("my-model-x");
    // 仅 ANTHROPIC_MODEL 一个 key —— skip 不得泄漏任何 provider env
    expect(Object.keys(json.env)).toEqual(["ANTHROPIC_MODEL"]);
  });
});

// ----------------------------------------------------------------------------
// picker + --model 组合（C-D4：parsed.model 覆盖 provider 内值）（验收点 5）
// ----------------------------------------------------------------------------

describe("run() picker + --model // C-D4 model 覆盖 provider env", () => {
  it("选中 'GLM' 且 --model 给定 → ANTHROPIC_MODEL = --model 值（覆盖 provider 自带 glm-5.2）", async () => {
    const runClaude = vi.fn(
      async (): Promise<SpawnResult> => ({
        stdout: "ok",
        stderr: "",
        exitCode: 0,
      }),
    );
    const deps = makeDeps({
      pickProvider: vi.fn(
        async (_names: string[]): Promise<string | undefined> => "GLM",
      ),
      runClaude,
    });
    const r = await run(["-p", "hi", "--model", "override-model"], deps);
    expect(r.exitCode).toBe(0);
    const args = runClaude.mock.calls[0][0] as string[];
    const json = settingsJsonOf(args);
    expect(json.env.ANTHROPIC_BASE_URL).toBe("https://glm.example.com");
    expect(json.env.ANTHROPIC_MODEL).toBe("override-model");
  });
});

// ----------------------------------------------------------------------------
// 非 TTY 零交互（C-D3 硬约束）（验收点 6）
// ----------------------------------------------------------------------------

describe("run() 非 TTY 零交互 // C-D3：无 pickProvider、无 cc-switch DB 读取", () => {
  it("isInteractive=false + 无 --provider + -p hi → pickProvider 0 次且 readCcSwitchProvider 0 次", async () => {
    const deps = makeDeps({ isInteractive: vi.fn(() => false) });
    const r = await run(["-p", "hi"], deps);
    expect(r.exitCode).toBe(0);
    expect(deps.runClaude).toHaveBeenCalledTimes(1);
    expect(deps.pickProvider).not.toHaveBeenCalled();
    expect(deps.readCcSwitchProvider).not.toHaveBeenCalled();
    // 无注入：默认路径非 TTY 不产生 --settings
    const args = deps.runClaude.mock.calls[0][0] as string[];
    expect(args).not.toContain("--settings");
  });

  it("isInteractive=false + 显式 'claude' 子命令同样零交互（C-D3 对两种 claude 分发都成立）", async () => {
    const deps = makeDeps({ isInteractive: vi.fn(() => false) });
    await run(["claude", "-p", "hi"], deps);
    expect(deps.pickProvider).not.toHaveBeenCalled();
    expect(deps.readCcSwitchProvider).not.toHaveBeenCalled();
  });

  it("非 TTY + 无 -p → exit 2（TTY guard），全程 pickProvider/readCcSwitchProvider 0 次", async () => {
    const deps = makeDeps({ isInteractive: vi.fn(() => false) });
    const r = await run([], deps);
    expect(r.exitCode).toBe(2);
    expect(deps.pickProvider).not.toHaveBeenCalled();
    expect(deps.readCcSwitchProvider).not.toHaveBeenCalled();
  });
});

// ----------------------------------------------------------------------------
// --version 短路（C-D3 闭集排除项）（验收点 7）
// ----------------------------------------------------------------------------

describe("run() --version 短路 // C-D3：TTY 下也不触发 picker、不读 DB", () => {
  it("isInteractive=true + --version → pickProvider 0 次、readCcSwitchProvider 0 次，直达 runClaude", async () => {
    const deps = makeDeps({ isInteractive: vi.fn(() => true) });
    await run(["--version"], deps);
    expect(deps.pickProvider).not.toHaveBeenCalled();
    expect(deps.readCcSwitchProvider).not.toHaveBeenCalled();
    // 默认=claude：--version 转发给 claude 后端（print 模式，非 TUI）
    expect(deps.runClaude).toHaveBeenCalledTimes(1);
    const args = deps.runClaude.mock.calls[0][0] as string[];
    expect(args).toContain("--version");
    expect(deps.runClaudeInteractive).not.toHaveBeenCalled();
  });
});

// ----------------------------------------------------------------------------
// 显式 --provider：picker 不介入，走原 matchProviderName 链路（验收点 8）
// ----------------------------------------------------------------------------

describe("run() 显式 --provider // picker 0 次调用", () => {
  it("TTY + --provider kimi → pickProvider 不被调用；--settings 仍按原链路注入", async () => {
    const runClaude = vi.fn(
      async (): Promise<SpawnResult> => ({
        stdout: "ok",
        stderr: "",
        exitCode: 0,
      }),
    );
    const deps = makeDeps({ runClaude, isInteractive: vi.fn(() => true) });
    const r = await run(["-p", "hi", "--provider", "kimi"], deps);
    expect(r.exitCode).toBe(0);
    expect(deps.pickProvider).not.toHaveBeenCalled();
    // 显式链路仍读 DB（matchProviderName）
    expect(deps.readCcSwitchProvider).toHaveBeenCalledTimes(1);
    const args = runClaude.mock.calls[0][0] as string[];
    const json = settingsJsonOf(args);
    expect(String(json.env.ANTHROPIC_BASE_URL)).toContain("kimi");
    expect(json.env.ANTHROPIC_MODEL).toBeTruthy();
  });
});

// ----------------------------------------------------------------------------
// picker 降级（C-D5）（验收点 9）
// ----------------------------------------------------------------------------

describe("run() picker 降级 // C-D5：警告一行 + 继续无注入 + exit code 不变", () => {
  it("lookup !ok（db-missing）→ stderr 含 'provider picker unavailable'，后端照常 spawn，无 --settings", async () => {
    const runClaude = vi.fn(
      async (): Promise<SpawnResult> => ({
        stdout: "ok",
        stderr: "",
        exitCode: 0,
      }),
    );
    const pickProvider = vi.fn(
      async (_names: string[]): Promise<string | undefined> => "GLM",
    );
    const deps = makeDeps({
      readCcSwitchProvider: vi.fn(async () => ({
        ok: false as const,
        kind: "db-missing" as const,
        message: "cc-switch.db not found",
      })),
      pickProvider,
      runClaude,
    });
    const r = await run(["-p", "hi"], deps);
    // 逐字契约片段：'gcli: provider picker unavailable: ...'
    expect(r.stderr).toContain("provider picker unavailable");
    // 降级不改变后端结果：spawn 成功 → exit 0
    expect(r.exitCode).toBe(0);
    // 无 names 可列，picker 不应被调用
    expect(pickProvider).not.toHaveBeenCalled();
    // 继续无注入
    expect(runClaude).toHaveBeenCalledTimes(1);
    const args = runClaude.mock.calls[0][0] as string[];
    expect(args).not.toContain("--settings");
  });

  it("lookup !ok + 后端失败 → exit 1（picker 降级不吞后端错误，exit code 由 spawn 结果决定）", async () => {
    const deps = makeDeps({
      readCcSwitchProvider: vi.fn(async () => ({
        ok: false as const,
        kind: "sqlite-missing" as const,
        message: "sqlite3 CLI not installed",
      })),
      runClaude: vi.fn(
        async (): Promise<SpawnResult> => ({
          stdout: "",
          stderr: "api error",
          exitCode: 1,
        }),
      ),
    });
    const r = await run(["-p", "hi"], deps);
    expect(r.stderr).toContain("provider picker unavailable");
    expect(r.exitCode).toBe(1);
  });

  it("providers=[] → stderr 含 'no cc-switch providers'，继续无注入，exit 0", async () => {
    const runClaude = vi.fn(
      async (): Promise<SpawnResult> => ({
        stdout: "ok",
        stderr: "",
        exitCode: 0,
      }),
    );
    const pickProvider = vi.fn(
      async (_names: string[]): Promise<string | undefined> => "GLM",
    );
    const deps = makeDeps({
      readCcSwitchProvider: vi.fn(async () => ({
        ok: true as const,
        providers: [],
      })),
      pickProvider,
      runClaude,
    });
    const r = await run(["-p", "hi"], deps);
    // 逐字契约片段：'gcli: no cc-switch providers configured'
    expect(r.stderr).toContain("no cc-switch providers");
    expect(r.exitCode).toBe(0);
    expect(runClaude).toHaveBeenCalledTimes(1);
    const args = runClaude.mock.calls[0][0] as string[];
    expect(args).not.toContain("--settings");
    // CONTRACT_AMBIGUOUS: 设计未显式声明空列表时是否仍调 pickProvider([])；
    // 按"空列表 → 警告 + 继续"语义推断 picker 被跳过。若蓝队选择调 pickProvider([])，
    // 此断言驱动契约明确化。
    expect(pickProvider).not.toHaveBeenCalled();
  });

  it("显式 --provider 路径硬失败不受降级影响：db-missing + --provider → exit 1（非继续）", async () => {
    const deps = makeDeps({
      readCcSwitchProvider: vi.fn(async () => ({
        ok: false as const,
        kind: "db-missing" as const,
        message: "cc-switch.db not found",
      })),
    });
    const r = await run(["-p", "hi", "--provider", "kimi"], deps);
    expect(r.exitCode).toBe(1);
    expect(deps.runClaude).not.toHaveBeenCalled();
    expect(deps.pickProvider).not.toHaveBeenCalled();
  });
});

// ----------------------------------------------------------------------------
// 交互 TUI 路径（C-D3/C-D4 在 interactive 分支同样成立）（验收点 10）
// ----------------------------------------------------------------------------

describe("run() 交互 TUI + picker // runClaudeInteractive 收到注入 args", () => {
  it("TTY + 无 -p + picker 选中 'GLM' → runClaudeInteractive args 含 --settings（glm env），且无 -p", async () => {
    const deps = makeDeps({
      isInteractive: vi.fn(() => true),
      pickProvider: vi.fn(
        async (_names: string[]): Promise<string | undefined> => "GLM",
      ),
    });
    const r = await run([], deps);
    expect(r.exitCode).toBe(0);
    expect(deps.runClaudeInteractive).toHaveBeenCalledTimes(1);
    expect(deps.runClaude).not.toHaveBeenCalled();
    const args = deps.runClaudeInteractive.mock.calls[0][0] as string[];
    expect(args).not.toContain("-p");
    const json = settingsJsonOf(args);
    expect(json.env.ANTHROPIC_BASE_URL).toBe("https://glm.example.com");
    expect(json.env.ANTHROPIC_MODEL).toBe("glm-5.2");
  });

  it("TUI picker 时序：pickProvider 先于 runClaudeInteractive 完成（C-D6）", async () => {
    const pickProvider = vi.fn(
      async (_names: string[]): Promise<string | undefined> => "GLM",
    );
    const deps = makeDeps({
      isInteractive: vi.fn(() => true),
      pickProvider,
    });
    await run([], deps);
    expect(pickProvider).toHaveBeenCalledTimes(1);
    expect(deps.runClaudeInteractive).toHaveBeenCalledTimes(1);
    expect(pickProvider.mock.invocationCallOrder[0]).toBeLessThan(
      deps.runClaudeInteractive.mock.invocationCallOrder[0],
    );
  });

  it("TUI + picker skip → runClaudeInteractive args 不含 --settings", async () => {
    const deps = makeDeps({
      isInteractive: vi.fn(() => true),
      pickProvider: vi.fn(
        async (_names: string[]): Promise<string | undefined> => undefined,
      ),
    });
    const r = await run([], deps);
    expect(r.exitCode).toBe(0);
    const args = deps.runClaudeInteractive.mock.calls[0][0] as string[];
    expect(args).not.toContain("--settings");
  });
});

// ----------------------------------------------------------------------------
// HELP（P1 / C-D7）（验收点 11）
// ----------------------------------------------------------------------------

describe("run() --help // P1：默认=claude 语义 + agy 显式子命令 + picker 说明", () => {
  it("stdout 含默认后端=claude 的说明（default 与 claude 同现），且仍含 agy 子命令说明", async () => {
    const deps = makeDeps();
    const r = await run(["--help"], deps);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.length).toBeGreaterThan(0);
    // C-D7：默认=claude；agy 需显式子命令
    expect(r.stdout).toContain("claude");
    expect(r.stdout).toContain("agy");
    expect(r.stdout.toLowerCase()).toContain("default");
    // 设计意图：default 与 claude 同现（同行优先；跨行亦接受，用 s 旗标兜底）
    expect(r.stdout).toMatch(/default[^\n]*claude|claude[^\n]*default/i);
    // C-D7：picker 行为写入 claude 段 Notes（措辞由蓝队定，但必须可检索到）
    // CONTRACT_AMBIGUOUS: picker 说明的具体文案未逐字规定，这里断言出现 pick/选择 之一。
    expect(r.stdout).toMatch(/pick|选择/i);
  });
});
