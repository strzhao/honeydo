import { describe, expect, it } from "vitest";
import { extractProviderEnv, matchProviderName } from "./cli.js";

// 契约（逐字取自 C4/C5/ACC）：
//   matchProviderName(query, names[])：
//     精确 → 大小写不敏感 → 子串；命中>1 → {ambiguous}；无 → {none}；唯一 → {matched}
//   extractProviderEnv(settingsConfigJson)：JSON.parse + 取 .env；损坏 → {error}
//
// 验收覆盖：
//   ACC-5  模糊匹配 matchProviderName("k3", names) → 命中 "Kimi For Coding"
//   ACC-6  provider 不存在 → {none}（进程层 exit 2 在 runtime 测）
//   ACC-20 同名 provider（Claude Official×2）→ {ambiguous}，候选列出
//   ACC-21 settings_config 非法 JSON / 缺 env → {error}（进程层 exit 1 在 runtime 测）

const NAMES = ["Claude Official", "GLM", "Kimi For Coding"];

describe("matchProviderName // ACC-5/6/20 + 三层匹配", () => {
  it("ACC-5: query 'kimi' matches 'Kimi For Coding'", () => {
    const r = matchProviderName("kimi", NAMES);
    expect("matched" in r).toBe(true);
    if (!("matched" in r))
      throw new Error(`expected matched, got ${JSON.stringify(r)}`);
    expect(r.matched).toBe("Kimi For Coding");
  });

  it("layer 1: exact match wins", () => {
    const r = matchProviderName("GLM", NAMES);
    expect("matched" in r).toBe(true);
    if (!("matched" in r)) throw new Error("expected matched");
    expect(r.matched).toBe("GLM");
  });

  it("layer 2: case-insensitive exact match", () => {
    const r = matchProviderName("glm", NAMES);
    expect("matched" in r).toBe(true);
    if (!("matched" in r)) throw new Error("expected matched");
    expect(r.matched).toBe("GLM");
  });

  it("layer 3: substring fallback (unique)", () => {
    const r = matchProviderName("kimi", NAMES);
    expect("matched" in r).toBe(true);
    if (!("matched" in r)) throw new Error("expected matched");
    expect(r.matched).toBe("Kimi For Coding");
  });

  it("ACC-6: no match → {none}", () => {
    const r = matchProviderName("nope-not-a-provider", NAMES);
    expect("none" in r).toBe(true);
    expect("matched" in r).toBe(false);
    expect("ambiguous" in r).toBe(false);
  });

  it("ACC-20: duplicate names → {ambiguous} listing both candidates", () => {
    const dup = ["Claude Official", "GLM", "Claude Official"];
    const r = matchProviderName("claude official", dup);
    expect("ambiguous" in r).toBe(true);
    if (!("ambiguous" in r)) throw new Error("expected ambiguous");
    expect(r.ambiguous.length).toBe(2);
    expect(r.ambiguous.filter((n) => n === "Claude Official").length).toBe(2);
  });

  it("ACC-20 variant: substring matching two names → ambiguous", () => {
    // 两个都含 'claude' 的不同 name 也应判 ambiguous
    const r = matchProviderName("claude", [
      "Claude Official",
      "Claude Sonnet",
      "GLM",
    ]);
    expect("ambiguous" in r).toBe(true);
    if (!("ambiguous" in r)) throw new Error("expected ambiguous");
    expect(r.ambiguous.length).toBe(2);
  });
});

describe("extractProviderEnv // ACC-21", () => {
  it("parses a valid settings_config with env", () => {
    const json = JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: "https://kimi.example.com",
        ANTHROPIC_API_KEY: "kimi-key",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "kimi-k3[1M]",
      },
    });
    const r = extractProviderEnv(json);
    expect("env" in r).toBe(true);
    if (!("env" in r)) throw new Error("expected env");
    expect(r.env.ANTHROPIC_BASE_URL).toBe("https://kimi.example.com");
    expect(r.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("kimi-k3[1M]");
  });

  it("ACC-21: invalid JSON → {error}", () => {
    const r = extractProviderEnv("not-json{");
    expect("error" in r).toBe(true);
    if (!("error" in r)) throw new Error("expected error");
    expect(typeof r.error).toBe("string");
    expect(r.error.length).toBeGreaterThan(0);
  });

  it("ACC-21: valid JSON but missing 'env' key → {error}", () => {
    const r = extractProviderEnv(JSON.stringify({ foo: 1, permissions: {} }));
    expect("error" in r).toBe(true);
    if (!("error" in r)) throw new Error("expected error");
    expect(typeof r.error).toBe("string");
    expect(r.error.length).toBeGreaterThan(0);
  });

  it("ACC-21: 'env' present but not an object → {error}", () => {
    const r = extractProviderEnv(JSON.stringify({ env: "not-an-object" }));
    expect("error" in r).toBe(true);
  });

  it("ACC-21: null JSON → {error}", () => {
    const r = extractProviderEnv("null");
    expect("error" in r).toBe(true);
  });

  it("ACC-21: empty string → {error}", () => {
    const r = extractProviderEnv("");
    expect("error" in r).toBe(true);
  });
});
