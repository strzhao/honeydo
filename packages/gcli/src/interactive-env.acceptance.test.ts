import { spawn as rawSpawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { spawnInteractive } from "./cli.js";

// ============================================================================
// 契约：交互式 TUI spawn 的环境卫生（ENV-1..4）
//
//   spawnInteractive(bin, args, cwd) 以继承环境启动后端（stdio inherit、
//   无超时、无捕获），但必须剥离 CLAUDE_CODE_CHILD_SESSION：
//
//   ENV-1  父环境带 CLAUDE_CODE_CHILD_SESSION=1 → 子进程环境无此变量。
//          （claude 把该标记当"派生子 worker"语义，静默关闭 transcript
//          落盘，会话从 `claude --resume` 消失；交互 TUI = 顶层会话，
//          不允许继承该标记。实测背景 2026-09-19：Ghostty 实例从带标记
//          的上下文启动后所有 tab 继承，gcli 拉起的会话 transcript 全丢。）
//   ENV-2  父环境不带该标记 → 子进程同样不带（禁止反向注入）。
//   ENV-3  其余继承环境原样透传（HOME/PATH 仍可见）。
//   ENV-4  子进程 exit code 原样透传（承接 INT-4 语义，回归保护）。
//
// 探针形态说明：spawnInteractive 是 inherit stdio（无捕获），所以探针走
// exit code 通道——/bin/sh -c 里按"标记是否可见"退出 7/0，断言退出码。
// SANITY 锚用 node 原生 spawn 复刻同探针并断言 7，证明探针本身有鉴别力
// （防 ENV-1 在探针坏掉时vacuously 假绿——剥离逻辑被回删时 ENV-1 必红）。
// ============================================================================

/** 标记可见 → exit 7；不可见 → exit 0。 */
const PROBE_MARKER =
  'if [ -n "$CLAUDE_CODE_CHILD_SESSION" ]; then exit 7; else exit 0; fi';

function withMarker(run: () => Promise<void>): Promise<void> {
  const prev = process.env.CLAUDE_CODE_CHILD_SESSION;
  process.env.CLAUDE_CODE_CHILD_SESSION = "1";
  return run().finally(() => {
    if (prev === undefined) {
      delete process.env.CLAUDE_CODE_CHILD_SESSION;
    } else {
      process.env.CLAUDE_CODE_CHILD_SESSION = prev;
    }
  });
}

describe("spawnInteractive env hygiene // ENV-1..4", () => {
  it("SANITY: 原生 spawn 继承带标记环境 → 探针 exit 7（鉴别力锚）", async () => {
    const code = await new Promise<number | null>((resolveFn) => {
      const child = rawSpawn("/bin/sh", ["-c", PROBE_MARKER], {
        env: { ...process.env, CLAUDE_CODE_CHILD_SESSION: "1" },
        stdio: "ignore",
      });
      child.on("close", (c) => resolveFn(c));
    });
    expect(code).toBe(7);
  });

  it("ENV-1: 父环境带标记 → spawnInteractive 子进程不可见（exit 0，非 7）", async () => {
    await withMarker(async () => {
      const r = await spawnInteractive("/bin/sh", ["-c", PROBE_MARKER]);
      expect(r.spawnError).toBeUndefined();
      expect(r.exitCode).toBe(0);
    });
  });

  it("ENV-2: 父环境无标记 → 子进程同样无标记（无注入副作用）", async () => {
    delete process.env.CLAUDE_CODE_CHILD_SESSION;
    const r = await spawnInteractive("/bin/sh", ["-c", PROBE_MARKER]);
    expect(r.spawnError).toBeUndefined();
    expect(r.exitCode).toBe(0);
  });

  it("ENV-3: 其余继承环境原样透传（HOME 可见）", async () => {
    const r = await spawnInteractive("/bin/sh", [
      "-c",
      'if [ -n "$HOME" ]; then exit 0; else exit 3; fi',
    ]);
    expect(r.exitCode).toBe(0);
  });

  it("ENV-4: 子进程 exit code 原样透传", async () => {
    const r = await spawnInteractive("/bin/sh", ["-c", "exit 5"]);
    expect(r.exitCode).toBe(5);
    expect(r.spawnError).toBeUndefined();
  });
});
