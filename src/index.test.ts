import { describe, expect, it } from "vitest";
import { CHARACTER_LIMIT, truncate } from "./index.js";

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
