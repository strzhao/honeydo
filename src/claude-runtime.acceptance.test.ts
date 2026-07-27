import { describe, expect, it, vi } from "vitest";
import { CHARACTER_LIMIT, run, truncate } from "./cli.js";

// ============================================================================
// 契约（DI 接口，蓝队按此实现 run 与 deps）：
//
//   type RawProvider = { name: string; settingsConfig: unknown };
//   type ProviderLookup =
//     | { ok: true; providers: RawProvider[] }
//     | { ok: false; kind: "db-missing" | "sqlite-missing" | "parse"; message: string };
//   type SpawnResult = { stdout: string; stderr: string; exitCode: number; signal?: string | null; timedOut?: boolean };
//   type RunDeps = {
//     readCcSwitchProvider: () => Promise<ProviderLookup>;
//     runClaude: (args: string[]) => Promise<SpawnResult>;
//     runAgy: (args: string[]) => Promise<SpawnResult>;
//     readStdin: () => Promise<string>;
//   };
//   type RunResult = { exitCode: number; stdout: string; stderr: string };
//   function run(argv: string[], deps: RunDeps): Promise<RunResult>;
//
// C2 exit-code 映射：0 成功 / 1 运行错误·超时·空输出 / 2 参数错误（stderr "gcli:" 前缀）。
//
// 验收覆盖：
//   ACC-1  无子命令默认 agy
//   ACC-2  `gcli agy` → agy
//   ACC-6  provider 不存在 → exit 2，stderr 含 "provider not found"
//   ACC-10 缺 -p / 未知子命令 → exit 2，stderr 非空
//   ACC-11 claude 非零退出 → exit 1，stderr 含 "claude failed"
//   ACC-12 超时 → exit 1，stderr 含 "timed out"
//   ACC-13 空输出 → exit 1，stderr 含 "no output"
//   ACC-14 stdout>50000 → 含 "[Truncated"
//   ACC-15 db 缺失 / sqlite3 未装 → exit 1（非 2），stderr 含诊断
//   ACC-16 `gcli claude -p -` stdin piped → prompt=stdin 内容
//   ACC-22 `gcli claude --yolo -p hi` → exit 2，stderr 含 "does not support --yolo"
// ============================================================================

// CONTRACT_AMBIGUITY 兜底说明：若蓝队最终未导出 `run`（或签名不同），
// 本文件红灯失败是预期 —— 届时由蓝队按上述 DI 契约导出 run 并对齐形状。
// ACC-7 的进程层（不改 ~/.claude/settings.json）由 buildClaudeArgs 纯函数断言
// 在 claude-args.acceptance.test.ts 已覆盖；run 层不再重复 fs.assertion。

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
    readStdin: overrides.readStdin ?? vi.fn(async () => "default-stdin"),
    runClaudeInteractive:
      overrides.runClaudeInteractive ?? vi.fn(async () => ({ exitCode: 0 })),
    runAgyInteractive:
      overrides.runAgyInteractive ?? vi.fn(async () => ({ exitCode: 0 })),
    // Default: non-TTY (pipe/CI) — preserves ACC-19/10 exit-2 semantics.
    isInteractive: overrides.isInteractive ?? vi.fn(() => false),
  };
}

describe("run() dispatch // ACC-1/2", () => {
  it("ACC-1: no subcommand → dispatches to runAgy, NOT runClaude", async () => {
    const deps = makeDeps();
    const r = await run(["-p", "hi"], deps);
    expect(deps.runAgy).toHaveBeenCalledTimes(1);
    expect(deps.runClaude).not.toHaveBeenCalled();
    expect(r.exitCode).toBe(0);
  });

  it("ACC-2: explicit 'agy' subcommand → dispatches to runAgy", async () => {
    const deps = makeDeps();
    const r = await run(["agy", "-p", "hi"], deps);
    expect(deps.runAgy).toHaveBeenCalledTimes(1);
    expect(deps.runClaude).not.toHaveBeenCalled();
    expect(r.exitCode).toBe(0);
  });

  it("ACC-1/2: 'claude' subcommand → dispatches to runClaude, NOT runAgy", async () => {
    const deps = makeDeps();
    const r = await run(["claude", "-p", "hi"], deps);
    expect(deps.runClaude).toHaveBeenCalledTimes(1);
    expect(deps.runAgy).not.toHaveBeenCalled();
    expect(r.exitCode).toBe(0);
  });
});

describe("run() provider resolution // ACC-6/15 + ACC-4 injection path", () => {
  it("ACC-6: --provider with no match → exit 2, stderr contains 'provider not found'", async () => {
    const deps = makeDeps({
      readCcSwitchProvider: vi.fn(async () => ({
        ok: true as const,
        providers: [K3_RAW],
      })),
    });
    const r = await run(["claude", "-p", "hi", "--provider", "nope"], deps);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("provider not found");
    expect(deps.runClaude).not.toHaveBeenCalled();
  });

  it("ACC-15: cc-switch.db missing → exit 1 (NOT 2), stderr diagnostic contains 'db'", async () => {
    const deps = makeDeps({
      readCcSwitchProvider: vi.fn(async () => ({
        ok: false as const,
        kind: "db-missing" as const,
        message: "cc-switch.db not found",
      })),
    });
    const r = await run(["claude", "-p", "hi", "--provider", "kimi"], deps);
    expect(r.exitCode).toBe(1);
    expect(r.exitCode).not.toBe(2);
    expect(r.stderr.length).toBeGreaterThan(0);
    expect(r.stderr).toContain("db");
    expect(deps.runClaude).not.toHaveBeenCalled();
  });

  it("ACC-15 variant: sqlite3 not installed → exit 1 (NOT 2), stderr diagnostic", async () => {
    const deps = makeDeps({
      readCcSwitchProvider: vi.fn(async () => ({
        ok: false as const,
        kind: "sqlite-missing" as const,
        message: "sqlite3 CLI not installed",
      })),
    });
    const r = await run(["claude", "-p", "hi", "--provider", "kimi"], deps);
    expect(r.exitCode).toBe(1);
    expect(r.exitCode).not.toBe(2);
    expect(r.stderr.length).toBeGreaterThan(0);
  });

  it("ACC-4 path: --provider k3 → runClaude args contain --settings with kimi base + ANTHROPIC_MODEL set", async () => {
    const runClaude = vi.fn(
      async (): Promise<SpawnResult> => ({
        stdout: "ok",
        stderr: "",
        exitCode: 0,
      }),
    );
    const deps = makeDeps({ runClaude });
    const r = await run(["claude", "-p", "hi", "--provider", "kimi"], deps);
    expect(r.exitCode).toBe(0);
    expect(runClaude).toHaveBeenCalledTimes(1);
    const args = runClaude.mock.calls[0][0] as string[];
    const idx = args.indexOf("--settings");
    expect(idx).toBeGreaterThan(-1);
    const json = JSON.parse(args[idx + 1]);
    expect(String(json.env.ANTHROPIC_BASE_URL)).toContain("kimi");
    expect(json.env.ANTHROPIC_MODEL).toBeTruthy();
  });

  it("ACC-21 runtime: provider settings_config is malformed → exit 1 (NOT 2), stderr diagnostic", async () => {
    const deps = makeDeps({
      readCcSwitchProvider: vi.fn(async () => ({
        ok: true as const,
        providers: [
          { name: "Kimi For Coding", settingsConfig: "not-valid-json{" },
        ],
      })),
    });
    const r = await run(["claude", "-p", "hi", "--provider", "kimi"], deps);
    expect(r.exitCode).toBe(1);
    expect(r.exitCode).not.toBe(2);
    expect(r.stderr.length).toBeGreaterThan(0);
    expect(deps.runClaude).not.toHaveBeenCalled();
  });

  it("ACC-21 runtime: provider settings_config missing 'env' → exit 1, stderr diagnostic", async () => {
    const deps = makeDeps({
      readCcSwitchProvider: vi.fn(async () => ({
        ok: true as const,
        providers: [
          { name: "Kimi For Coding", settingsConfig: { permissions: {} } },
        ],
      })),
    });
    const r = await run(["claude", "-p", "hi", "--provider", "kimi"], deps);
    expect(r.exitCode).toBe(1);
    expect(r.exitCode).not.toBe(2);
    expect(r.stderr.length).toBeGreaterThan(0);
    expect(deps.runClaude).not.toHaveBeenCalled();
  });

  it("ACC-20 path: duplicate provider names → exit 2 ambiguous, stderr lists candidates", async () => {
    const dup = {
      name: "Claude Official",
      settingsConfig: { env: { ANTHROPIC_BASE_URL: "https://x" } },
    };
    const deps = makeDeps({
      readCcSwitchProvider: vi.fn(async () => ({
        ok: true as const,
        providers: [dup, { ...dup }],
      })),
    });
    const r = await run(
      ["claude", "-p", "hi", "--provider", "claude official"],
      deps,
    );
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("ambiguous");
    expect(r.stderr).toContain("Claude Official");
    expect(deps.runClaude).not.toHaveBeenCalled();
  });
});

describe("run() claude runtime errors // ACC-11/12/13/14", () => {
  it("ACC-11: claude exits non-zero → exit 1, stderr contains 'claude failed'", async () => {
    const deps = makeDeps({
      runClaude: vi.fn(
        async (): Promise<SpawnResult> => ({
          stdout: "",
          stderr: "api error",
          exitCode: 1,
        }),
      ),
    });
    const r = await run(["claude", "-p", "hi"], deps);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("claude failed");
  });

  it("ACC-12: claude timed out (SIGTERM) → exit 1, stderr contains 'timed out'", async () => {
    const deps = makeDeps({
      runClaude: vi.fn(
        async (): Promise<SpawnResult> => ({
          stdout: "",
          stderr: "",
          exitCode: null as unknown as number,
          signal: "SIGTERM",
          timedOut: true,
        }),
      ),
    });
    const r = await run(["claude", "-p", "hi", "--timeout", "1000"], deps);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("timed out");
  });

  it("ACC-13: claude returns empty stdout → exit 1, stderr contains 'no output'", async () => {
    const deps = makeDeps({
      runClaude: vi.fn(
        async (): Promise<SpawnResult> => ({
          stdout: "",
          stderr: "",
          exitCode: 0,
        }),
      ),
    });
    const r = await run(["claude", "-p", "hi"], deps);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("no output");
  });

  it("ACC-14: claude stdout > 50000 chars → run stdout contains '[Truncated' and is shorter", async () => {
    const long = "a".repeat(CHARACTER_LIMIT + 5000);
    const deps = makeDeps({
      runClaude: vi.fn(
        async (): Promise<SpawnResult> => ({
          stdout: long,
          stderr: "",
          exitCode: 0,
        }),
      ),
    });
    const r = await run(["claude", "-p", "hi"], deps);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("[Truncated");
    expect(r.stdout.length).toBeLessThan(long.length);
  });

  it("ACC-14 (pure fn cross-check): truncate() is the mechanism and caps at CHARACTER_LIMIT", () => {
    const long = "a".repeat(CHARACTER_LIMIT + 100);
    const out = truncate(long);
    expect(out).toContain("[Truncated");
    expect(out.length).toBeLessThan(long.length);
  });
});

describe("run() argv errors // ACC-10/19/22 + missing-prompt", () => {
  it("ACC-19: empty argv → default agy dispatch, exit 2 (missing -p), stderr non-empty", async () => {
    const deps = makeDeps();
    const r = await run([], deps);
    // 默认走 agy 分派，但缺 -p 必须参数错误退出
    expect(r.exitCode).toBe(2);
    expect(r.stderr.length).toBeGreaterThan(0);
    expect(deps.runAgy).not.toHaveBeenCalled();
    expect(deps.runClaude).not.toHaveBeenCalled();
  });

  it("ACC-19 variant: explicit 'agy' without -p → exit 2, stderr non-empty", async () => {
    const deps = makeDeps();
    const r = await run(["agy"], deps);
    expect(r.exitCode).toBe(2);
    expect(r.stderr.length).toBeGreaterThan(0);
    expect(deps.runAgy).not.toHaveBeenCalled();
  });

  it("ACC-10: claude subcommand without -p → exit 2, non-empty stderr with 'gcli:' prefix", async () => {
    const deps = makeDeps();
    const r = await run(["claude"], deps);
    expect(r.exitCode).toBe(2);
    expect(r.stderr.length).toBeGreaterThan(0);
    expect(r.stderr).toContain("gcli:");
    expect(deps.runClaude).not.toHaveBeenCalled();
  });

  it("ACC-10/18: unknown subcommand 'foo' → exit 2, stderr contains 'unknown subcommand'", async () => {
    const deps = makeDeps();
    const r = await run(["foo", "-p", "hi"], deps);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("unknown subcommand");
    expect(deps.runAgy).not.toHaveBeenCalled();
    expect(deps.runClaude).not.toHaveBeenCalled();
  });

  it("ACC-22: 'claude --yolo -p hi' → exit 2, stderr contains 'does not support --yolo'", async () => {
    const deps = makeDeps();
    const r = await run(["claude", "--yolo", "-p", "hi"], deps);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("does not support --yolo");
    expect(deps.runClaude).not.toHaveBeenCalled();
  });

  it("ACC-22 variant: 'claude --sandbox -p hi' → exit 2, stderr mentions --sandbox unsupported", async () => {
    const deps = makeDeps();
    const r = await run(["claude", "--sandbox", "-p", "hi"], deps);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("does not support");
    expect(deps.runClaude).not.toHaveBeenCalled();
  });
});

describe("run() stdin piped prompt // ACC-16", () => {
  it("ACC-16: 'claude -p -' drains stdin and passes drained content as prompt to runClaude", async () => {
    const runClaude = vi.fn(
      async (): Promise<SpawnResult> => ({
        stdout: "ok",
        stderr: "",
        exitCode: 0,
      }),
    );
    const deps = makeDeps({
      runClaude,
      readStdin: vi.fn(async () => "piped-prompt-body"),
    });
    const r = await run(["claude", "-p", "-"], deps);
    expect(r.exitCode).toBe(0);
    expect(deps.readStdin).toHaveBeenCalledTimes(1);
    expect(runClaude).toHaveBeenCalledTimes(1);
    const args = runClaude.mock.calls[0][0] as string[];
    // '-p' 后紧跟的应是 drain 出来的 stdin 内容，而非字面 '-'
    const pIdx = args.indexOf("-p");
    expect(pIdx).toBeGreaterThan(-1);
    expect(args[pIdx + 1]).toBe("piped-prompt-body");
    expect(args[pIdx + 1]).not.toBe("-");
  });

  it("ACC-16 default-agy variant: 'agy -p -' also drains stdin for agy backend", async () => {
    const runAgy = vi.fn(
      async (): Promise<SpawnResult> => ({
        stdout: "ok",
        stderr: "",
        exitCode: 0,
      }),
    );
    const deps = makeDeps({
      runAgy,
      readStdin: vi.fn(async () => "piped-for-agy"),
    });
    const r = await run(["agy", "-p", "-"], deps);
    expect(r.exitCode).toBe(0);
    expect(deps.readStdin).toHaveBeenCalledTimes(1);
    const args = runAgy.mock.calls[0][0] as string[];
    const pIdx = args.indexOf("-p");
    expect(args[pIdx + 1]).toBe("piped-for-agy");
  });
});

describe("run() interactive mode // INT-1..8 (TTY, no -p)", () => {
  const tty = () => true;

  it("INT-1: empty argv + TTY → runAgyInteractive called, no -p, exit 0", async () => {
    const deps = makeDeps({ isInteractive: vi.fn(tty) });
    const r = await run([], deps);
    expect(deps.runAgyInteractive).toHaveBeenCalledTimes(1);
    expect(deps.runAgy).not.toHaveBeenCalled();
    expect(r.exitCode).toBe(0);
    const args = deps.runAgyInteractive.mock.calls[0][0] as string[];
    expect(args).not.toContain("-p");
  });

  it("INT-2: 'claude' + TTY → runClaudeInteractive called, no -p", async () => {
    const deps = makeDeps({ isInteractive: vi.fn(tty) });
    const r = await run(["claude"], deps);
    expect(deps.runClaudeInteractive).toHaveBeenCalledTimes(1);
    expect(deps.runClaude).not.toHaveBeenCalled();
    expect(r.exitCode).toBe(0);
    const args = deps.runClaudeInteractive.mock.calls[0][0] as string[];
    expect(args).not.toContain("-p");
  });

  it("INT-3: 'claude --provider kimi' + TTY → --settings injected with kimi env", async () => {
    const deps = makeDeps({ isInteractive: vi.fn(tty) });
    const r = await run(["claude", "--provider", "kimi"], deps);
    expect(r.exitCode).toBe(0);
    expect(deps.runClaudeInteractive).toHaveBeenCalledTimes(1);
    const args = deps.runClaudeInteractive.mock.calls[0][0] as string[];
    expect(args).not.toContain("-p");
    const idx = args.indexOf("--settings");
    expect(idx).toBeGreaterThan(-1);
    const json = JSON.parse(args[idx + 1]);
    expect(String(json.env.ANTHROPIC_BASE_URL)).toContain("kimi");
    expect(json.env.ANTHROPIC_MODEL).toBeTruthy();
  });

  it("INT-4a: interactive passes exit 0 through", async () => {
    const deps = makeDeps({
      isInteractive: vi.fn(tty),
      runClaudeInteractive: vi.fn(async () => ({ exitCode: 0 })),
    });
    const r = await run(["claude"], deps);
    expect(r.exitCode).toBe(0);
  });

  it("INT-4b: interactive passes Ctrl-C exit 130 through (NOT remapped to 1)", async () => {
    const deps = makeDeps({
      isInteractive: vi.fn(tty),
      runClaudeInteractive: vi.fn(async () => ({
        exitCode: 130,
        signal: "SIGINT",
      })),
    });
    const r = await run(["claude"], deps);
    expect(r.exitCode).toBe(130);
  });

  it("INT-5: non-TTY + no -p → exit 2 (TTY guard, no hang)", async () => {
    const deps = makeDeps({ isInteractive: vi.fn(() => false) });
    const r = await run(["claude"], deps);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("gcli:");
    expect(r.stderr).toContain("TTY");
    expect(deps.runClaudeInteractive).not.toHaveBeenCalled();
  });

  it("INT-6: 'claude --yolo' + TTY → exit 2 (yolo rejected before interactive)", async () => {
    const deps = makeDeps({ isInteractive: vi.fn(tty) });
    const r = await run(["claude", "--yolo"], deps);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("does not support --yolo");
    expect(deps.runClaudeInteractive).not.toHaveBeenCalled();
  });

  it("INT-7: '--version' + TTY → version, not TUI", async () => {
    const deps = makeDeps({ isInteractive: vi.fn(tty) });
    await run(["--version"], deps);
    expect(deps.runAgy).toHaveBeenCalledWith(["--version"], expect.anything());
    expect(deps.runAgyInteractive).not.toHaveBeenCalled();
  });

  it("INT-8: 'claude --cwd /repo' + TTY → --add-dir passed, no -p", async () => {
    const deps = makeDeps({ isInteractive: vi.fn(tty) });
    await run(["claude", "--cwd", "/repo"], deps);
    const args = deps.runClaudeInteractive.mock.calls[0][0] as string[];
    const idx = args.indexOf("--add-dir");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("/repo");
    expect(args).not.toContain("-p");
  });

  it("PASSTHROUGH: 'claude -p hi -- --flag' → runClaude argv contains --flag (no injected --)", async () => {
    const runClaude = vi.fn(
      async (): Promise<SpawnResult> => ({
        stdout: "ok",
        stderr: "",
        exitCode: 0,
      }),
    );
    const deps = makeDeps({ runClaude });
    const r = await run(
      ["claude", "-p", "hi", "--", "--dangerously-skip-permissions"],
      deps,
    );
    expect(r.exitCode).toBe(0);
    const args = runClaude.mock.calls[0][0] as string[];
    expect(args).toContain("--dangerously-skip-permissions");
    // gcli must NOT inject its own `--` (backend would treat the flag as positional)
    expect(args.filter((a) => a === "--").length).toBe(0);
  });

  it("PASSTHROUGH: 'claude -- --flag' + TTY → interactive argv contains --flag", async () => {
    const deps = makeDeps({ isInteractive: vi.fn(tty) });
    await run(["claude", "--", "--dangerously-skip-permissions"], deps);
    const args = deps.runClaudeInteractive.mock.calls[0][0] as string[];
    expect(args).toContain("--dangerously-skip-permissions");
    expect(args.filter((a) => a === "--").length).toBe(0);
  });
});
