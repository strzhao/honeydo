import { describe, expect, it } from "vitest";
import {
  DEFAULT_SIZE,
  isModelNotOpenError,
  normalizeSize,
  parseCliArgs,
  resolveSizeForModel,
  type ParseResult,
} from "./cli.js";

function ok(r: ParseResult) {
  if ("error" in r) throw new Error(`unexpected parse error: ${r.error}`);
  return r;
}

describe("normalizeSize", () => {
  it("accepts preset sizes case-insensitively", () => {
    expect(normalizeSize("2K")).toBe("2K");
    expect(normalizeSize("3k")).toBe("3K");
  });

  it("accepts explicit pixel dimensions", () => {
    expect(normalizeSize("3072x2048")).toBe("3072x2048");
  });

  it("rejects invalid sizes", () => {
    expect(() => normalizeSize("huge")).toThrow();
    expect(() => normalizeSize("1x2")).toThrow(); // digits too short
  });
});

describe("isModelNotOpenError", () => {
  it("returns true only for 404 + ModelNotOpen marker", () => {
    expect(isModelNotOpenError(404, '{"error":{"code":"ModelNotOpen"}}')).toBe(true);
  });

  it("returns false for other 404s", () => {
    expect(isModelNotOpenError(404, "not found")).toBe(false);
  });

  it("returns false for non-404 statuses even with the marker", () => {
    expect(isModelNotOpenError(500, "ModelNotOpen")).toBe(false);
  });
});

describe("resolveSizeForModel", () => {
  it("maps 3K to explicit pixels for older (non-5.0) models", () => {
    expect(resolveSizeForModel("3K", "doubao-seedream-4-5-251128")).toBe(
      "3072x3072",
    );
  });

  it("keeps 3K shorthand for 5.0 models", () => {
    expect(resolveSizeForModel("3K", "doubao-seedream-5-0-260128")).toBe("3K");
  });

  it("leaves non-3K sizes untouched regardless of model", () => {
    expect(resolveSizeForModel("2K", "doubao-seedream-4-5-251128")).toBe("2K");
    expect(resolveSizeForModel(DEFAULT_SIZE, "anything")).toBe(DEFAULT_SIZE);
  });
});

describe("parseCliArgs", () => {
  it("takes the prompt as the first positional", () => {
    const r = ok(parseCliArgs(["a red apple"]));
    expect(r.prompt).toBe("a red apple");
  });

  it("parses --size and --output", () => {
    const r = ok(parseCliArgs(["apple", "--size", "3K", "--output", "/tmp/x.png"]));
    expect(r.size).toBe("3K");
    expect(r.output).toBe("/tmp/x.png");
  });

  it("treats a missing prompt as undefined (main owns that error)", () => {
    const r = parseCliArgs(["--size", "2K"]);
    expect("error" in r).toBe(false);
    if (!("error" in r)) expect(r.prompt).toBeUndefined();
  });
});
