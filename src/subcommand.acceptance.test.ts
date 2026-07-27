import { describe, expect, it } from "vitest";
import { parseSubcommand } from "./cli.js";

// 契约 C1（逐字）：
//   - argv[0]==='agy'/'claude' → 剥首参，返回 { subcommand, rest }
//   - argv[0] 以 '-' 开头，或 argv 为空 → { subcommand: undefined } 默认 agy
//   - 其他非空 argv[0] → { error: 'unknown subcommand: <x>' }
//
// 验收覆盖：
//   ACC-1  无子命令默认 agy
//   ACC-2  `gcli agy` → agy
//   ACC-17 `gcli -p claude`（argv[0]='-p'）→ 默认 agy，prompt='claude' 保留在 rest
//   ACC-18 `gcli foo -p hi`（argv[0]='foo'）→ {error}，文案 'unknown subcommand: foo'
//   ACC-19 `gcli`（空 argv）→ 默认 agy（subcommand=undefined）

describe("parseSubcommand // ACC-1/2/17/18/19", () => {
  it("ACC-19: empty argv → subcommand undefined (default agy)", () => {
    const r = parseSubcommand([]);
    expect("error" in r).toBe(false);
    if ("error" in r) throw new Error("unexpected error");
    expect(r.subcommand).toBeUndefined();
    expect(r.rest).toEqual([]);
  });

  it("ACC-1: no subcommand, leading flag → default agy, rest preserved", () => {
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

  it("ACC-17: argv[0]='-p' (flag) → default agy; literal 'claude' kept in rest as prompt", () => {
    // `gcli -p claude` —— argv[0] 是 '-p'（'-' 开头），走默认 agy 分支
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
    // 'agy'/'claude' 是精确匹配；'AGY' 不应被当作子命令剥掉
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

  it("'--' as argv[0] → default agy, rest preserved (for passthrough)", () => {
    // `gcli -- -p hi` → argv[0]='--' starts with '-' → default agy; rest keeps '--'
    const r = parseSubcommand(["--", "-p", "hi"]);
    expect("error" in r).toBe(false);
    if (!("error" in r)) {
      expect(r.subcommand).toBeUndefined();
      expect(r.rest).toEqual(["--", "-p", "hi"]);
    }
  });
});
