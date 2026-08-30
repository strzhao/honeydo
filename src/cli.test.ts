import { describe, expect, it } from "vitest";
import {
  API_DEFAULT_MAX_TOKENS,
  applyPickerKey,
  buildAgyArgs,
  buildApiBody,
  buildApiEndpoint,
  buildClaudeArgs,
  buildQuotaRequest,
  CHARACTER_LIMIT,
  extractNonStreamText,
  extractTextDelta,
  formatQuota,
  type ParseResult,
  parseApiArgs,
  parseCliArgs,
  parseGlmQuota,
  parseKimiUsages,
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

describe("quota helpers // C-Q1..C-Q3", () => {
  it("buildQuotaRequest: kimi Bearer / glm bare / other → null", () => {
    expect(
      buildQuotaRequest({
        ANTHROPIC_BASE_URL: "https://api.kimi.com/coding/",
        ANTHROPIC_AUTH_TOKEN: "k",
      }),
    ).toEqual({
      kind: "kimi",
      url: "https://api.kimi.com/coding/v1/usages",
      authHeader: "Bearer k",
    });
    expect(
      buildQuotaRequest({
        ANTHROPIC_BASE_URL: "https://open.bigmodel.cn/api/anthropic",
        ANTHROPIC_AUTH_TOKEN: "g",
      }),
    ).toEqual({
      kind: "glm",
      url: "https://open.bigmodel.cn/api/monitor/usage/quota/limit",
      authHeader: "g",
    });
    expect(
      buildQuotaRequest({
        ANTHROPIC_BASE_URL: "https://api.deepseek.com",
        ANTHROPIC_AUTH_TOKEN: "d",
      }),
    ).toBeNull();
  });

  it("parseKimiUsages: string numbers, used-missing fallback, no throw", () => {
    const q = parseKimiUsages({
      usage: {
        used: "170000",
        limit: "1000000",
        resetTime: "2026-09-01T00:00:00Z",
      },
      limits: [
        {
          window: { duration: 300, timeUnit: "MINUTE" },
          detail: {
            limit: "100",
            remaining: "58",
            resetTime: "2026-08-30T14:13:00Z",
          },
        },
      ],
    });
    expect(q.short?.pct).toBe(42);
    expect(q.weekly?.pct).toBe(17);
    expect(() => parseKimiUsages("x")).not.toThrow();
    expect(parseKimiUsages("x")).toEqual({});
  });

  it("parseGlmQuota: sorts by nextResetTime, first=short last=weekly", () => {
    const q = parseGlmQuota({
      data: {
        limits: [
          { type: "TOKENS_LIMIT", percentage: 17, nextResetTime: "2026-09-01" },
          {
            type: "TOKENS_LIMIT",
            percentage: 42,
            nextResetTime: "2026-08-30T14:00:00Z",
          },
        ],
      },
    });
    expect(q.short?.pct).toBe(42);
    expect(q.weekly?.pct).toBe(17);
  });

  it("formatQuota: dual/short-only/relative units/expired", () => {
    const NOW = Date.parse("2026-08-30T12:00:00Z");
    const at = (m: number) => new Date(NOW + m * 60_000).toISOString();
    expect(
      formatQuota(
        {
          short: { pct: 42, resetIso: at(133) },
          weekly: { pct: 17, resetIso: at(3000) },
        },
        NOW,
      ),
    ).toBe("5h:42% wk:17% ↻2h13m");
    expect(formatQuota({ short: { pct: 7, resetIso: at(240) } }, NOW)).toBe(
      "5h:7% ↻4h",
    );
    expect(formatQuota({ short: { pct: 1, resetIso: at(-5) } }, NOW)).toBe(
      "5h:1%",
    );
    expect(formatQuota({}, NOW)).toBe("");
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

describe("applyPickerKey", () => {
  it("arrow-up moves up with wrap (index 0 → count-1)", () => {
    expect(applyPickerKey({ name: "up" }, 0, 5)).toEqual({
      type: "move",
      index: 4,
    });
  });

  it("'k' moves up like arrow-up", () => {
    expect(applyPickerKey({ name: "k" }, 2, 5)).toEqual({
      type: "move",
      index: 1,
    });
    expect(applyPickerKey({ name: "k" }, 0, 5)).toEqual({
      type: "move",
      index: 4,
    });
  });

  it("arrow-down moves down", () => {
    expect(applyPickerKey({ name: "down" }, 1, 5)).toEqual({
      type: "move",
      index: 2,
    });
  });

  it("'j' moves down like arrow-down", () => {
    expect(applyPickerKey({ name: "j" }, 3, 5)).toEqual({
      type: "move",
      index: 4,
    });
  });

  it("down at the last index wraps to 0 (环形 wrap)", () => {
    expect(applyPickerKey({ name: "down" }, 4, 5)).toEqual({
      type: "move",
      index: 0,
    });
    expect(applyPickerKey({ name: "j" }, 4, 5)).toEqual({
      type: "move",
      index: 0,
    });
  });

  it("return confirms the current row", () => {
    expect(applyPickerKey({ name: "return" }, 2, 5)).toEqual({
      type: "confirm",
    });
    expect(applyPickerKey({ name: "return" }, 0, 1)).toEqual({
      type: "confirm",
    });
    // "enter" is the LF byte — ttys may substitute it for CR in input
    // buffered before raw mode; treat it as Enter too (defensive superset).
    expect(applyPickerKey({ name: "enter" }, 2, 5)).toEqual({
      type: "confirm",
    });
  });

  it("escape skips (不切换)", () => {
    expect(applyPickerKey({ name: "escape" }, 2, 5)).toEqual({ type: "skip" });
    expect(applyPickerKey({ name: "escape" }, 0, 1)).toEqual({ type: "skip" });
  });

  it("Emacs C-n moves down (含 wrap) [revise-2]", () => {
    expect(applyPickerKey({ name: "n", ctrl: true }, 0, 5)).toEqual({
      type: "move",
      index: 1,
    });
    expect(applyPickerKey({ name: "n", ctrl: true }, 4, 5)).toEqual({
      type: "move",
      index: 0,
    });
  });

  it("Emacs C-p moves up (含 wrap) [revise-2]", () => {
    expect(applyPickerKey({ name: "p", ctrl: true }, 2, 5)).toEqual({
      type: "move",
      index: 1,
    });
    expect(applyPickerKey({ name: "p", ctrl: true }, 0, 5)).toEqual({
      type: "move",
      index: 4,
    });
  });

  it("Emacs C-g skips (≡ escape) [revise-2]", () => {
    expect(applyPickerKey({ name: "g", ctrl: true }, 2, 5)).toEqual({
      type: "skip",
    });
  });

  it("Emacs M-< / M-> jump to first/last (absolute, no wrap) [revise-2]", () => {
    expect(applyPickerKey({ name: "<", meta: true }, 4, 5)).toEqual({
      type: "move",
      index: 0,
    });
    expect(applyPickerKey({ name: ">", meta: true }, 0, 5)).toEqual({
      type: "move",
      index: 4,
    });
    expect(applyPickerKey({ name: ">", meta: true }, 0, 1)).toEqual({
      type: "move",
      index: 0,
    });
  });

  it("horizontal/paging Emacs keys and bare n/p are noop [revise-2]", () => {
    for (const name of ["f", "b", "a", "e", "v"]) {
      expect(applyPickerKey({ name, ctrl: true }, 2, 5)).toEqual({
        type: "noop",
      });
    }
    expect(applyPickerKey({ name: "v", meta: true }, 2, 5)).toEqual({
      type: "noop",
    });
    expect(applyPickerKey({ name: "n" }, 2, 5)).toEqual({ type: "noop" });
    expect(applyPickerKey({ name: "p" }, 2, 5)).toEqual({ type: "noop" });
  });

  it("any other key is a noop (incl. ctrl-c name 'c' — handled by the caller)", () => {
    expect(applyPickerKey({ name: "a" }, 2, 5)).toEqual({ type: "noop" });
    expect(applyPickerKey({ name: "space" }, 2, 5)).toEqual({ type: "noop" });
    expect(applyPickerKey({ name: "c" }, 2, 5)).toEqual({ type: "noop" });
    expect(applyPickerKey({ name: "tab" }, 2, 5)).toEqual({ type: "noop" });
    expect(applyPickerKey({ name: "backspace" }, 2, 5)).toEqual({
      type: "noop",
    });
  });

  it("nameless key object → noop", () => {
    expect(applyPickerKey({}, 2, 5)).toEqual({ type: "noop" });
  });

  it("count=1 (only the 不切换 row): moves stay at 0", () => {
    expect(applyPickerKey({ name: "up" }, 0, 1)).toEqual({
      type: "move",
      index: 0,
    });
    expect(applyPickerKey({ name: "down" }, 0, 1)).toEqual({
      type: "move",
      index: 0,
    });
    expect(applyPickerKey({ name: "k" }, 0, 1)).toEqual({
      type: "move",
      index: 0,
    });
    expect(applyPickerKey({ name: "j" }, 0, 1)).toEqual({
      type: "move",
      index: 0,
    });
  });

  it("count=0: moves are noop (defensive — nothing to render)", () => {
    expect(applyPickerKey({ name: "up" }, 0, 0)).toEqual({ type: "noop" });
    expect(applyPickerKey({ name: "down" }, 0, 0)).toEqual({ type: "noop" });
    expect(applyPickerKey({ name: "j" }, 3, 0)).toEqual({ type: "noop" });
    expect(applyPickerKey({ name: "k" }, 3, 0)).toEqual({ type: "noop" });
    expect(applyPickerKey({ name: "n", ctrl: true }, 0, 0)).toEqual({
      type: "noop",
    });
    expect(applyPickerKey({ name: ">", meta: true }, 0, 0)).toEqual({
      type: "noop",
    });
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
