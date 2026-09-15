import { afterEach, describe, expect, it, vi } from "vitest";
import {
  API_DEFAULT_MAX_TOKENS,
  type ApiRequest,
  applyPickerKey,
  buildAgyArgs,
  buildApiBody,
  buildApiEndpoint,
  buildClaudeArgs,
  buildCronRepinPlan,
  buildQuotaRequest,
  CHARACTER_LIMIT,
  deriveHermesId,
  deriveKeyEnv,
  describeNoTextBody,
  editHermesConfig,
  extractNonStreamText,
  extractSseLineMeta,
  extractTextDelta,
  formatQuota,
  HERMES_PROVIDER_SEEDS,
  type HermesConfigEdit,
  type HermesProviderRegistry,
  type HermesStateFile,
  type ParseHermesResult,
  type ParseResult,
  parseApiArgs,
  parseCliArgs,
  parseGlmQuota,
  parseHermesArgs,
  parseHermesConfig,
  parseHermesRegistry,
  parseHermesStateFile,
  parseKimiUsages,
  parseSubcommand,
  runApi,
  serializeHermesRegistry,
  serializeHermesStateFile,
  stripContextSuffix,
  truncate,
  upsertEnvLines,
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

// ===========================================================================
// hermes 子命令 — 纯函数层单测（TDD RED → GREEN）
// ===========================================================================

describe("stripContextSuffix", () => {
  it("strips a trailing [1M] context marker", () => {
    expect(stripContextSuffix("k3[1M]")).toBe("k3");
  });

  it("strips any trailing bracket suffix", () => {
    expect(stripContextSuffix("glm-5.3-flash[1M]")).toBe("glm-5.3-flash");
    expect(stripContextSuffix("x[128k]")).toBe("x");
  });

  it("leaves plain model names unchanged", () => {
    expect(stripContextSuffix("k3")).toBe("k3");
    expect(stripContextSuffix("glm-5.3-flash")).toBe("glm-5.3-flash");
  });

  it("only strips a suffix at the very end", () => {
    expect(stripContextSuffix("a[b]c")).toBe("a[b]c");
  });

  it("handles empty string", () => {
    expect(stripContextSuffix("")).toBe("");
  });
});

describe("parseHermesArgs", () => {
  function okHermes(r: ParseHermesResult) {
    if ("error" in r) throw new Error(`unexpected parse error: ${r.error}`);
    return r;
  }

  it("parses a bare provider positional with defaults", () => {
    const r = okHermes(parseHermesArgs(["kimi"]));
    expect(r.provider).toBe("kimi");
    expect(r.model).toBeUndefined();
    expect(r.dryRun).toBe(false);
    expect(r.verify).toBe(true);
    expect(r.keepOnFail).toBe(false);
    expect(r.help).toBe(false);
  });

  it("parses all flags", () => {
    const r = okHermes(
      parseHermesArgs([
        "kimi",
        "--model",
        "k3",
        "--dry-run",
        "--no-verify",
        "--keep-on-fail",
      ]),
    );
    expect(r.provider).toBe("kimi");
    expect(r.model).toBe("k3");
    expect(r.dryRun).toBe(true);
    expect(r.verify).toBe(false);
    expect(r.keepOnFail).toBe(true);
  });

  it("captures reserved words as provider positionals (backend dispatches)", () => {
    expect(okHermes(parseHermesArgs(["status"])).provider).toBe("status");
    expect(okHermes(parseHermesArgs(["rollback"])).provider).toBe("rollback");
  });

  it("empty argv → provider undefined", () => {
    const r = okHermes(parseHermesArgs([]));
    expect(r.provider).toBeUndefined();
  });

  it("--help sets help", () => {
    expect(okHermes(parseHermesArgs(["--help"])).help).toBe(true);
  });

  it("rejects a second positional (strict)", () => {
    const r = parseHermesArgs(["a", "b"]);
    expect("error" in r).toBe(true);
  });

  it("rejects unknown flags (strict, exit-2 class)", () => {
    const r = parseHermesArgs(["kimi", "--bogus"]);
    expect("error" in r).toBe(true);
  });

  it("rejects --model without a value", () => {
    const r = parseHermesArgs(["kimi", "--model"]);
    expect("error" in r).toBe(true);
  });
});

describe("deriveHermesId / deriveKeyEnv", () => {
  it("derives a slug id from a cc-switch display name", () => {
    expect(deriveHermesId("Kimi For Coding")).toBe("kimi-for-coding");
    // 推导结果是机械折叠；"glm flash lastest" 靠内置 seed 映射到 glm-flash
    expect(deriveHermesId("glm flash lastest")).toBe("glm-flash-lastest");
    expect(deriveHermesId("PackyCode-claude official")).toBe(
      "packycode-claude-official",
    );
  });

  it("folds non-alphanumeric runs and trims dashes", () => {
    expect(deriveHermesId("  --Weird__Name--  ")).toBe("weird-name");
  });

  it("derives the env key from the id", () => {
    expect(deriveKeyEnv("kimi-coding")).toBe("KIMI_CODING_API_KEY");
    expect(deriveKeyEnv("glm-flash")).toBe("GLM_FLASH_API_KEY");
  });
});

// 脱敏骨架 fixture：结构 1:1 复刻真实 ~/.hermes/config.yaml（顶层 model 段
// 恰 3 键、providers 为最后顶层段、条目 2 空格 id + 4 空格字段），值全部虚构。
const HERMES_CONFIG_FIXTURE = `model:
  default: k3
  provider: kimi-coding
  base_url: https://api.kimi.com/coding/
fallback_providers: []
agent:
  max_turns: 90
  personalities:
    helpful: You are a helpful, friendly AI assistant.
mcp_servers: {}
providers:
  glm-flash:
    name: GLM Flash
    base_url: https://open.bigmodel.cn/api/anthropic
    transport: anthropic_messages
    key_env: BIGMODEL_API_KEY
    default_model: glm-5.3-flash
  kimi-coding:
    name: Kimi Coding Plan
    base_url: https://api.kimi.com/coding/
    transport: anthropic_messages
    key_env: KIMI_CODING_API_KEY
    default_model: k3
`;

const EDIT_TO_GLM: HermesConfigEdit = {
  model: {
    default: "glm-5.3-flash",
    provider: "glm-flash",
    base_url: "https://open.bigmodel.cn/api/anthropic",
  },
  provider: {
    id: "glm-flash",
    name: "GLM Flash",
    base_url: "https://open.bigmodel.cn/api/anthropic",
    transport: "anthropic_messages",
    key_env: "BIGMODEL_API_KEY",
    default_model: "glm-5.3-flash",
  },
};

function editOk(r: { text: string } | { error: string }): string {
  if ("error" in r) throw new Error(`unexpected edit error: ${r.error}`);
  return r.text;
}

describe("editHermesConfig", () => {
  it("replaces the three model-section keys", () => {
    const out = editOk(editHermesConfig(HERMES_CONFIG_FIXTURE, EDIT_TO_GLM));
    expect(out).toContain("  default: glm-5.3-flash\n");
    expect(out).toContain("  provider: glm-flash\n");
    expect(out).toContain(
      "  base_url: https://open.bigmodel.cn/api/anthropic\n",
    );
    expect(out).not.toContain("  default: k3\n");
  });

  it("inserts a missing model key at the end of the model section", () => {
    const noBaseUrl = HERMES_CONFIG_FIXTURE.replace(
      "  base_url: https://api.kimi.com/coding/\n",
      "",
    );
    const out = editOk(editHermesConfig(noBaseUrl, EDIT_TO_GLM));
    const modelBlock = out.slice(
      out.indexOf("model:\n"),
      out.indexOf("fallback_providers:"),
    );
    expect(modelBlock).toContain(
      "  base_url: https://open.bigmodel.cn/api/anthropic\n",
    );
  });

  it("upserts fields of an existing providers entry", () => {
    const edit: HermesConfigEdit = {
      ...EDIT_TO_GLM,
      provider: { ...EDIT_TO_GLM.provider, default_model: "glm-5.4-flash" },
    };
    const out = editOk(editHermesConfig(HERMES_CONFIG_FIXTURE, edit));
    expect(out).toContain("    default_model: glm-5.4-flash\n");
    expect(out).not.toContain("    default_model: glm-5.3-flash\n");
  });

  it("appends a missing field to an existing entry block", () => {
    const noTransport = HERMES_CONFIG_FIXTURE.replace(
      "    transport: anthropic_messages\n    key_env: BIGMODEL_API_KEY\n",
      "    key_env: BIGMODEL_API_KEY\n",
    );
    const out = editOk(editHermesConfig(noTransport, EDIT_TO_GLM));
    const glmBlock = out.slice(
      out.indexOf("  glm-flash:\n"),
      out.indexOf("  kimi-coding:\n"),
    );
    expect(glmBlock).toContain("    transport: anthropic_messages\n");
  });

  it("appends a brand-new provider entry at the end of the providers section", () => {
    const edit: HermesConfigEdit = {
      model: {
        default: "deepseek-v4-flash",
        provider: "deepseek-flash",
        base_url: "https://api.deepseek.com/anthropic",
      },
      provider: {
        id: "deepseek-flash",
        name: "DeepSeek Flash",
        base_url: "https://api.deepseek.com/anthropic",
        transport: "anthropic_messages",
        key_env: "DEEPSEEK_API_KEY",
        default_model: "deepseek-v4-flash",
      },
    };
    const out = editOk(editHermesConfig(HERMES_CONFIG_FIXTURE, edit));
    expect(out).toContain("  deepseek-flash:\n");
    expect(out.indexOf("  deepseek-flash:\n")).toBeGreaterThan(
      out.indexOf("  kimi-coding:\n"),
    );
    const block = out.slice(out.indexOf("  deepseek-flash:\n"));
    // 含空格的标量按设计 quoting 规则走单引号
    expect(block).toContain("    name: 'DeepSeek Flash'\n");
    expect(block).toContain("    key_env: DEEPSEEK_API_KEY\n");
    expect(block).toContain("    default_model: deepseek-v4-flash\n");
  });

  it("quotes scalars with unsafe characters (single-quote + '' escape)", () => {
    const edit: HermesConfigEdit = {
      ...EDIT_TO_GLM,
      provider: { ...EDIT_TO_GLM.provider, name: "It's GLM, Flash" },
    };
    const out = editOk(editHermesConfig(HERMES_CONFIG_FIXTURE, edit));
    expect(out).toContain("    name: 'It''s GLM, Flash'\n");
  });

  it("keeps safe scalars bare", () => {
    const out = editOk(editHermesConfig(HERMES_CONFIG_FIXTURE, EDIT_TO_GLM));
    expect(out).toContain("    transport: anthropic_messages\n");
    expect(out).not.toContain("'anthropic_messages'");
  });

  it("returns {error} when the model: section is missing", () => {
    const noModel = HERMES_CONFIG_FIXTURE.replace(/^model:\n( {2}.*\n)+/m, "");
    const r = editHermesConfig(noModel, EDIT_TO_GLM);
    expect("error" in r).toBe(true);
  });

  it("returns {error} when the providers: section is missing", () => {
    const noProviders = HERMES_CONFIG_FIXTURE.slice(
      0,
      HERMES_CONFIG_FIXTURE.indexOf("providers:"),
    );
    const r = editHermesConfig(noProviders, EDIT_TO_GLM);
    expect("error" in r).toBe(true);
  });

  it("returns {error} on unexpected nesting inside the model section", () => {
    const nested = HERMES_CONFIG_FIXTURE.replace(
      "  provider: kimi-coding\n",
      "  provider: kimi-coding\n    deep: true\n",
    );
    const r = editHermesConfig(nested, EDIT_TO_GLM);
    expect("error" in r).toBe(true);
  });

  it("returns {error} on unexpected nesting inside a providers entry", () => {
    const nested = HERMES_CONFIG_FIXTURE.replace(
      "    key_env: BIGMODEL_API_KEY\n",
      "    key_env:\n      nested: true\n",
    );
    const r = editHermesConfig(nested, EDIT_TO_GLM);
    expect("error" in r).toBe(true);
  });

  it("is idempotent: edit(edit(x)) === edit(x)", () => {
    const once = editOk(editHermesConfig(HERMES_CONFIG_FIXTURE, EDIT_TO_GLM));
    const twice = editOk(editHermesConfig(once, EDIT_TO_GLM));
    expect(twice).toBe(once);
  });

  it("leaves unrelated sections byte-identical", () => {
    const out = editOk(editHermesConfig(HERMES_CONFIG_FIXTURE, EDIT_TO_GLM));
    const agentBlock = (t: string) =>
      t.slice(t.indexOf("agent:\n"), t.indexOf("mcp_servers:"));
    expect(agentBlock(out)).toBe(agentBlock(HERMES_CONFIG_FIXTURE));
  });

  it("applying the current config's own values reaches a fixed point (no further drift)", () => {
    const identity: HermesConfigEdit = {
      model: {
        default: "k3",
        provider: "kimi-coding",
        base_url: "https://api.kimi.com/coding/",
      },
      provider: {
        id: "kimi-coding",
        name: "Kimi Coding Plan",
        base_url: "https://api.kimi.com/coding/",
        transport: "anthropic_messages",
        key_env: "KIMI_CODING_API_KEY",
        default_model: "k3",
      },
    };
    // 第一次应用只会把含空格的 name 重 quoting（设计 quoting 规则）；
    // 其余逐字节不变
    const once = editOk(editHermesConfig(HERMES_CONFIG_FIXTURE, identity));
    expect(once).toContain("    name: 'Kimi Coding Plan'\n");
    expect(
      once.replace(
        "    name: 'Kimi Coding Plan'\n",
        "    name: Kimi Coding Plan\n",
      ),
    ).toBe(HERMES_CONFIG_FIXTURE);
    // 稳态后再切同 provider 零漂移（契约：不产生配置漂移）
    expect(editOk(editHermesConfig(once, identity))).toBe(once);
  });
});

describe("parseHermesConfig", () => {
  it("reads the model section and provider ids", () => {
    const r = parseHermesConfig(HERMES_CONFIG_FIXTURE);
    if ("error" in r) throw new Error(`unexpected: ${r.error}`);
    expect(r.info.model).toEqual({
      default: "k3",
      provider: "kimi-coding",
      base_url: "https://api.kimi.com/coding/",
    });
    expect(r.info.providerIds).toEqual(["glm-flash", "kimi-coding"]);
  });

  it("returns {error} when the model: section is missing", () => {
    const r = parseHermesConfig("agent:\n  max_turns: 90\n");
    expect("error" in r).toBe(true);
  });
});

describe("upsertEnvLines", () => {
  const ENV_FIXTURE =
    "# top comment\nFOO_API_KEY=old-value\n\nBAR_API_KEY=keep\n#FOO_API_KEY=commented-out\n";

  it("replaces an existing key, preserving comments and blank lines", () => {
    const out = upsertEnvLines(ENV_FIXTURE, "FOO_API_KEY", "new-value");
    expect(out).toContain("FOO_API_KEY=new-value\n");
    expect(out).not.toContain("FOO_API_KEY=old-value");
    expect(out).toContain("# top comment\n");
    expect(out).toContain("\n\nBAR_API_KEY=keep\n");
    // commented-out occurrences are NOT treated as the key
    expect(out).toContain("#FOO_API_KEY=commented-out\n");
  });

  it("appends a missing key at the end (before the trailing newline)", () => {
    const out = upsertEnvLines(ENV_FIXTURE, "NEW_KEY", "v1");
    expect(out.endsWith("NEW_KEY=v1\n")).toBe(true);
    expect(out).toContain("BAR_API_KEY=keep\n");
  });

  it("deletes the key line when value is null", () => {
    const out = upsertEnvLines(ENV_FIXTURE, "FOO_API_KEY", null);
    expect(out).not.toContain("FOO_API_KEY=old-value");
    expect(out).toContain("BAR_API_KEY=keep\n");
  });

  it("appends to an empty file", () => {
    expect(upsertEnvLines("", "K", "v")).toBe("K=v\n");
  });

  it("no-ops a delete when the key is absent", () => {
    expect(upsertEnvLines(ENV_FIXTURE, "MISSING_KEY", null)).toBe(ENV_FIXTURE);
  });
});

describe("buildCronRepinPlan", () => {
  const JOBS = {
    jobs: [
      {
        id: "a1",
        enabled: true,
        provider: "glm-flash",
        model: "glm-5.3-flash",
      },
      { id: "b2", enabled: true, provider: "glm-flash", model: null },
      {
        id: "c3",
        enabled: false,
        provider: "glm-flash",
        model: "glm-5.3-flash",
      },
      { id: "d4", enabled: true, provider: "kimi-coding", model: "k3" },
      { id: "e5", enabled: true, provider: null, model: null },
    ],
    updated_at: "2026-09-06T00:00:00Z",
  };

  it("hits only enabled jobs pinned to the old provider", () => {
    const plan = buildCronRepinPlan(JOBS, "glm-flash");
    expect(plan.map((p) => p.jobId)).toEqual(["a1", "b2"]);
    expect(plan[0]).toEqual({
      jobId: "a1",
      prevProvider: "glm-flash",
      prevModel: "glm-5.3-flash",
    });
    expect(plan[1].prevModel).toBeNull();
  });

  it("returns [] when nothing is pinned to the old provider", () => {
    expect(buildCronRepinPlan(JOBS, "nonexistent")).toEqual([]);
  });

  it("tolerates malformed jobs.json (never throws)", () => {
    expect(buildCronRepinPlan(undefined, "x")).toEqual([]);
    expect(buildCronRepinPlan(null, "x")).toEqual([]);
    expect(buildCronRepinPlan({ nope: 1 }, "x")).toEqual([]);
    expect(buildCronRepinPlan({ jobs: "not-array" }, "x")).toEqual([]);
    expect(
      buildCronRepinPlan({ jobs: [null, 42, { enabled: true }] }, "x"),
    ).toEqual([]);
  });
});

describe("hermes registry parse/serialize", () => {
  it("round-trips a valid registry", () => {
    const reg: HermesProviderRegistry = {
      "Kimi For Coding": { id: "kimi-coding", keyEnv: "KIMI_CODING_API_KEY" },
      "glm flash lastest": {
        id: "glm-flash",
        keyEnv: "BIGMODEL_API_KEY",
        modelOverride: "glm-5.3-flash",
      },
    };
    expect(parseHermesRegistry(serializeHermesRegistry(reg))).toEqual(reg);
  });

  it("corrupt/missing content parses as an empty registry (best-effort)", () => {
    expect(parseHermesRegistry("not json {")).toEqual({});
    expect(parseHermesRegistry("null")).toEqual({});
    expect(parseHermesRegistry("[1,2]")).toEqual({});
    expect(parseHermesRegistry("")).toEqual({});
  });

  it("drops entries missing id/keyEnv", () => {
    const reg = parseHermesRegistry(
      JSON.stringify({
        good: { id: "a", keyEnv: "A_API_KEY" },
        bad: { id: "b" },
        worse: 42,
      }),
    );
    expect(Object.keys(reg)).toEqual(["good"]);
  });
});

describe("hermes state file parse/serialize", () => {
  const STATE: HermesStateFile = {
    lastSwitch: {
      ts: 1788700000000,
      ccName: "Kimi For Coding",
      to: {
        id: "kimi-coding",
        model: "k3",
        base_url: "https://api.kimi.com/coding/",
      },
      from: {
        id: "glm-flash",
        model: "glm-5.3-flash",
        base_url: "https://open.bigmodel.cn/api/anthropic",
      },
      configBackup:
        "/home/u/.hermes/config.yaml.bak-before-kimi-coding-1788700000",
      env: { key: "KIMI_CODING_API_KEY", prevValue: null },
      cronRepinned: [
        {
          jobId: "d2676ff8582c",
          prevProvider: "glm-flash",
          prevModel: "glm-5.3-flash",
        },
      ],
    },
  };

  it("round-trips", () => {
    const r = parseHermesStateFile(serializeHermesStateFile(STATE));
    if ("error" in r) throw new Error(`unexpected: ${r.error}`);
    expect(r.state).toEqual(STATE);
  });

  it("malformed JSON → {error} (不猜)", () => {
    expect("error" in parseHermesStateFile("{nope")).toBe(true);
    expect("error" in parseHermesStateFile("null")).toBe(true);
    expect("error" in parseHermesStateFile("{}")).toBe(true);
    expect(
      "error" in
        parseHermesStateFile(JSON.stringify({ lastSwitch: { ts: "x" } })),
    ).toBe(true);
  });
});

describe("HERMES_PROVIDER_SEEDS", () => {
  it("contains the built-in seeds", () => {
    // "kimi" 是 cc-switch 真实条目名（09-06 实机冒烟实证）；
    // "Kimi For Coding" 保留作别名防御
    expect(HERMES_PROVIDER_SEEDS["kimi"]).toEqual({
      id: "kimi-coding",
      keyEnv: "KIMI_CODING_API_KEY",
    });
    expect(HERMES_PROVIDER_SEEDS["Kimi For Coding"]).toEqual({
      id: "kimi-coding",
      keyEnv: "KIMI_CODING_API_KEY",
    });
    expect(HERMES_PROVIDER_SEEDS["glm flash lastest"]).toEqual({
      id: "glm-flash",
      keyEnv: "BIGMODEL_API_KEY",
    });
  });
});

// ---------------------------------------------------------------------------
// api backend: --thinking / --retry (bug handoff gcli-api-flaky-handoff)
// ---------------------------------------------------------------------------

describe("parseApiArgs --thinking/--retry", () => {
  it("defaults to thinking=auto, retries=1", () => {
    const r = parseApiArgs(["-p", "hi", "--provider", "kimi"]);
    expect("error" in r).toBe(false);
    if (!("error" in r)) {
      expect(r.thinking).toBe("auto");
      expect(r.retries).toBe(1);
    }
  });

  it("accepts --thinking off and --thinking on", () => {
    for (const t of ["off", "on"] as const) {
      const r = parseApiArgs([
        "-p",
        "hi",
        "--provider",
        "kimi",
        "--max-tokens",
        "4000",
        "--thinking",
        t,
      ]);
      expect("error" in r).toBe(false);
      if (!("error" in r)) expect(r.thinking).toBe(t);
    }
  });

  it("rejects an unknown --thinking value", () => {
    const r = parseApiArgs([
      "-p",
      "hi",
      "--provider",
      "kimi",
      "--thinking",
      "maybe",
    ]);
    expect("error" in r).toBe(true);
    if ("error" in r) expect(r.error).toContain("auto|off|on");
  });

  it("rejects --thinking on below the 2048 max-tokens floor", () => {
    const r = parseApiArgs([
      "-p",
      "hi",
      "--provider",
      "kimi",
      "--max-tokens",
      "100",
      "--thinking",
      "on",
    ]);
    expect("error" in r).toBe(true);
    if ("error" in r) expect(r.error).toContain(">= 2048");
  });

  it("parses --retry 0 (disable) and --retry 5", () => {
    const r0 = parseApiArgs(["-p", "hi", "--provider", "kimi", "--retry", "0"]);
    expect("error" in r0).toBe(false);
    if (!("error" in r0)) expect(r0.retries).toBe(0);
    const r5 = parseApiArgs(["-p", "hi", "--provider", "kimi", "--retry", "5"]);
    expect("error" in r5).toBe(false);
    if (!("error" in r5)) expect(r5.retries).toBe(5);
  });

  it("rejects out-of-range / non-integer --retry", () => {
    expect(
      "error" in
        parseApiArgs(["-p", "hi", "--provider", "kimi", "--retry", "6"]),
    ).toBe(true);
    expect(
      "error" in
        parseApiArgs(["-p", "hi", "--provider", "kimi", "--retry", "1.5"]),
    ).toBe(true);
    expect(
      "error" in
        parseApiArgs(["-p", "hi", "--provider", "kimi", "--retry", "x"]),
    ).toBe(true);
  });
});

describe("buildApiBody --thinking wiring", () => {
  const base = {
    model: "glm-5.3-flash",
    maxTokens: 8000,
    prompt: "hi",
    stream: false,
  };

  it("sends thinking:disabled for off", () => {
    const body = buildApiBody({ ...base, thinking: "off" });
    expect(body.thinking).toEqual({ type: "disabled" });
  });

  it("sends thinking:enabled with budget = max_tokens/2 for on", () => {
    const body = buildApiBody({ ...base, maxTokens: 8000, thinking: "on" });
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 4000 });
  });

  it("omits the thinking field for auto/undefined (endpoint default, k3 quality)", () => {
    expect(buildApiBody({ ...base })).not.toHaveProperty("thinking");
    expect(buildApiBody({ ...base, thinking: undefined })).not.toHaveProperty(
      "thinking",
    );
  });
});

describe("extractSseLineMeta", () => {
  it("extracts text_delta + parsed", () => {
    const m = extractSseLineMeta(
      'data:{"type":"content_block_delta","delta":{"type":"text_delta","text":"HI"}}',
    );
    expect(m.text).toBe("HI");
    expect(m.thinkingChars).toBe(0);
    expect(m.parsed).toBe(true);
  });

  it("counts thinking_delta characters (budget-starvation diagnosis)", () => {
    const m = extractSseLineMeta(
      'data:{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"abcd"}}',
    );
    expect(m.text).toBeNull();
    expect(m.thinkingChars).toBe(4);
    expect(m.parsed).toBe(true);
  });

  it("captures message_delta stop_reason", () => {
    const m = extractSseLineMeta(
      'data:{"type":"message_delta","delta":{"stop_reason":"max_tokens"}}',
    );
    expect(m.stopReason).toBe("max_tokens");
    expect(m.parsed).toBe(true);
  });

  it("marks control events (ping/message_start) as parsed with no payload", () => {
    const m = extractSseLineMeta('data:{"type":"ping"}');
    expect(m.parsed).toBe(true);
    expect(m.text).toBeNull();
    expect(m.thinkingChars).toBe(0);
    expect(m.stopReason).toBeUndefined();
  });

  it("returns empty meta for non-data / malformed / [DONE] lines", () => {
    expect(extractSseLineMeta("event: content_block_delta").parsed).toBe(false);
    expect(extractSseLineMeta("data:{not json").parsed).toBe(false);
    expect(extractSseLineMeta("data:[DONE]").parsed).toBe(false);
    expect(extractSseLineMeta("data:").parsed).toBe(false);
  });
});

describe("describeNoTextBody", () => {
  it("identifies a thinking-only response starved by max_tokens", () => {
    const info = describeNoTextBody({
      content: [{ type: "thinking", thinking: "..." }],
      stop_reason: "max_tokens",
    });
    expect(info.blocks).toBe("thinking");
    expect(info.sawThinking).toBe(true);
    expect(info.stopReason).toBe("max_tokens");
  });

  it("identifies an empty content array (gateway hiccup, retriable)", () => {
    const info = describeNoTextBody({ content: [], stop_reason: "end_turn" });
    expect(info.blocks).toBe("");
    expect(info.sawThinking).toBe(false);
  });

  it("handles missing content / non-object bodies", () => {
    expect(describeNoTextBody({}).blocks).toBe("");
    expect(describeNoTextBody("oops").blocks).toBe("");
  });
});

// runApi: retry + diagnosis behaviour against a stubbed global fetch.
describe("runApi retries and diagnostics", () => {
  const req = (over: Partial<ApiRequest> = {}): ApiRequest => ({
    url: "https://relay.test/v1/messages",
    token: "tok",
    model: "glm-5.3-flash",
    maxTokens: 100,
    prompt: "hi",
    stream: false,
    timeoutMs: 60_000,
    retries: 1,
    ...over,
  });
  const jsonResponse = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  const textResponse = (text: string, status = 200): Response =>
    new Response(text, { status });
  const sseResponse = (events: string[]): Response => {
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const e of events)
          controller.enqueue(enc.encode(`data: ${e}\n\n`));
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("non-stream success on first attempt (no retry notes)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          content: [{ type: "text", text: "收到" }],
          stop_reason: "end_turn",
        }),
      ),
    );
    const out = await runApi(req());
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toBe("收到");
    expect(out.stderr).toBe("");
  });

  it("retries a network-level fetch failure then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(
        jsonResponse({
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const out = await runApi(req());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toBe("ok");
    expect(out.stderr).toContain(
      "attempt 1/2 failed (fetch failed: fetch failed)",
    );
  });

  it("gives up after the retry budget with notes preserved", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    vi.stubGlobal("fetch", fetchMock);
    const out = await runApi(req({ retries: 2 }));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain("attempt 1/3");
    expect(out.stderr).toContain("attempt 2/3");
    expect(out.stderr).toContain("gcli: api request failed: fetch failed");
  });

  it("retries HTTP 502 then succeeds; does NOT retry HTTP 401", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(textResponse("bad gateway", 502))
      .mockResolvedValueOnce(
        jsonResponse({
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const ok502 = await runApi(req());
    expect(ok502.exitCode).toBe(0);
    expect(ok502.stderr).toContain("attempt 1/2 failed (HTTP 502)");

    const authFail = vi.fn(async () => textResponse("denied", 401));
    vi.stubGlobal("fetch", authFail);
    const out401 = await runApi(req());
    expect(authFail).toHaveBeenCalledTimes(1);
    expect(out401.exitCode).toBe(1);
    expect(out401.stderr).toContain("HTTP 401");
  });

  it("non-stream thinking-only 200: diagnosed, NOT retried", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        content: [{ type: "thinking", thinking: "I should reply 收到..." }],
        stop_reason: "max_tokens",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const out = await runApi(req());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toBe("");
    expect(out.stderr).toContain("blocks=[thinking]");
    expect(out.stderr).toContain("stop_reason=max_tokens");
    expect(out.stderr).toContain("--thinking off");
  });

  it("non-stream empty content[]: retried as a transient gateway hiccup", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ content: [] }))
      .mockResolvedValueOnce(
        jsonResponse({
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const out = await runApi(req());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(out.exitCode).toBe(0);
  });

  it("stream thinking-only to stop_reason=max_tokens: diagnosed, NOT retried", async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse([
        '{"type":"message_start"}',
        '{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"ponder"}}',
        '{"type":"message_delta","delta":{"stop_reason":"max_tokens"}}',
        '{"type":"message_stop"}',
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);
    const out = await runApi(req({ stream: true }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain("thinking ~6ch");
    expect(out.stderr).toContain("stop_reason=max_tokens");
    expect(out.stderr).toContain("--thinking off");
  });

  it("stream with zero SSE events: retried, then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 200 }))
      .mockResolvedValueOnce(
        sseResponse([
          '{"type":"content_block_delta","delta":{"type":"text_delta","text":"收到"}}',
          '{"type":"message_delta","delta":{"stop_reason":"end_turn"}}',
        ]),
      );
    vi.stubGlobal("fetch", fetchMock);
    const out = await runApi(req({ stream: true }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toBe("收到");
    expect(out.stderr).toContain("attempt 1/2 failed (no SSE events)");
  });

  it("retry request body honours the thinking mode", async () => {
    let captured: Record<string, unknown> | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: { body?: string }) => {
        captured = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
        return jsonResponse({
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
        });
      }),
    );
    await runApi(req({ thinking: "off", maxTokens: 4000 }));
    expect(captured?.thinking).toEqual({ type: "disabled" });
  });
});
