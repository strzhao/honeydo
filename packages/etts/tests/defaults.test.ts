import { describe, expect, it } from "vitest";
import { DEFAULT_VOICES, resolveVoice, type VoiceResolution } from "../src/defaults.js";

function ok(r: VoiceResolution): { voice: string; via?: { lang: string; gender: "m" | "f" } } {
  if ("error" in r) throw new Error(`unexpected resolve error: ${r.error}`);
  return r;
}

describe("DEFAULT_VOICES", () => {
  it("has exactly 15 locales with f/m voices, all Neural short names", () => {
    const locales = Object.keys(DEFAULT_VOICES);
    expect(locales).toHaveLength(15);
    for (const loc of locales) {
      expect(DEFAULT_VOICES[loc].f).toMatch(new RegExp(`^${loc}-\\w+Neural$`));
      expect(DEFAULT_VOICES[loc].m).toMatch(new RegExp(`^${loc}-\\w+Neural$`));
    }
  });

  it("pins the contract table (spot check)", () => {
    expect(DEFAULT_VOICES["ja-JP"].f).toBe("ja-JP-NanamiNeural");
    expect(DEFAULT_VOICES["ja-JP"].m).toBe("ja-JP-KeitaNeural");
    expect(DEFAULT_VOICES["zh-HK"].f).toBe("zh-HK-HiuMaanNeural");
    expect(DEFAULT_VOICES["zh-CN"].m).toBe("zh-CN-YunyangNeural");
    expect(DEFAULT_VOICES["en-US"].f).toBe("en-US-AvaMultilingualNeural");
  });
});

describe("resolveVoice", () => {
  it("explicit --voice wins over --lang", () => {
    const r = ok(resolveVoice("ko-KR-GosungNeural", "ja-JP", "f"));
    expect(r.voice).toBe("ko-KR-GosungNeural");
    expect(r.via).toBeUndefined();
  });

  it("exact locale hit: ja-JP female by default", () => {
    const r = ok(resolveVoice(undefined, "ja-JP"));
    expect(r.voice).toBe("ja-JP-NanamiNeural");
    expect(r.via).toEqual({ lang: "ja-JP", gender: "f" });
  });

  it("gender m picks the male column", () => {
    expect(ok(resolveVoice(undefined, "ja-JP", "m")).voice).toBe("ja-JP-KeitaNeural");
    expect(ok(resolveVoice(undefined, "zh-CN", "m")).voice).toBe("zh-CN-YunyangNeural");
  });

  it("primary subtag matches when unique: ja → ja-JP", () => {
    const r = ok(resolveVoice(undefined, "ja", "m"));
    expect(r.voice).toBe("ja-JP-KeitaNeural");
    expect(r.via).toEqual({ lang: "ja-JP", gender: "m" });
  });

  it("ambiguous subtag (zh / en) errors asking for a full locale", () => {
    for (const lang of ["zh", "en"]) {
      const r = resolveVoice(undefined, lang);
      expect("error" in r).toBe(true);
      if ("error" in r) expect(r.error).toContain("full locale");
    }
  });

  it("unknown lang errors", () => {
    expect("error" in resolveVoice(undefined, "zz-ZZ")).toBe(true);
    expect("error" in resolveVoice(undefined, "xx")).toBe(true);
  });

  it("no voice and no lang errors (caller turns this into exit 2)", () => {
    expect("error" in resolveVoice(undefined, undefined)).toBe(true);
  });
});
