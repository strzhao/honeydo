import { describe, expect, it } from "vitest";
import { buildClonePayload } from "./voice-clone.js";
import { buildTtsRequestData } from "./tts.js";
import {
  parseTtsArgs,
  parseVoiceCloneArgs,
  parseVoicesArgs,
  type TtsParse,
  type VoiceCloneParse,
  type VoicesParse,
} from "./cli.js";
import { ensureValidEmotion } from "./validate.js";

function ttsOk(r: TtsParse) {
  if ("error" in r) throw new Error(`unexpected tts parse error: ${r.error}`);
  return r;
}
function vcOk(r: VoiceCloneParse) {
  if ("error" in r) throw new Error(`unexpected vc parse error: ${r.error}`);
  return r;
}
function voicesOk(r: VoicesParse) {
  if ("error" in r) throw new Error(`unexpected voices parse error: ${r.error}`);
  return r;
}

describe("parseTtsArgs", () => {
  it("takes text as the first positional and parses --voice", () => {
    const r = ttsOk(parseTtsArgs(["hello", "--voice", "xiaoxiong"]));
    expect(r.text).toBe("hello");
    expect(r.voiceId).toBe("xiaoxiong");
  });

  it("converts numeric options (negatives via = form, a parseArgs limit)", () => {
    const r = ttsOk(
      parseTtsArgs(["hi", "--speed", "1.5", "--pitch=-3", "--sample-rate", "44100"]),
    );
    expect(r.speed).toBe(1.5);
    expect(r.pitch).toBe(-3);
    expect(r.sampleRate).toBe(44100);
  });

  it("rejects non-numeric --speed", () => {
    expect("error" in parseTtsArgs(["hi", "--speed", "fast"])).toBe(true);
  });

  it("allows missing text (run() owns that error path)", () => {
    const r = parseTtsArgs(["--voice", "xiaoxiong"]);
    expect("error" in r).toBe(false);
    if (!("error" in r)) expect(r.text).toBeUndefined();
  });
});

describe("parseVoiceCloneArgs", () => {
  it("parses --voice and --audio", () => {
    const r = vcOk(parseVoiceCloneArgs(["--voice", "v1", "--audio", "/a.wav"]));
    expect(r.voiceId).toBe("v1");
    expect(r.audioFile).toBe("/a.wav");
  });
});

describe("parseVoicesArgs", () => {
  it("defaults type to all", () => {
    expect(voicesOk(parseVoicesArgs([])).type).toBe("all");
  });

  it("accepts a custom type", () => {
    expect(voicesOk(parseVoicesArgs(["--type", "system"])).type).toBe("system");
  });

  it("rejects an invalid type", () => {
    expect("error" in parseVoicesArgs(["--type", "bogus"])).toBe(true);
  });
});

describe("buildTtsRequestData", () => {
  it("applies defaults for a minimal request", () => {
    const d = buildTtsRequestData({ text: "hi" });
    expect(d.model).toBe("speech-02-hd");
    expect(d.stream).toBe(false);
    const vs = d.voice_setting as Record<string, unknown>;
    expect(vs.voice_id).toBe("male-qn-qingse");
    expect(vs.emotion).toBe("happy");
  });

  it("omits emotion for models that do not support it", () => {
    const d = buildTtsRequestData({ text: "hi", model: "speech-01-240228" });
    const vs = d.voice_setting as Record<string, unknown>;
    expect(vs.emotion).toBeUndefined();
  });

  it("passes through explicit overrides", () => {
    const d = buildTtsRequestData({
      text: "hi",
      voiceId: "xiaoxiong",
      speed: 1.2,
      emotion: "sad",
    });
    const vs = d.voice_setting as Record<string, unknown>;
    expect(vs.voice_id).toBe("xiaoxiong");
    expect(vs.speed).toBe(1.2);
    expect(vs.emotion).toBe("sad");
  });
});

describe("buildClonePayload", () => {
  it("includes file_id and voice_id", () => {
    const p = buildClonePayload("f123", {
      voiceId: "v1",
      audioFile: "/a.wav",
    });
    expect(p.file_id).toBe("f123");
    expect(p.voice_id).toBe("v1");
    expect(p.text).toBeUndefined();
  });

  it("adds text + model when demo text is provided", () => {
    const p = buildClonePayload("f123", {
      voiceId: "v1",
      audioFile: "/a.wav",
      text: "demo",
    });
    expect(p.text).toBe("demo");
    expect(p.model).toBe("speech-02-hd");
  });
});

describe("ensureValidEmotion", () => {
  it("returns a valid emotion unchanged", () => {
    expect(ensureValidEmotion("sad")).toBe("sad");
  });

  it("falls back to happy for invalid input", () => {
    expect(ensureValidEmotion("excited")).toBe("happy");
  });

  it("returns undefined for emotion-unsupported models", () => {
    expect(ensureValidEmotion("happy", "speech-01-240228")).toBeUndefined();
  });
});
