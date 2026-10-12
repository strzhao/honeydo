import { describe, expect, it } from "vitest";
import { parseManifest } from "../src/manifest.js";

describe("parseManifest", () => {
  it("parses three valid lines with 0-based indices", () => {
    const text = [
      JSON.stringify({ text: "a", out: "a.mp3", voice: "v1" }),
      JSON.stringify({ text: "b", out: "b.mp3", lang: "ja" }),
      JSON.stringify({ text: "c", out: "c.mp3", lang: "zh-CN", gender: "m" }),
    ].join("\n");
    const { items, itemErrors } = parseManifest(text);
    expect(itemErrors).toHaveLength(0);
    expect(items).toHaveLength(3);
    expect(items.map((i) => i.index)).toEqual([0, 1, 2]);
    expect(items[2]).toMatchObject({ lang: "zh-CN", gender: "m" });
  });

  it("skips blank and # comment lines but keeps physical 0-based line numbers", () => {
    const text = [
      "# header comment",
      JSON.stringify({ text: "a", out: "a.mp3", voice: "v" }),
      "",
      "   ",
      JSON.stringify({ text: "b", out: "b.mp3", voice: "v" }),
    ].join("\n");
    const { items } = parseManifest(text);
    expect(items.map((i) => i.index)).toEqual([1, 4]);
  });

  it("handles CRLF line endings", () => {
    const { items, itemErrors } = parseManifest(
      `{"text":"a","out":"a.mp3","voice":"v"}\r\n# c\r\n{"text":"b","out":"b.mp3","voice":"v"}\r\n`,
    );
    expect(itemErrors).toHaveLength(0);
    expect(items.map((i) => i.index)).toEqual([0, 2]);
  });

  it("invalid JSON line → failure entry with physical index and 80-char-prefixed error", () => {
    const bad = '{"text": "x", "out": "x.mp3"'; // truncated on purpose
    const text = [JSON.stringify({ text: "good", out: "g.mp3", voice: "v" }), bad].join("\n");
    const { items, itemErrors } = parseManifest(text);
    expect(items).toHaveLength(1);
    expect(itemErrors).toHaveLength(1);
    expect(itemErrors[0].index).toBe(1);
    expect(itemErrors[0].error).toMatch(/^invalid JSON: .{0,80}/);
    expect(itemErrors[0].error).toContain('{"text": "x"');
  });

  it("non-object JSON lines (array / string / number) are failures", () => {
    const { itemErrors } = parseManifest('["nope"]\n"str"\n42\n');
    expect(itemErrors.map((e) => e.index)).toEqual([0, 1, 2]);
    for (const e of itemErrors) expect(e.error).toContain("JSON object");
  });

  it("missing/empty text or out → failure entry (not a crash)", () => {
    const { itemErrors } = parseManifest(
      [
        JSON.stringify({ out: "a.mp3", voice: "v" }),
        JSON.stringify({ text: "", out: "a.mp3", voice: "v" }),
        JSON.stringify({ text: "t", voice: "v" }),
        JSON.stringify({ text: "t", out: "", voice: "v" }),
      ].join("\n"),
    );
    expect(itemErrors).toHaveLength(4);
  });

  it("line without voice and lang → failure entry (not whole-command exit 2)", () => {
    const { itemErrors } = parseManifest(JSON.stringify({ text: "t", out: "o.mp3" }));
    expect(itemErrors).toHaveLength(1);
    expect(itemErrors[0].error).toContain("voice");
  });

  it("invalid gender value → failure entry", () => {
    const { itemErrors } = parseManifest(
      JSON.stringify({ text: "t", out: "o.mp3", voice: "v", gender: "x" }),
    );
    expect(itemErrors).toHaveLength(1);
    expect(itemErrors[0].error).toContain("m|f");
  });

  it("empty string voice/lang treated as absent", () => {
    const { itemErrors } = parseManifest(
      JSON.stringify({ text: "t", out: "o.mp3", voice: "", lang: "" }),
    );
    expect(itemErrors).toHaveLength(1);
  });
});
