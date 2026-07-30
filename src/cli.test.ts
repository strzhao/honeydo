import { describe, expect, it } from "vitest";
import {
  API_DEFAULT_MAX_TOKENS,
  buildAgyArgs,
  buildApiBody,
  buildApiEndpoint,
  buildClaudeArgs,
  CHARACTER_LIMIT,
  extractNonStreamText,
  extractTextDelta,
  type ParseResult,
  parseApiArgs,
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

describe("parseSubcommand (api)", () => {
  it("routes 'api' as the api subcommand and strips it from rest", () => {
    const r = parseSubcommand(["api", "-p", "hi"]);
    expect("error" in r).toBe(false);
    if (!("error" in r)) {
      expect(r.subcommand).toBe("api");
      expect(r.rest).toEqual(["-p", "hi"]);
    }
  });

  it("keeps 'api' as a literal prompt when it appears after -p (strict)", () => {
    const r = parseSubcommand(["-p", "api"]);
    expect("error" in r).toBe(false);
    if (!("error" in r)) {
      expect(r.subcommand).toBeUndefined();
      expect(r.rest).toEqual(["-p", "api"]);
    }
  });
});

describe("parseApiArgs (strict, no passthrough)", () => {
  it("parses a minimal prompt + provider with defaults", () => {
    const r = parseApiArgs(["-p", "hi", "--provider", "kimi"]);
    expect("error" in r).toBe(false);
    if (!("error" in r)) {
      expect(r.prompt).toBe("hi");
      expect(r.provider).toBe("kimi");
      expect(r.maxTokens).toBe(API_DEFAULT_MAX_TOKENS);
      expect(r.stream).toBe(true);
      expect(r.timeoutMs).toBe(300_000);
    }
  });

  it("honours --max-tokens", () => {
    const r = parseApiArgs([
      "-p",
      "hi",
      "--provider",
      "kimi",
      "--max-tokens",
      "4000",
    ]);
    expect("error" in r).toBe(false);
    if (!("error" in r)) expect(r.maxTokens).toBe(4000);
  });

  it("rejects --max-tokens below 1", () => {
    expect(
      "error" in
        parseApiArgs(["-p", "hi", "--provider", "kimi", "--max-tokens", "0"]),
    ).toBe(true);
  });

  it("flips stream to false with --no-stream", () => {
    const r = parseApiArgs(["-p", "hi", "--provider", "kimi", "--no-stream"]);
    expect("error" in r).toBe(false);
    if (!("error" in r)) expect(r.stream).toBe(false);
  });

  it("rejects an unknown flag (strict, NOT forwarded)", () => {
    const r = parseApiArgs(["-p", "hi", "--provider", "kimi", "--bogus"]);
    expect("error" in r).toBe(true);
  });

  it("rejects --yolo (strict, NOT forwarded)", () => {
    const r = parseApiArgs(["-p", "hi", "--provider", "kimi", "--yolo"]);
    expect("error" in r).toBe(true);
  });

  it("rejects a bare positional (strict)", () => {
    const r = parseApiArgs(["-p", "hi", "--provider", "kimi", "foo"]);
    expect("error" in r).toBe(true);
  });

  it("captures --model override", () => {
    const r = parseApiArgs(["-p", "hi", "--provider", "kimi", "--model", "k3"]);
    expect("error" in r).toBe(false);
    if (!("error" in r)) expect(r.model).toBe("k3");
  });

  it("accepts --cwd (warned + ignored by backend, not a parse error)", () => {
    const r = parseApiArgs(["-p", "hi", "--provider", "kimi", "--cwd", "/tmp"]);
    expect("error" in r).toBe(false);
    if (!("error" in r)) expect(r.cwd).toBe("/tmp");
  });

  it("rejects timeout out of range", () => {
    expect(
      "error" in
        parseApiArgs(["-p", "hi", "--provider", "kimi", "--timeout", "10"]),
    ).toBe(true);
  });
});

describe("buildApiBody", () => {
  it("builds the messages request WITHOUT disabling thinking (k3 quality source)", () => {
    const body = buildApiBody({
      model: "k3",
      maxTokens: 8000,
      prompt: "hello",
      stream: true,
    });
    expect(body).toEqual({
      model: "k3",
      max_tokens: 8000,
      stream: true,
      messages: [{ role: "user", content: "hello" }],
    });
    // thinking must NOT be disabled — k3 thinking is the quality source we keep
    expect(body).not.toHaveProperty("thinking");
  });

  it("reflects stream=false when non-stream requested", () => {
    const body = buildApiBody({
      model: "k3",
      maxTokens: 16,
      prompt: "hi",
      stream: false,
    });
    expect(body.stream).toBe(false);
  });
});

describe("buildApiEndpoint", () => {
  it("appends v1/messages to a base with trailing slash", () => {
    expect(buildApiEndpoint("https://api.kimi.com/coding/")).toBe(
      "https://api.kimi.com/coding/v1/messages",
    );
  });

  it("inserts a slash when the base lacks one", () => {
    expect(buildApiEndpoint("https://api.kimi.com/coding")).toBe(
      "https://api.kimi.com/coding/v1/messages",
    );
  });
});

describe("extractTextDelta", () => {
  it("extracts text from a text_delta data line", () => {
    const line =
      'data:{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"HI"}}';
    expect(extractTextDelta(line)).toBe("HI");
  });

  it("extracts text when data has a space after the colon", () => {
    const line =
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" HI "}}';
    expect(extractTextDelta(line)).toBe(" HI ");
  });

  it("returns null for thinking_delta (ignored)", () => {
    const line =
      'data:{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hmm"}}';
    expect(extractTextDelta(line)).toBeNull();
  });

  it("returns null for non-data lines (event: prefix)", () => {
    expect(extractTextDelta("event:content_block_delta")).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(extractTextDelta("data:{not json")).toBeNull();
  });

  it("returns null for the [DONE] sentinel", () => {
    expect(extractTextDelta("data:[DONE]")).toBeNull();
  });

  it("returns null for empty data", () => {
    expect(extractTextDelta("data:")).toBeNull();
  });
});

describe("extractNonStreamText", () => {
  it("concatenates text blocks in order", () => {
    const body = {
      content: [
        { type: "text", text: "Hello" },
        { type: "text", text: " world" },
      ],
    };
    expect(extractNonStreamText(body)).toBe("Hello world");
  });

  it("ignores non-text blocks", () => {
    const body = {
      content: [
        { type: "thinking", thinking: "hmm" },
        { type: "text", text: "answer" },
      ],
    };
    expect(extractNonStreamText(body)).toBe("answer");
  });

  it("returns empty when content is missing or not an array", () => {
    expect(extractNonStreamText({})).toBe("");
    expect(extractNonStreamText({ content: "nope" })).toBe("");
    expect(extractNonStreamText(null)).toBe("");
  });
});
