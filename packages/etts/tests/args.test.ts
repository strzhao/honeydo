import { describe, expect, it } from "vitest";
import {
  parseBatchArgs,
  parseGenArgs,
  parseVoicesArgs,
  type BatchParse,
  type GenParse,
  type VoicesParse,
} from "../src/args.js";

function genOk(r: GenParse): Exclude<GenParse, { error: string }> {
  if ("error" in r) throw new Error(`unexpected gen parse error: ${r.error}`);
  return r;
}
function batchOk(r: BatchParse): Exclude<BatchParse, { error: string }> {
  if ("error" in r) throw new Error(`unexpected batch parse error: ${r.error}`);
  return r;
}
function voicesOk(r: VoicesParse): Exclude<VoicesParse, { error: string }> {
  if ("error" in r) throw new Error(`unexpected voices parse error: ${r.error}`);
  return r;
}

describe("parseGenArgs", () => {
  it("parses text positional + --voice + --out, retry defaults to 3", () => {
    const r = genOk(parseGenArgs(["你好", "--voice", "ja-JP-NanamiNeural", "--out", "a.mp3"]));
    expect(r.text).toBe("你好");
    expect(r.voice).toBe("ja-JP-NanamiNeural");
    expect(r.out).toBe("a.mp3");
    expect(r.retry).toBe(3);
    expect(r.via).toBeUndefined();
  });

  it("resolves --lang via the default table and reports via", () => {
    const r = genOk(parseGenArgs(["hi", "--lang", "ja", "--out", "a.mp3"]));
    expect(r.voice).toBe("ja-JP-NanamiNeural");
    expect(r.via).toEqual({ lang: "ja-JP", gender: "f" });
  });

  it("honours --gender m", () => {
    const r = genOk(parseGenArgs(["hi", "--lang", "zh-HK", "--gender", "m", "--out", "a.mp3"]));
    expect(r.voice).toBe("zh-HK-WanLungNeural");
    expect(r.via?.gender).toBe("m");
  });

  it("accepts --retry <n>", () => {
    expect(genOk(parseGenArgs(["hi", "--voice", "v", "--out", "o", "--retry", "5"])).retry).toBe(5);
  });

  it("rejects --retry 0 / non-integer", () => {
    expect("error" in parseGenArgs(["hi", "--voice", "v", "--out", "o", "--retry", "0"])).toBe(true);
    expect("error" in parseGenArgs(["hi", "--voice", "v", "--out", "o", "--retry", "abc"])).toBe(true);
    expect("error" in parseGenArgs(["hi", "--voice", "v", "--out", "o", "--retry", "1.5"])).toBe(true);
  });

  it("rejects --gender outside m|f", () => {
    expect("error" in parseGenArgs(["hi", "--voice", "v", "--out", "o", "--gender", "x"])).toBe(true);
  });

  it("requires <text> and --out together", () => {
    expect("error" in parseGenArgs(["--voice", "v", "--out", "o"])).toBe(true); // no text
    expect("error" in parseGenArgs(["hi", "--voice", "v"])).toBe(true); // no --out
  });

  it("requires a voice: none of --voice/--lang → error (exit 2)", () => {
    expect("error" in parseGenArgs(["hi", "--out", "o"])).toBe(true);
  });

  it("out-of-table lang is a parse error (exit 2 in gen)", () => {
    expect("error" in parseGenArgs(["hi", "--lang", "zz-ZZ", "--out", "o"])).toBe(true);
    expect("error" in parseGenArgs(["hi", "--lang", "zh", "--out", "o"])).toBe(true); // ambiguous
  });

  it("rejects unknown flags and extra positionals", () => {
    expect("error" in parseGenArgs(["hi", "--bogus", "1", "--out", "o"])).toBe(true);
    expect("error" in parseGenArgs(["hi", "extra", "--voice", "v", "--out", "o"])).toBe(true);
  });
});

describe("parseBatchArgs", () => {
  it("parses manifest positional with defaults", () => {
    const r = batchOk(parseBatchArgs(["m.jsonl"]));
    expect(r.manifest).toBe("m.jsonl");
    expect(r.skipExisting).toBe(false);
    expect(r.retry).toBe(3);
    expect(r.failures).toBeUndefined();
  });

  it("parses --failures / --skip-existing / --retry / --proxy", () => {
    const r = batchOk(
      parseBatchArgs(["m.jsonl", "--failures", "f.jsonl", "--skip-existing", "--retry", "2", "--proxy", "http://127.0.0.1:9"]),
    );
    expect(r.failures).toBe("f.jsonl");
    expect(r.skipExisting).toBe(true);
    expect(r.retry).toBe(2);
    expect(r.proxy).toBe("http://127.0.0.1:9");
  });

  it("requires the manifest positional", () => {
    expect("error" in parseBatchArgs(["--skip-existing"])).toBe(true);
  });

  it("rejects --retry 0 and unknown flags", () => {
    expect("error" in parseBatchArgs(["m.jsonl", "--retry", "0"])).toBe(true);
    expect("error" in parseBatchArgs(["m.jsonl", "--nope"])).toBe(true);
    expect("error" in parseBatchArgs(["m.jsonl", "extra"])).toBe(true);
  });
});

describe("parseVoicesArgs", () => {
  it("defaults to no lang filter and table output", () => {
    const r = voicesOk(parseVoicesArgs([]));
    expect(r.lang).toBeUndefined();
    expect(r.json).toBe(false);
  });

  it("parses --lang and --json", () => {
    const r = voicesOk(parseVoicesArgs(["--lang", "zh-CN", "--json"]));
    expect(r.lang).toBe("zh-CN");
    expect(r.json).toBe(true);
  });

  it("rejects positionals", () => {
    expect("error" in parseVoicesArgs(["stray"])).toBe(true);
  });
});
