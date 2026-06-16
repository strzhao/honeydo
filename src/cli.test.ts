import { describe, expect, it } from "vitest";
import {
  buildAgyArgs,
  CHARACTER_LIMIT,
  type ParseResult,
  parseCliArgs,
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
});
