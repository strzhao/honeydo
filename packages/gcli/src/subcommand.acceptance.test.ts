import { describe, expect, it } from "vitest";
import { parseSubcommand } from "./cli.js";

// 契约 C-D1（逐字，默认翻转后）：
//   parseSubcommand 形状稳定：undefined=默认哨兵；agy/claude/api 精确剥首参；
//   未知首参 → error 'unknown subcommand: <x>'。
//   - argv[0]==='agy'/'claude'/'api' → 剥首参，返回 { subcommand, rest }
//   - argv[0] 以 '-' 开头，或 argv 为空 → { subcommand: undefined }（默认哨兵；
//     run() 层将 undefined 分发到 **claude** 后端 —— C-D2 默认翻转）
//   - 其他非空 argv[0] → { error: 'unknown subcommand: <x>' }
//
// 注意：parseSubcommand 本身不含后端语义（undefined 只是哨兵），
// "默认=claude" 的断言在 run() 级（claude-runtime.acceptance.test.ts /
// provider-picker.acceptance.test.ts）。本文件只锁形状。
//
// 验收覆盖（覆盖版本，替换旧"默认=agy"注释；形状断言不变）：
//   ACC-1  无子命令 → undefined 哨兵（run() 层默认 claude）
//   ACC-2  `gcli agy` → agy
//   ACC-17 `gcli -p claude`（argv[0]='-p'）→ undefined 哨兵，prompt='claude' 保留在 rest
//   ACC-18 `gcli foo -p hi`（argv[0]='foo'）→ {error}，文案 'unknown subcommand: foo'
//   ACC-19 `gcli`（空 argv）→ undefined 哨兵

describe("parseSubcommand // C-D1 形状稳定（默认哨兵 undefined → claude）", () => {
  it("ACC-19: empty argv → subcommand undefined (默认哨兵; run() 分发 claude)", () => {
    const r = parseSubcommand([]);
    expect("error" in r).toBe(false);
    if ("error" in r) throw new Error("unexpected error");
    expect(r.subcommand).toBeUndefined();
    expect(r.rest).toEqual([]);
  });

  it("ACC-1: no subcommand, leading flag → undefined 哨兵, rest preserved", () => {
    const r = parseSubcommand(["-p", "hi"]);
    expect("error" in r).toBe(false);
    if ("error" in r) throw new Error("unexpected error");
    expect(r.subcommand).toBeUndefined();
    expect(r.rest).toEqual(["-p", "hi"]);
  });

  it("ACC-2: explicit 'agy' → strips first arg, subcommand='agy'", () => {
    const r = parseSubcommand(["agy", "-p", "hi"]);
    expect("error" in r).toBe(false);
    if ("error" in r) throw new Error("unexpected error");
    expect(r.subcommand).toBe("agy");
    expect(r.rest).toEqual(["-p", "hi"]);
  });

  it("ACC-2: explicit 'claude' → strips first arg, subcommand='claude'", () => {
    const r = parseSubcommand(["claude", "-p", "hi", "--provider", "k3"]);
    expect("error" in r).toBe(false);
    if ("error" in r) throw new Error("unexpected error");
    expect(r.subcommand).toBe("claude");
    expect(r.rest).toEqual(["-p", "hi", "--provider", "k3"]);
  });

  it("C-D1: explicit 'api' → strips first arg, subcommand='api'", () => {
    const r = parseSubcommand(["api", "-p", "hi", "--provider", "kimi"]);
    expect("error" in r).toBe(false);
    if ("error" in r) throw new Error("unexpected error");
    expect(r.subcommand).toBe("api");
    expect(r.rest).toEqual(["-p", "hi", "--provider", "kimi"]);
  });

  it("ACC-17: argv[0]='-p' (flag) → undefined 哨兵; literal 'claude' kept in rest as prompt", () => {
    // `gcli -p claude` —— argv[0] 是 '-p'（'-' 开头），走默认分支（run() 层 = claude）
    const r = parseSubcommand(["-p", "claude"]);
    expect("error" in r).toBe(false);
    if ("error" in r) throw new Error("unexpected error");
    expect(r.subcommand).toBeUndefined();
    expect(r.rest).toEqual(["-p", "claude"]);
  });

  it("ACC-18: argv[0]='foo' (unknown) → {error} with literal 'unknown subcommand: foo'", () => {
    const r = parseSubcommand(["foo", "-p", "hi"]);
    expect("error" in r).toBe(true);
    if (!("error" in r)) throw new Error("expected error");
    expect(r.error).toBe("unknown subcommand: foo");
  });

  it("ACC-18 variant: another unknown token carries its own name", () => {
    const r = parseSubcommand(["bogus-xyz"]);
    expect("error" in r).toBe(true);
    if (!("error" in r)) throw new Error("expected error");
    expect(r.error).toBe("unknown subcommand: bogus-xyz");
  });

  it("subcommand matching is exact + case-sensitive (no substring fallthrough at router)", () => {
    // 'agy'/'claude'/'api' 是精确匹配；'AGY' 不应被当作子命令剥掉
    const upper = parseSubcommand(["AGY", "-p", "hi"]);
    expect("error" in upper).toBe(true);
    if (!("error" in upper)) throw new Error("expected error");
    expect(upper.error).toBe("unknown subcommand: AGY");

    // 'claude-x' 不是 'claude'
    const dashed = parseSubcommand(["claude-x", "-p", "hi"]);
    expect("error" in dashed).toBe(true);
    if (!("error" in dashed)) throw new Error("expected error");
    expect(dashed.error).toBe("unknown subcommand: claude-x");
  });

  it("'--' as argv[0] → undefined 哨兵, rest preserved (for passthrough)", () => {
    // `gcli -- -p hi` → argv[0]='--' starts with '-' → 默认分支; rest keeps '--'
    const r = parseSubcommand(["--", "-p", "hi"]);
    expect("error" in r).toBe(false);
    if (!("error" in r)) {
      expect(r.subcommand).toBeUndefined();
      expect(r.rest).toEqual(["--", "-p", "hi"]);
    }
  });
});
