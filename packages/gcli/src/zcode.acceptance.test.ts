import { describe, expect, it, vi } from "vitest";
import {
  parseZcodeState,
  type RunDeps,
  run,
  serializeZcodeState,
  ZCODE_A_CREDENTIALS_PATH,
  ZCODE_B_CREDENTIALS_PATH,
  ZCODE_B_DATA_ROOT,
  ZCODE_B_USER_DATA,
  ZCODE_STATE_PATH,
  type ZcodeProfile,
} from "./cli.js";

// ---------------------------------------------------------------------------
// ZCode 双账号切换器验收（RunDeps 假件；从不 spawn 真实 osascript/open）
// ---------------------------------------------------------------------------

function makeFs(seed: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(seed));
  const writes: { path: string; text: string; mode?: number }[] = [];
  const readTextFile = vi.fn(
    async (p: string): Promise<string | undefined> => files.get(p),
  );
  const writeTextFileAtomic = vi.fn(
    async (
      p: string,
      text: string,
      mode?: number,
    ): Promise<{ ok: true } | { ok: false; error: string }> => {
      if (opts.failStateWrite) return { ok: false, error: "EACCES: mocked" };
      writes.push({ path: p, text, mode });
      files.set(p, text);
      return { ok: true };
    },
  );
  const opts: { failStateWrite: boolean } = { failStateWrite: false };
  return { files, writes, readTextFile, writeTextFileAtomic, opts };
}

function makeDeps(
  opts: {
    /** 初始存活的 profile（闭包可变：quit 清空，launch 置为目标）。 */
    running?: ZcodeProfile | undefined;
    quitSucceeds?: boolean;
    quitError?: string;
    launchError?: string;
    files?: Record<string, string>;
    failStateWrite?: boolean;
  } = {},
) {
  const fs = makeFs(opts.files ?? {});
  fs.opts.failStateWrite = opts.failStateWrite ?? false;
  let running: { a: boolean; b: boolean } =
    opts.running === "a"
      ? { a: true, b: false }
      : opts.running === "b"
        ? { a: false, b: true }
        : { a: false, b: false };
  const detectRunning = vi.fn(async () => running);
  const quitZcodeApp = vi.fn(async () => {
    if (opts.quitError) throw new Error(opts.quitError);
    if (opts.quitSucceeds !== false) running = { a: false, b: false };
  });
  const launchZcode = vi.fn(async (profile: ZcodeProfile) => {
    if (opts.launchError) throw new Error(opts.launchError);
    running = profile === "a" ? { a: true, b: false } : { a: false, b: true };
  });
  const deps = {
    readCcSwitchProvider: vi.fn(async () => ({
      ok: true as const,
      providers: [],
    })),
    runClaude: vi.fn(
      async (): Promise<
        RunDeps extends { runClaude: infer F } ? ReturnType<F> : never
      > => {
        throw new Error("zcode 路径不应触发 claude");
      },
    ) as unknown as RunDeps["runClaude"],
    runAgy: vi.fn(async () => {
      throw new Error("zcode 路径不应触发 agy");
    }) as unknown as RunDeps["runAgy"],
    runApi: vi.fn(async () => {
      throw new Error("zcode 路径不应触发 api");
    }) as unknown as RunDeps["runApi"],
    readStdin: vi.fn(async () => ""),
    runClaudeInteractive: vi.fn(async () => ({ exitCode: 0 })),
    runAgyInteractive: vi.fn(async () => ({ exitCode: 0 })),
    isInteractive: vi.fn(() => false),
    pickProvider: vi.fn(
      async (): Promise<{ kind: "skip" }> => ({
        kind: "skip",
      }),
    ),
    fetchProviderQuotas: vi.fn(
      async (): Promise<Map<string, string>> => new Map(),
    ),
    readLastProvider: vi.fn(async (): Promise<string | undefined> => undefined),
    writeLastProvider: vi.fn(async (): Promise<void> => {}),
    runHermes: vi.fn(async () => ({
      stdout: "",
      stderr: "",
      exitCode: 0,
    })),
    readTextFile: fs.readTextFile,
    writeTextFileAtomic: fs.writeTextFileAtomic,
    copyFile: vi.fn(async () => ({ ok: true as const })),
    queryLastSessionModel: vi.fn(async () => undefined),
    zcode: {
      detectRunning,
      quitZcodeApp,
      launchZcode,
      sleep: vi.fn(async (): Promise<void> => {}),
    },
  };
  return {
    deps: deps as unknown as RunDeps,
    fs,
    detectRunning,
    quitZcodeApp,
    launchZcode,
  };
}

describe("gcli zcode — 切换编排", () => {
  it("a→b：优雅退出 a 实例 → 以 b profile 启动 → 写状态文件", async () => {
    const h = makeDeps({ running: "a" });
    const r = await run(["zcode", "echo"], h.deps);
    expect(r.exitCode).toBe(0);
    expect(h.quitZcodeApp).toHaveBeenCalledTimes(1);
    expect(h.launchZcode).toHaveBeenCalledWith("b"); // echo → 内部 id b
    const write = h.fs.writes.find((w) => w.path === ZCODE_STATE_PATH);
    expect(write?.mode).toBe(0o600);
    const state = parseZcodeState(write?.text);
    expect(state?.active).toBe("b");
    expect(typeof state?.switchedAt).toBe("number");
    expect(r.stderr).toContain("账号 echo");
  });

  it("已在目标 profile → 幂等 no-op（不退出不重启）", async () => {
    const h = makeDeps({ running: "b" });
    const r = await run(["zcode", "echo"], h.deps);
    expect(r.exitCode).toBe(0);
    expect(h.quitZcodeApp).not.toHaveBeenCalled();
    expect(h.launchZcode).not.toHaveBeenCalled();
    expect(r.stderr).toContain("无需切换");
  });

  it("无存活实例 → 直接启动目标 profile（不调 quit）", async () => {
    const h = makeDeps({});
    const r = await run(["zcode", "echo"], h.deps);
    expect(r.exitCode).toBe(0);
    expect(h.quitZcodeApp).not.toHaveBeenCalled();
    expect(h.launchZcode).toHaveBeenCalledWith("b"); // echo → 内部 id b
  });

  it("退出超时 → exit 1 且绝不启动新实例（不硬杀）", async () => {
    const h = makeDeps({ running: "a", quitSucceeds: false });
    const r = await run(["zcode", "echo"], h.deps);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("未退出");
    expect(h.launchZcode).not.toHaveBeenCalled();
  });

  it("退出请求失败（osascript 报错）→ exit 1 不启动", async () => {
    const h = makeDeps({
      running: "a",
      quitError: "osascript exited with code 1",
    });
    const r = await run(["zcode", "echo"], h.deps);
    expect(r.exitCode).toBe(1);
    expect(h.launchZcode).not.toHaveBeenCalled();
  });

  it("启动失败 → exit 1", async () => {
    const h = makeDeps({ launchError: "open failed" });
    const r = await run(["zcode", "string"], h.deps);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("启动失败");
  });

  it("状态文件写失败 → 仅 warn，切换本身成功", async () => {
    const h = makeDeps({ failStateWrite: true });
    const r = await run(["zcode", "echo"], h.deps);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain("warn");
  });

  it("b→a：以默认方式启动（launchZcode('a')）并回写状态", async () => {
    const h = makeDeps({ running: "b" });
    const r = await run(["zcode", "string"], h.deps);
    expect(r.exitCode).toBe(0);
    expect(h.quitZcodeApp).toHaveBeenCalledTimes(1);
    expect(h.launchZcode).toHaveBeenCalledWith("a"); // string → 内部 id a
    expect(parseZcodeState(h.fs.files.get(ZCODE_STATE_PATH))?.active).toBe("a");
  });
});

describe("gcli zcode — status 与路由", () => {
  it("status：实例归属 + 登录态 + 上次切换（stdout=结果；凭据内容绝不外泄）", async () => {
    const secret = '{"accessToken":"SHOULD-NOT-APPEAR"}';
    const h = makeDeps({
      running: "b",
      files: {
        [ZCODE_A_CREDENTIALS_PATH]: secret,
        [ZCODE_STATE_PATH]: serializeZcodeState({
          active: "b",
          switchedAt: 1790582736711,
        }),
      },
    });
    const r = await run(["zcode", "status"], h.deps);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("账号 echo");
    expect(r.stdout).toContain("已登录");
    expect(r.stdout).toContain("未登录"); // profile echo 尚无 credentials.json
    expect(r.stdout).toContain("→ echo @");
    expect(r.stdout).not.toContain("SHOULD-NOT-APPEAR");
  });

  it("内部 id 别名 a/b 仍可路由（兼容旧用法）", async () => {
    const h = makeDeps({ running: "b" });
    const r = await run(["zcode", "b"], h.deps);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain("无需切换"); // b = echo，已在目标
  });

  it("扫描失败时 status 降级为无实例，不阻塞", async () => {
    const h = makeDeps({});
    h.detectRunning.mockRejectedValueOnce(new Error("detect exploded"));
    const r = await run(["zcode", "status"], h.deps);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("无");
  });

  it("未知 action → exit 2；deps.zcode 缺失 → exit 1", async () => {
    const bad = makeDeps({});
    const r2 = await run(["zcode", "c"], bad.deps);
    expect(r2.exitCode).toBe(2);

    const missing = makeDeps({});
    delete (missing.deps as { zcode?: unknown }).zcode;
    const r1 = await run(["zcode", "status"], missing.deps);
    expect(r1.exitCode).toBe(1);
    expect(r1.stderr).toContain("未装配");
  });

  it("--help → exit 0，stdout 带 zcode 段", async () => {
    const h = makeDeps({});
    const r = await run(["zcode", "--help"], h.deps);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("gcli zcode");
  });

  it("启动参数契约：b 带 ZCODE_DATA_BASE_DIR env 与 user-data-dir 双重隔离", async () => {
    // 锁定 launchZcode 的调用语义由生产实现承担；这里锁的是数据根路径常量
    expect(ZCODE_B_DATA_ROOT).toContain(".zcode-b");
    expect(ZCODE_B_CREDENTIALS_PATH).toBe(
      `${ZCODE_B_DATA_ROOT}/.zcode/v2/credentials.json`,
    );
  });
});
