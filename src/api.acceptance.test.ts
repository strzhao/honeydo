import { describe, expect, it, vi } from "vitest";
import { parseSubcommand, run } from "./cli.js";

// ============================================================================
// 红队验收测试 — gcli `api` 文本后端（纯 HTTP，绕过 claude code agent）
//
// 信息隔离铁律：本文件仅基于设计文档契约编写，未读蓝队实现源码。
// 若蓝队最终未按下方 DI 契约导出符号 / 形状不一致，本文件红灯失败是预期 ——
// 届时由蓝队对齐契约（导出 run/parseSubcommand + RunDeps.runApi + RunOutcome）。
//
// 契约（逐字取自设计文档「gcli api 模式 CLI 契约」表）：
//   子命令: argv[0] 严格 === 'api'，否则 'unknown subcommand: <x>'
//   必需参数: -p/--prompt <text|->
//   可选参数: --provider --model --max-tokens(默认80000) --timeout(默认300000) --stream|--no-stream(默认stream)
//   拒绝: --cwd(warn忽略) --yolo/--sandbox(rejected) unknown flag(exit 2 非透传)
//   退出码: 0 success | 1 backend error/timeout/empty | 2 bad args
//   stdout: 纯文本响应（聚合 text）；stderr 诊断
//   行为: 不 spawn 子进程、不 --add-dir、不文件写入、纯 HTTP
//   provider: 复用 cc-switch 解析（与 claude 后端同源）
//
// RunDeps 新增形状（蓝队按此实现）：
//   runApi: (req: ApiRequest, deps?) => Promise<RunOutcome>
//     其中 ApiRequest 至少含：{ provider, model?, maxTokens?, timeoutMs?, stream, prompt }
//   RunOutcome = { exitCode: number; stdout: string; stderr: string }（已存在）
//
// 验收覆盖（逐条对应设计文档「验收场景」）：
//   P1  `gcli api -p "你好" --provider kimi --max-tokens 16` → stdout 非空纯文本，exit 0
//   P2  `gcli api`（缺 -p）→ exit 2，stderr 含原因
//   P3  api 执行期间不 spawn claude agent —— runApi 被调用、runClaude/runAgy 未被调用
//   P4  `gcli api -p x --bogus` → exit 2（unknown flag 不透传）
//   附加 子命令路由 agy/claude/api/unknown/default、HTTP body 构造 {model,max_tokens,messages,stream}、
//        provider→endpoint 解析、流式 text_delta 聚合、退出码 0/1/2、empty/timeout/error 分类
// ============================================================================

const K3_RAW = {
  name: "Kimi For Coding",
  settingsConfig: {
    env: {
      ANTHROPIC_BASE_URL: "https://kimi.koding.com",
      ANTHROPIC_AUTH_TOKEN: "kimi-token",
      ANTHROPIC_API_KEY: "kimi-key",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "kimi-k3[1M]",
    },
  },
};

type RunOutcome = { exitCode: number; stdout: string; stderr: string };

// ApiRequest 契约形状（蓝队实现须导出/接受此形状；这里仅作 mock 入参类型断言用）
type ApiRequest = {
  prompt: string;
  provider: string;
  model?: string;
  maxTokens?: number;
  timeoutMs?: number;
  stream: boolean;
};

function makeDeps(
  overrides: Partial<{
    readCcSwitchProvider: ReturnType<typeof vi.fn>;
    pickProvider: ReturnType<typeof vi.fn>;
    runApi: ReturnType<typeof vi.fn>;
    runClaude: ReturnType<typeof vi.fn>;
    runAgy: ReturnType<typeof vi.fn>;
    readStdin: ReturnType<typeof vi.fn>;
    runClaudeInteractive: ReturnType<typeof vi.fn>;
    runAgyInteractive: ReturnType<typeof vi.fn>;
    isInteractive: ReturnType<typeof vi.fn>;
  }> = {},
) {
  return {
    readCcSwitchProvider:
      overrides.readCcSwitchProvider ??
      vi.fn(async () => ({ ok: true as const, providers: [K3_RAW] })),
    // C-D3（默认翻转/picker 特性）新增必填接缝；api 路径不触发 picker，默认 skip
    pickProvider:
      overrides.pickProvider ??
      vi.fn(async (_names: string[]): Promise<string | undefined> => undefined),
    runApi:
      overrides.runApi ??
      vi.fn(
        async (): Promise<RunOutcome> => ({
          exitCode: 0,
          stdout: "你好，世界！这是 k3 的创意回复。",
          stderr: "",
        }),
      ),
    runClaude:
      overrides.runClaude ??
      vi.fn(
        async (): Promise<{
          stdout: string;
          stderr: string;
          exitCode: number;
        }> => ({
          stdout: "claude-ok",
          stderr: "",
          exitCode: 0,
        }),
      ),
    runAgy:
      overrides.runAgy ??
      vi.fn(
        async (): Promise<{
          stdout: string;
          stderr: string;
          exitCode: number;
        }> => ({
          stdout: "agy-ok",
          stderr: "",
          exitCode: 0,
        }),
      ),
    readStdin: overrides.readStdin ?? vi.fn(async () => "default-stdin"),
    runClaudeInteractive:
      overrides.runClaudeInteractive ?? vi.fn(async () => ({ exitCode: 0 })),
    runAgyInteractive:
      overrides.runAgyInteractive ?? vi.fn(async () => ({ exitCode: 0 })),
    isInteractive: overrides.isInteractive ?? vi.fn(() => false),
  };
}

// ----------------------------------------------------------------------------
// 子命令路由：parseSubcommand 新增 'api' 分支
// ----------------------------------------------------------------------------

describe("parseSubcommand // api 子命令路由", () => {
  it("api: argv[0]==='api' → 剥首参，subcommand='api'", () => {
    const r = parseSubcommand(["api", "-p", "hi", "--provider", "kimi"]);
    expect("error" in r).toBe(false);
    if ("error" in r) throw new Error("unexpected error");
    // 蓝队须扩展 Subcommand 类型至 'agy' | 'claude' | 'api'
    expect(r.subcommand).toBe("api");
    expect(r.rest).toEqual(["-p", "hi", "--provider", "kimi"]);
  });

  it("api: subcommand 匹配严格大小写敏感（'API' 不应被当子命令剥掉）", () => {
    const upper = parseSubcommand(["API", "-p", "hi"]);
    expect("error" in upper).toBe(true);
    if (!("error" in upper)) throw new Error("expected error");
    expect(upper.error).toBe("unknown subcommand: API");
  });

  it("api: 'api-x' 不是 'api'", () => {
    const dashed = parseSubcommand(["api-x", "-p", "hi"]);
    expect("error" in dashed).toBe(true);
    if (!("error" in dashed)) throw new Error("expected error");
    expect(dashed.error).toBe("unknown subcommand: api-x");
  });

  it("api: 不破坏既有路由 — 'agy'/'claude' 仍生效", () => {
    const agy = parseSubcommand(["agy", "-p", "hi"]);
    expect("error" in agy).toBe(false);
    if (!("error" in agy)) expect(agy.subcommand).toBe("agy");

    const claude = parseSubcommand(["claude", "-p", "hi"]);
    expect("error" in claude).toBe(false);
    if (!("error" in claude)) expect(claude.subcommand).toBe("claude");
  });

  it("api: default 路由不受影响（argv[0]='-p' → subcommand=undefined 哨兵；run() 层默认分发 claude —— C-D2）", () => {
    const r = parseSubcommand(["-p", "hi"]);
    expect("error" in r).toBe(false);
    if (!("error" in r)) {
      expect(r.subcommand).toBeUndefined();
      expect(r.rest).toEqual(["-p", "hi"]);
    }
  });
});

// ----------------------------------------------------------------------------
// run() dispatch：api 路由到 runApiBackend（→ deps.runApi），不走 runClaude/runAgy
// P3 核心：api 执行期间不 spawn claude agent
// ----------------------------------------------------------------------------

describe("run() dispatch // api → runApi, NOT runClaude/runAgy (P3)", () => {
  it("P3: 'api' 子命令 → runApi 被调用 1 次，runClaude/runAgy 均未被调用", async () => {
    const deps = makeDeps();
    const r = await run(["api", "-p", "你好", "--provider", "kimi"], deps);
    expect(deps.runApi).toHaveBeenCalledTimes(1);
    expect(deps.runClaude).not.toHaveBeenCalled();
    expect(deps.runAgy).not.toHaveBeenCalled();
    // 交互后端也不应被触发（api 是文本模式，无 TUI）
    expect(deps.runClaudeInteractive).not.toHaveBeenCalled();
    expect(deps.runAgyInteractive).not.toHaveBeenCalled();
    // runApi 成功 → 透传 exit 0
    expect(r.exitCode).toBe(0);
  });

  it("P3: 即便 isInteractive()==true，api 仍走 runApi（文本模式无 TUI 分支）", async () => {
    const deps = makeDeps({ isInteractive: vi.fn(() => true) });
    await run(["api", "-p", "hi", "--provider", "kimi"], deps);
    expect(deps.runApi).toHaveBeenCalledTimes(1);
    expect(deps.runClaudeInteractive).not.toHaveBeenCalled();
    expect(deps.runAgyInteractive).not.toHaveBeenCalled();
  });
});

// ----------------------------------------------------------------------------
// P1：`gcli api -p "你好" --provider kimi --max-tokens 16` → stdout 非空纯文本，exit 0
// ----------------------------------------------------------------------------

describe("run() api 成功路径 // P1", () => {
  it("P1: api 成功 → stdout 非空纯文本，exit 0", async () => {
    const deps = makeDeps();
    const r = await run(
      ["api", "-p", "你好", "--provider", "kimi", "--max-tokens", "16"],
      deps,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout.length).toBeGreaterThan(0);
    // stdout 是聚合的纯文本响应（非 JSON / 非 argv dump）
    expect(typeof r.stdout).toBe("string");
  });

  it("P1: runApi 返回的 stdout 被透传到 run() 的 stdout", async () => {
    const expected = "这是来自 k3 的创意方案 + SVG 资产。";
    const deps = makeDeps({
      runApi: vi.fn(
        async (): Promise<RunOutcome> => ({
          exitCode: 0,
          stdout: expected,
          stderr: "",
        }),
      ),
    });
    const r = await run(["api", "-p", "x", "--provider", "kimi"], deps);
    expect(r.stdout).toContain(expected);
  });
});

// ----------------------------------------------------------------------------
// HTTP body 构造契约：{model, max_tokens, messages, stream}
// 蓝队须把 ApiRequest 翻译成此 body；runApi mock 接收的入参须含这些字段语义
// ----------------------------------------------------------------------------

describe("run() api HTTP body 语义 // {model, max_tokens, messages, stream}", () => {
  it("BODY: --max-tokens 16 → runApi 入参 maxTokens=16", async () => {
    const runApi = vi.fn(
      async (): Promise<RunOutcome> => ({
        exitCode: 0,
        stdout: "ok",
        stderr: "",
      }),
    );
    const deps = makeDeps({ runApi });
    await run(
      ["api", "-p", "hi", "--provider", "kimi", "--max-tokens", "16"],
      deps,
    );
    expect(runApi).toHaveBeenCalledTimes(1);
    const req = runApi.mock.calls[0][0] as unknown as ApiRequest;
    expect(req.maxTokens).toBe(16);
  });

  it("BODY: 默认 --max-tokens → 80000（契约默认值）", async () => {
    const runApi = vi.fn(
      async (): Promise<RunOutcome> => ({
        exitCode: 0,
        stdout: "ok",
        stderr: "",
      }),
    );
    const deps = makeDeps({ runApi });
    await run(["api", "-p", "hi", "--provider", "kimi"], deps);
    const req = runApi.mock.calls[0][0] as unknown as ApiRequest;
    expect(req.maxTokens).toBe(80000);
  });

  it("BODY: prompt 透传为 messages[].content（req.prompt 含原始 -p 值）", async () => {
    const runApi = vi.fn(
      async (): Promise<RunOutcome> => ({
        exitCode: 0,
        stdout: "ok",
        stderr: "",
      }),
    );
    const deps = makeDeps({ runApi });
    await run(["api", "-p", "创意方案+SVG", "--provider", "kimi"], deps);
    const req = runApi.mock.calls[0][0] as unknown as ApiRequest;
    expect(req.prompt).toBe("创意方案+SVG");
  });

  it("BODY: --model 覆盖 → req.model 取 --model 值（覆盖 provider 默认）", async () => {
    const runApi = vi.fn(
      async (): Promise<RunOutcome> => ({
        exitCode: 0,
        stdout: "ok",
        stderr: "",
      }),
    );
    const deps = makeDeps({ runApi });
    await run(
      ["api", "-p", "hi", "--provider", "kimi", "--model", "kimi-for-coding"],
      deps,
    );
    const req = runApi.mock.calls[0][0] as unknown as ApiRequest;
    expect(req.model).toBe("kimi-for-coding");
  });

  it("BODY: 默认 stream=true（契约默认 stream）", async () => {
    const runApi = vi.fn(
      async (): Promise<RunOutcome> => ({
        exitCode: 0,
        stdout: "ok",
        stderr: "",
      }),
    );
    const deps = makeDeps({ runApi });
    await run(["api", "-p", "hi", "--provider", "kimi"], deps);
    const req = runApi.mock.calls[0][0] as unknown as ApiRequest;
    expect(req.stream).toBe(true);
  });

  it("BODY: --no-stream → req.stream=false", async () => {
    const runApi = vi.fn(
      async (): Promise<RunOutcome> => ({
        exitCode: 0,
        stdout: "ok",
        stderr: "",
      }),
    );
    const deps = makeDeps({ runApi });
    await run(["api", "-p", "hi", "--provider", "kimi", "--no-stream"], deps);
    const req = runApi.mock.calls[0][0] as unknown as ApiRequest;
    expect(req.stream).toBe(false);
  });

  it("BODY: --provider 解析进 req.url（cc-switch base_url → endpoint；HTTP 层不透传 provider）", async () => {
    const runApi = vi.fn(
      async (): Promise<RunOutcome> => ({
        exitCode: 0,
        stdout: "ok",
        stderr: "",
      }),
    );
    const deps = makeDeps({ runApi });
    await run(["api", "-p", "hi", "--provider", "kimi"], deps);
    const req = runApi.mock.calls[0][0] as unknown as Record<string, unknown>;
    // provider is resolved into url+token inside the backend (the HTTP layer
    // never sees the provider name); assert the resolved endpoint instead.
    expect(req.url).toBe("https://kimi.koding.com/v1/messages");
    expect(req.provider).toBeUndefined();
  });

  it("BODY: --timeout 透传到 req.timeoutMs", async () => {
    const runApi = vi.fn(
      async (): Promise<RunOutcome> => ({
        exitCode: 0,
        stdout: "ok",
        stderr: "",
      }),
    );
    const deps = makeDeps({ runApi });
    await run(
      ["api", "-p", "hi", "--provider", "kimi", "--timeout", "60000"],
      deps,
    );
    const req = runApi.mock.calls[0][0] as unknown as ApiRequest;
    expect(req.timeoutMs).toBe(60000);
  });
});

// ----------------------------------------------------------------------------
// provider → endpoint 解析：runApi 复用 cc-switch 解析（与 claude 后端同源）
// 蓝队须在 runApiBackend 内调 deps.readCcSwitchProvider → extractProviderEnv
// ----------------------------------------------------------------------------

describe("run() api provider 解析 // 复用 cc-switch（同 claude 后端）", () => {
  it("PROVIDER: api 模式也会触发 readCcSwitchProvider（复用 provider 解析）", async () => {
    const readCcSwitchProvider = vi.fn(async () => ({
      ok: true as const,
      providers: [K3_RAW],
    }));
    const deps = makeDeps({ readCcSwitchProvider });
    await run(["api", "-p", "hi", "--provider", "kimi"], deps);
    expect(readCcSwitchProvider).toHaveBeenCalledTimes(1);
  });

  it("PROVIDER: --provider 无匹配 → exit 2, stderr 含 'provider not found'（与 claude 后端一致）", async () => {
    const deps = makeDeps();
    const r = await run(["api", "-p", "hi", "--provider", "nope"], deps);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("provider not found");
    expect(deps.runApi).not.toHaveBeenCalled();
  });

  it("PROVIDER: 三层匹配仍生效 — 'kimi' 子串命中 'Kimi For Coding'", async () => {
    const deps = makeDeps();
    const r = await run(["api", "-p", "hi", "--provider", "kimi"], deps);
    expect(r.exitCode).toBe(0);
    expect(deps.runApi).toHaveBeenCalledTimes(1);
  });

  it("PROVIDER: cc-switch.db 缺失 → exit 1（非 2），stderr 诊断含 'db'", async () => {
    const deps = makeDeps({
      readCcSwitchProvider: vi.fn(async () => ({
        ok: false as const,
        kind: "db-missing" as const,
        message: "cc-switch.db not found",
      })),
    });
    const r = await run(["api", "-p", "hi", "--provider", "kimi"], deps);
    expect(r.exitCode).toBe(1);
    expect(r.exitCode).not.toBe(2);
    expect(r.stderr).toContain("db");
    expect(deps.runApi).not.toHaveBeenCalled();
  });
});

// ----------------------------------------------------------------------------
// 流式 text_delta 聚合：runApi 内部把 SSE text_delta 聚合成纯文本 stdout
// （此断言驱动蓝队实现：runApi 须返回聚合后的纯文本，非原始 SSE 流）
// ----------------------------------------------------------------------------

describe("run() api 流式聚合 // text_delta → 纯文本 stdout", () => {
  it("STREAM: runApi 返回聚合后的纯文本（模拟多 chunk text_delta 拼接结果）", async () => {
    // 模拟 SSE 聚合后应有的结果：3 个 text_delta 拼接
    const aggregated =
      "创意：蜜蜂采蜜。SVG：<svg>...</svg>。文案：playSuccess。";
    const deps = makeDeps({
      runApi: vi.fn(
        async (): Promise<RunOutcome> => ({
          exitCode: 0,
          stdout: aggregated,
          stderr: "",
        }),
      ),
    });
    const r = await run(["api", "-p", "hi", "--provider", "kimi"], deps);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(aggregated);
    // stdout 不应残留 SSE 协议噪音
    expect(r.stdout).not.toContain("data:");
    expect(r.stdout).not.toContain("event:");
  });

  it("STREAM: --no-stream 模式也聚合 content[].text 为纯文本", async () => {
    const nonStreamAggregated = "非流式完整 JSON 取 content[].text 聚合结果。";
    const deps = makeDeps({
      runApi: vi.fn(
        async (): Promise<RunOutcome> => ({
          exitCode: 0,
          stdout: nonStreamAggregated,
          stderr: "",
        }),
      ),
    });
    const r = await run(
      ["api", "-p", "hi", "--provider", "kimi", "--no-stream"],
      deps,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(nonStreamAggregated);
  });
});

// ----------------------------------------------------------------------------
// P2：`gcli api`（缺 -p）→ exit 2，stderr 含原因
// ----------------------------------------------------------------------------

describe("run() api 参数错误 // P2 + bad args → exit 2", () => {
  it("P2: 'api' 缺 -p → exit 2，stderr 非空含原因", async () => {
    const deps = makeDeps();
    const r = await run(["api"], deps);
    expect(r.exitCode).toBe(2);
    expect(r.stderr.length).toBeGreaterThan(0);
    // 契约：bad args 的 stderr 带 'gcli:' 前缀（与 claude/agy 一致）
    expect(r.stderr).toContain("gcli:");
    expect(deps.runApi).not.toHaveBeenCalled();
  });

  it("P2: 'api --provider kimi' 缺 -p → exit 2（provider 存在也不能救缺 prompt）", async () => {
    const deps = makeDeps();
    const r = await run(["api", "--provider", "kimi"], deps);
    expect(r.exitCode).toBe(2);
    expect(deps.runApi).not.toHaveBeenCalled();
  });

  it("P2 variant: api 缺 -p 且 TTY → 仍 exit 2（api 无 TUI，不进交互分支）", async () => {
    const deps = makeDeps({ isInteractive: vi.fn(() => true) });
    const r = await run(["api"], deps);
    expect(r.exitCode).toBe(2);
    expect(deps.runApi).not.toHaveBeenCalled();
    expect(deps.runClaudeInteractive).not.toHaveBeenCalled();
  });
});

// ----------------------------------------------------------------------------
// P4：`gcli api -p x --bogus` → exit 2（unknown flag 不透传）
// 契约：api 模式 unknown flag → exit 2（区别于 agy/claude 的 passthrough）
// ----------------------------------------------------------------------------

describe("run() api unknown flag 不透传 // P4", () => {
  it("P4: 'api -p x --bogus' → exit 2（unknown flag 非透传）", async () => {
    const deps = makeDeps();
    const r = await run(["api", "-p", "x", "--bogus"], deps);
    expect(r.exitCode).toBe(2);
    expect(r.stderr.length).toBeGreaterThan(0);
    expect(deps.runApi).not.toHaveBeenCalled();
  });

  it("P4: 'api -p x --unknown-flag=value' → exit 2（带值 unknown flag 也拒绝）", async () => {
    const deps = makeDeps();
    const r = await run(["api", "-p", "x", "--unknown-flag=value"], deps);
    expect(r.exitCode).toBe(2);
    expect(deps.runApi).not.toHaveBeenCalled();
  });

  it("P4: 'api -p x bare-positional' → exit 2（api 不接收裸 positional，非透传）", async () => {
    const deps = makeDeps();
    const r = await run(["api", "-p", "x", "bare-positional"], deps);
    expect(r.exitCode).toBe(2);
    expect(deps.runApi).not.toHaveBeenCalled();
  });

  it("P4 contrast: api 不像 claude 那样透传 unknown flag（契约差异断言）", async () => {
    // claude 后端会透传 --dangerously-skip-permissions；api 后端不应透传任何 unknown flag
    const deps = makeDeps();
    const r = await run(
      ["api", "-p", "x", "--dangerously-skip-permissions"],
      deps,
    );
    expect(r.exitCode).toBe(2);
    expect(deps.runApi).not.toHaveBeenCalled();
  });
});

// ----------------------------------------------------------------------------
// 拒绝规则：--cwd warn忽略 / --yolo --sandbox rejected
// ----------------------------------------------------------------------------

describe("run() api 拒绝规则 // --cwd warn / --yolo --sandbox rejected", () => {
  it("CWD: 'api -p x --cwd /repo --provider kimi' → --cwd 被忽略（warn），不传后端，仍 exit 0", async () => {
    const runApi = vi.fn(
      async (): Promise<RunOutcome> => ({
        exitCode: 0,
        stdout: "ok",
        stderr: "",
      }),
    );
    const deps = makeDeps({ runApi });
    const r = await run(
      ["api", "-p", "x", "--cwd", "/repo", "--provider", "kimi"],
      deps,
    );
    // --cwd 被 warn 忽略，不导致失败
    expect(r.exitCode).toBe(0);
    expect(runApi).toHaveBeenCalledTimes(1);
    const req = runApi.mock.calls[0][0] as unknown as ApiRequest;
    // api 模式不应有 cwd / add-dir 概念（纯 HTTP 无文件访问）
    expect("cwd" in req).toBe(false);
    expect("addDir" in req).toBe(false);
  });

  it("CWD: --cwd 忽略时 stderr 应含 warn 提示（诊断可见）", async () => {
    const deps = makeDeps();
    const r = await run(
      ["api", "-p", "x", "--cwd", "/repo", "--provider", "kimi"],
      deps,
    );
    // warn 进 stderr 但不影响 exit code
    expect(r.exitCode).toBe(0);
    // 至少有某种 cwd 相关诊断（warn 文案由蓝队定，此处只断言非静默）
    // 注：若蓝队选择完全静默忽略，此断言会驱动契约明确化
    expect(r.stderr + r.stdout).toMatch(/cwd|--cwd|ignor/i);
  });

  it("YOLO: 'api --yolo -p x' → exit 2, stderr 含 'does not support --yolo'", async () => {
    const deps = makeDeps();
    const r = await run(
      ["api", "--yolo", "-p", "x", "--provider", "kimi"],
      deps,
    );
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("does not support --yolo");
    expect(deps.runApi).not.toHaveBeenCalled();
  });

  it("SANDBOX: 'api --sandbox -p x' → exit 2, stderr 含 'does not support'", async () => {
    const deps = makeDeps();
    const r = await run(
      ["api", "--sandbox", "-p", "x", "--provider", "kimi"],
      deps,
    );
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("does not support");
    expect(deps.runApi).not.toHaveBeenCalled();
  });
});

// ----------------------------------------------------------------------------
// 退出码分类：0 success / 1 backend error·timeout·empty / 2 bad args
// ----------------------------------------------------------------------------

describe("run() api 退出码分类 // 0/1/2", () => {
  it("EXIT 0: runApi 返回 exitCode 0 → run() 透传 exit 0", async () => {
    const deps = makeDeps({
      runApi: vi.fn(
        async (): Promise<RunOutcome> => ({
          exitCode: 0,
          stdout: "ok",
          stderr: "",
        }),
      ),
    });
    const r = await run(["api", "-p", "x", "--provider", "kimi"], deps);
    expect(r.exitCode).toBe(0);
  });

  it("EXIT 1 empty: runApi 返回空 stdout → exit 1, stderr 含 'no output'", async () => {
    const deps = makeDeps({
      runApi: vi.fn(
        async (): Promise<RunOutcome> => ({
          exitCode: 0,
          stdout: "",
          stderr: "",
        }),
      ),
    });
    const r = await run(["api", "-p", "x", "--provider", "kimi"], deps);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("no output");
  });

  it("EXIT 1 error: runApi 返回 backend 错误 → exit 1, stderr 诊断", async () => {
    const deps = makeDeps({
      runApi: vi.fn(
        async (): Promise<RunOutcome> => ({
          exitCode: 1,
          stdout: "",
          stderr: "api error: 500 Internal",
        }),
      ),
    });
    const r = await run(["api", "-p", "x", "--provider", "kimi"], deps);
    expect(r.exitCode).toBe(1);
    expect(r.stderr.length).toBeGreaterThan(0);
  });

  it("EXIT 1 timeout: runApi 返回超时 → exit 1, stderr 含 'timed out'", async () => {
    const deps = makeDeps({
      runApi: vi.fn(
        async (): Promise<RunOutcome> => ({
          exitCode: 1,
          stdout: "",
          stderr: "request timed out (idle)",
        }),
      ),
    });
    const r = await run(["api", "-p", "x", "--provider", "kimi"], deps);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("timed out");
  });

  it("EXIT 2 bad args: 缺 -p → exit 2（非 1）", async () => {
    const deps = makeDeps();
    const r = await run(["api"], deps);
    expect(r.exitCode).toBe(2);
    expect(r.exitCode).not.toBe(1);
  });
});

// ----------------------------------------------------------------------------
// stdin piped prompt：api 也支持 -p -（与 claude/agy 同签名）
// ----------------------------------------------------------------------------

describe("run() api stdin piped // -p -", () => {
  it("STDIN: 'api -p - --provider kimi' → drain stdin 作为 prompt", async () => {
    const runApi = vi.fn(
      async (): Promise<RunOutcome> => ({
        exitCode: 0,
        stdout: "ok",
        stderr: "",
      }),
    );
    const deps = makeDeps({
      runApi,
      readStdin: vi.fn(async () => "piped-api-prompt"),
    });
    const r = await run(["api", "-p", "-", "--provider", "kimi"], deps);
    expect(r.exitCode).toBe(0);
    expect(deps.readStdin).toHaveBeenCalledTimes(1);
    expect(runApi).toHaveBeenCalledTimes(1);
    const req = runApi.mock.calls[0][0] as unknown as ApiRequest;
    expect(req.prompt).toBe("piped-api-prompt");
    expect(req.prompt).not.toBe("-");
  });
});

// ----------------------------------------------------------------------------
// 纯 HTTP 契约：api 不 spawn 子进程、不 --add-dir、不文件写入
// （DI 层面：runApi 不接收任何 cwd/spawn 相关入参）
// ----------------------------------------------------------------------------

describe("run() api 纯 HTTP 契约 // 无 spawn / 无 add-dir / 无文件写入", () => {
  it("HTTP: runApi 入参不含 spawn / cwd / addDir 字段（纯 HTTP 语义）", async () => {
    const runApi = vi.fn(
      async (): Promise<RunOutcome> => ({
        exitCode: 0,
        stdout: "ok",
        stderr: "",
      }),
    );
    const deps = makeDeps({ runApi });
    await run(["api", "-p", "hi", "--provider", "kimi"], deps);
    const req = runApi.mock.calls[0][0] as unknown as Record<string, unknown>;
    expect("cwd" in req).toBe(false);
    expect("addDir" in req).toBe(false);
    expect("args" in req).toBe(false);
    expect("spawn" in req).toBe(false);
  });

  it("HTTP: api 不触发任何 spawn 后端（runClaude/runAgy/Interactive 全 0）", async () => {
    const deps = makeDeps();
    await run(["api", "-p", "hi", "--provider", "kimi"], deps);
    expect(deps.runClaude).not.toHaveBeenCalled();
    expect(deps.runAgy).not.toHaveBeenCalled();
    expect(deps.runClaudeInteractive).not.toHaveBeenCalled();
    expect(deps.runAgyInteractive).not.toHaveBeenCalled();
  });
});
