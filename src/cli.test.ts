import { describe, expect, it } from "vitest";
import {
  buildAgyArgs,
  buildClaudeArgs,
  CHARACTER_LIMIT,
  type ParseResult,
  parseCliArgs,
  parseSubcommand,
  truncate,
} from "./cli.js";

function ok(r: ParseResult) {
  if ("error" in r) throw new Error(`unexpected parse error: ${r.error}`);
  return r;
}

describe("truncate", () => {
  it("returns short text unchanged", () => {
    const text = "Hello, world!";
    expect(truncate(text)).toBe(text);
  });

  it("returns text at exactly the limit unchanged", () => {
    const text = "a".repeat(CHARACTER_LIMIT);
    expect(truncate(text)).toBe(text);
  });

  it("truncates text exceeding the limit", () => {
    const text = "a".repeat(CHARACTER_LIMIT + 100);
    const result = truncate(text);
    expect(result.length).toBeLessThan(text.length);
    expect(result).toContain("[Truncated");
    expect(result.startsWith("a".repeat(CHARACTER_LIMIT))).toBe(true);
  });
});

describe("buildAgyArgs", () => {
  const base = { yolo: false, sandbox: false, timeoutMs: 300_000 };

  it("emits only -p for a minimal prompt", () => {
    expect(buildAgyArgs({ prompt: "hi", ...base })).toEqual(["-p", "hi"]);
  });

  it("translates every flag to agy equivalents", () => {
    const args = buildAgyArgs({
      prompt: "hi",
      model: "gemini-2.5-pro",
      yolo: true,
      sandbox: true,
      cwd: "/tmp/proj",
      timeoutMs: 60_000,
    });
    expect(args).toEqual([
      "--model",
      "gemini-2.5-pro",
      "--dangerously-skip-permissions",
      "--sandbox",
      "--add-dir",
      "/tmp/proj",
      "-p",
      "hi",
    ]);
  });

  it("passes stdin prompt marker through unchanged", () => {
    expect(buildAgyArgs({ prompt: "-", ...base })).toEqual(["-p", "-"]);
  });

  it("never emits a timeout flag (spawn kill owns it)", () => {
    const args = buildAgyArgs({ prompt: "hi", ...base, timeoutMs: 1000 });
    expect(args.some((a) => a.includes("timeout"))).toBe(false);
  });

  it("INT-10: omitted prompt → no -p (interactive mode), other flags kept", () => {
    const args = buildAgyArgs({
      yolo: true,
      sandbox: false,
      cwd: "/repo",
      timeoutMs: 60_000,
    });
    expect(args).not.toContain("-p");
    expect(args).toContain("--dangerously-skip-permissions");
    expect(args).toContain("--add-dir");
    expect(args).toContain("/repo");
  });

  it("passthrough: forwarded verbatim to argv end (no `--` added)", () => {
    const args = buildAgyArgs({
      prompt: "hi",
      yolo: false,
      sandbox: false,
      timeoutMs: 300_000,
      passthrough: ["--verbose", "--flag", "value"],
    });
    expect(args).toEqual(["-p", "hi", "--verbose", "--flag", "value"]);
  });

  it("passthrough: empty passthrough leaves argv unchanged", () => {
    const args = buildAgyArgs({
      prompt: "hi",
      yolo: false,
      sandbox: false,
      timeoutMs: 300_000,
    });
    expect(args).toEqual(["-p", "hi"]);
  });
});

describe("parseCliArgs", () => {
  it("parses a minimal prompt and applies default timeout", () => {
    const r = ok(parseCliArgs(["-p", "hi"]));
    expect(r.prompt).toBe("hi");
    expect(r.timeoutMs).toBe(300_000);
    expect(r.yolo).toBe(false);
  });

  it("parses custom timeout", () => {
    const r = ok(parseCliArgs(["-p", "hi", "--timeout", "5000"]));
    expect(r.timeoutMs).toBe(5000);
  });

  it("rejects timeout below the floor", () => {
    expect("error" in parseCliArgs(["-p", "hi", "--timeout", "10"])).toBe(true);
  });

  it("rejects timeout above the ceiling", () => {
    expect("error" in parseCliArgs(["-p", "hi", "--timeout", "9999999"])).toBe(
      true,
    );
  });

  it("allows a missing prompt (run() owns that error path)", () => {
    const r = parseCliArgs(["--yolo"]);
    expect("error" in r).toBe(false);
    if (!("error" in r)) expect(r.prompt).toBeUndefined();
  });

  it("captures yolo and cwd", () => {
    const r = ok(parseCliArgs(["-p", "hi", "--yolo", "--cwd", "/repo"]));
    expect(r.yolo).toBe(true);
    expect(r.cwd).toBe("/repo");
  });

  it("parses --provider for the claude backend", () => {
    const r = ok(parseCliArgs(["-p", "hi", "--provider", "Zhipu GLM"]));
    expect(r.provider).toBe("Zhipu GLM");
  });

  it("passthrough: args after `--` captured verbatim", () => {
    const r = ok(parseCliArgs(["-p", "hi", "--", "--verbose", "x"]));
    expect(r.prompt).toBe("hi");
    expect(r.passthrough).toEqual(["--verbose", "x"]);
  });

  it("passthrough: empty when `--` is last", () => {
    const r = ok(parseCliArgs(["-p", "hi", "--"]));
    expect(r.passthrough).toEqual([]);
  });

  it("passthrough: bare positional auto-forwarded", () => {
    const r = ok(parseCliArgs(["-p", "hi", "foo"]));
    expect(r.prompt).toBe("hi");
    expect(r.passthrough).toEqual(["foo"]);
  });

  it("passthrough: unknown flag auto-forwarded (no `--` needed)", () => {
    const r = ok(
      parseCliArgs(["--provider", "kimi", "--dangerously-skip-permissions"]),
    );
    expect(r.provider).toBe("kimi");
    expect(r.passthrough).toEqual(["--dangerously-skip-permissions"]);
  });

  it("passthrough: unknown flag with inline value preserved", () => {
    const r = ok(parseCliArgs(["-p", "hi", "--unknown-flag=value"]));
    expect(r.passthrough).toEqual(["--unknown-flag=value"]);
  });
});

describe("parseSubcommand", () => {
  it("routes 'agy' as the agy subcommand and strips it from rest", () => {
    const r = parseSubcommand(["agy", "-p", "hi"]);
    expect("error" in r).toBe(false);
    if (!("error" in r)) {
      expect(r.subcommand).toBe("agy");
      expect(r.rest).toEqual(["-p", "hi"]);
    }
  });

  it("routes 'claude' as the claude subcommand and strips it from rest", () => {
    const r = parseSubcommand(["claude", "-p", "hi"]);
    expect("error" in r).toBe(false);
    if (!("error" in r)) {
      expect(r.subcommand).toBe("claude");
      expect(r.rest).toEqual(["-p", "hi"]);
    }
  });

  it("returns subcommand=undefined for empty argv (defaults to agy)", () => {
    const r = parseSubcommand([]);
    expect("error" in r).toBe(false);
    if (!("error" in r)) {
      expect(r.subcommand).toBeUndefined();
      expect(r.rest).toEqual([]);
    }
  });

  it("returns subcommand=undefined when first token starts with '-' (default agy)", () => {
    const r = parseSubcommand(["-p", "hi"]);
    expect("error" in r).toBe(false);
    if (!("error" in r)) {
      expect(r.subcommand).toBeUndefined();
      expect(r.rest).toEqual(["-p", "hi"]);
    }
  });

  it("keeps 'claude' as a literal prompt when it appears after -p (C1 strict)", () => {
    // `gcli -p claude` → argv[0]='-p' → default agy, prompt='claude'
    const r = parseSubcommand(["-p", "claude"]);
    expect("error" in r).toBe(false);
    if (!("error" in r)) {
      expect(r.subcommand).toBeUndefined();
      expect(r.rest).toEqual(["-p", "claude"]);
    }
  });

  it("errors on an unknown non-flag token", () => {
    const r = parseSubcommand(["foo", "-p", "hi"]);
    expect("error" in r).toBe(true);
    if ("error" in r) {
      expect(r.error).toBe("unknown subcommand: foo");
    }
  });
});

describe("buildClaudeArgs", () => {
  it("emits -p prompt only for minimal invocation (no --settings)", () => {
    const args = buildClaudeArgs({ prompt: "hi" });
    expect(args).toEqual(["-p", "hi"]);
  });

  it("injects --settings JSON when settingsEnv is provided", () => {
    const args = buildClaudeArgs({
      prompt: "hi",
      settingsEnv: { ANTHROPIC_MODEL: "glm-5.2[1m]" },
    });
    expect(args[0]).toBe("-p");
    expect(args[1]).toBe("hi");
    expect(args[2]).toBe("--settings");
    const parsed = JSON.parse(args[3]);
    expect(parsed.env.ANTHROPIC_MODEL).toBe("glm-5.2[1m]");
  });

  it("translates --cwd to claude --add-dir", () => {
    const args = buildClaudeArgs({ prompt: "hi", cwd: "/tmp/proj" });
    expect(args).toContain("--add-dir");
    const idx = args.indexOf("--add-dir");
    expect(args[idx + 1]).toBe("/tmp/proj");
  });

  it("never emits timeout (spawn kill owns it)", () => {
    const args = buildClaudeArgs({ prompt: "hi" });
    expect(args.some((a) => a.includes("timeout"))).toBe(false);
  });
});
