import { describe, expect, it } from "vitest";
import { buildClaudeArgs, buildSettingsEnv } from "./cli.js";

// 契约（逐字取自 C3/C5/C8 与 ACC）：
//   buildClaudeArgs({prompt, settingsEnv?, cwd?})：
//     ["-p", prompt]  + 可选 ["--settings", JSON.stringify({env: settingsEnv})]  + 可选 ["--add-dir", cwd]
//   buildSettingsEnv(providerEnv, model?)：
//     拷贝 env + 显式 set ANTHROPIC_MODEL
//     优先级：model 参数 > providerEnv.ANTHROPIC_MODEL > DEFAULT_SONNET_MODEL > DEFAULT_OPUS_MODEL > 首个 DEFAULT_*
//
// 验收覆盖：
//   ACC-3  无 --provider → argv 不含 --settings
//   ACC-4  --provider k3 → argv 含 --settings，JSON.env.ANTHROPIC_BASE_URL 含 'kimi'，ANTHROPIC_MODEL 已 set
//   ACC-7  隔离：argv 无任何元素指向 ~/.claude/settings.json（不改全局）
//   ACC-8  --model 覆盖 → env.ANTHROPIC_MODEL 取 --model 值
//   ACC-9  k3 无 ANTHROPIC_MODEL 且无 --model → ANTHROPIC_MODEL = DEFAULT_SONNET_MODEL 值

const K3_ENV = {
  ANTHROPIC_BASE_URL: "https://kimi.koding.com",
  ANTHROPIC_API_KEY: "kimi-key",
  ANTHROPIC_DEFAULT_SONNET_MODEL: "kimi-k3[1M]",
  ANTHROPIC_DEFAULT_OPUS_MODEL: "kimi-k3-opus",
};

const GLM_ENV = {
  ANTHROPIC_BASE_URL: "https://glm.example.com",
  ANTHROPIC_API_KEY: "glm-key",
  ANTHROPIC_MODEL: "glm-5.2",
};

describe("buildClaudeArgs // ACC-3/4/7 + C8 cwd→add-dir", () => {
  it("ACC-3: no settingsEnv → argv is exactly ['-p', prompt], no --settings", () => {
    const args = buildClaudeArgs({ prompt: "hi" });
    expect(args).toEqual(["-p", "hi"]);
    expect(args).not.toContain("--settings");
  });

  it("ACC-3: stdin marker '-' as prompt passes through", () => {
    const args = buildClaudeArgs({ prompt: "-" });
    expect(args).toEqual(["-p", "-"]);
  });

  it("ACC-4: with settingsEnv → argv contains --settings and JSON.env with kimi base + ANTHROPIC_MODEL set", () => {
    const settingsEnv = buildSettingsEnv(K3_ENV);
    const args = buildClaudeArgs({ prompt: "hi", settingsEnv });
    const idx = args.indexOf("--settings");
    expect(idx).toBeGreaterThan(-1);
    const json = JSON.parse(args[idx + 1]);
    expect(json.env).toBeDefined();
    expect(String(json.env.ANTHROPIC_BASE_URL)).toContain("kimi");
    // ACC-4 关键：ANTHROPIC_MODEL 必须被显式 set（非 undefined）
    expect(json.env.ANTHROPIC_MODEL).toBeTruthy();
    expect(typeof json.env.ANTHROPIC_MODEL).toBe("string");
    expect(json.env.ANTHROPIC_MODEL.length).toBeGreaterThan(0);
  });

  it("ACC-7: argv never references ~/.claude/settings.json (no global mutation path)", () => {
    const args = buildClaudeArgs({
      prompt: "hi",
      settingsEnv: buildSettingsEnv(K3_ENV),
      cwd: "/repo",
    });
    const flat = args.join(" ");
    expect(flat).not.toContain(".claude/settings.json");
    expect(flat).not.toContain("settings.json");
  });

  it("C8: --cwd maps to --add-dir (not to spawn cwd)", () => {
    const args = buildClaudeArgs({ prompt: "hi", cwd: "/repo" });
    const idx = args.indexOf("--add-dir");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("/repo");
  });

  it("combined: prompt + settings + cwd → ['-p', prompt, '--settings', JSON, '--add-dir', cwd]", () => {
    const args = buildClaudeArgs({
      prompt: "hi",
      settingsEnv: buildSettingsEnv(K3_ENV),
      cwd: "/repo",
    });
    expect(args[0]).toBe("-p");
    expect(args[1]).toBe("hi");
    expect(args).toContain("--settings");
    expect(args).toContain("--add-dir");
    // --settings 的值是合法 JSON 字符串
    const sIdx = args.indexOf("--settings");
    expect(() => JSON.parse(args[sIdx + 1])).not.toThrow();
  });

  it("INT-9: omitted prompt → no -p (interactive mode), settings + cwd still emitted", () => {
    const args = buildClaudeArgs({
      settingsEnv: buildSettingsEnv(K3_ENV),
      cwd: "/repo",
    });
    expect(args).not.toContain("-p");
    expect(args).toContain("--settings");
    expect(args).toContain("--add-dir");
    expect(args).toContain("/repo");
  });

  it("PASSTHROUGH: forwarded verbatim, no `--` added", () => {
    const args = buildClaudeArgs({
      prompt: "hi",
      passthrough: ["--dangerously-skip-permissions", "--flag", "v"],
    });
    expect(args).toEqual([
      "-p",
      "hi",
      "--dangerously-skip-permissions",
      "--flag",
      "v",
    ]);
  });
});

describe("buildSettingsEnv // ACC-8/9 + C5 ANTHROPIC_MODEL 优先级链", () => {
  it("ACC-9: k3 env (no ANTHROPIC_MODEL, no --model) → ANTHROPIC_MODEL = DEFAULT_SONNET_MODEL value", () => {
    const env = buildSettingsEnv(K3_ENV);
    expect(env.ANTHROPIC_MODEL).toBe(K3_ENV.ANTHROPIC_DEFAULT_SONNET_MODEL);
    expect(env.ANTHROPIC_MODEL).toBe("kimi-k3[1M]");
  });

  it("ACC-8: explicit --model overrides everything", () => {
    const env = buildSettingsEnv(K3_ENV, "kimi-for-coding");
    expect(env.ANTHROPIC_MODEL).toBe("kimi-for-coding");
  });

  it("ACC-8: --model overrides even when provider env already has ANTHROPIC_MODEL", () => {
    const env = buildSettingsEnv(GLM_ENV, "override-model");
    expect(env.ANTHROPIC_MODEL).toBe("override-model");
  });

  it("C5 priority: no --model, provider has ANTHROPIC_MODEL → use provider value", () => {
    const env = buildSettingsEnv(GLM_ENV);
    expect(env.ANTHROPIC_MODEL).toBe("glm-5.2");
  });

  it("C5 priority: no ANTHROPIC_MODEL, no DEFAULT_SONNET, has DEFAULT_OPUS → OPUS", () => {
    const envOnlyOpus = {
      ANTHROPIC_BASE_URL: "https://x.example.com",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "opus-x",
    };
    const env = buildSettingsEnv(envOnlyOpus);
    expect(env.ANTHROPIC_MODEL).toBe("opus-x");
  });

  it("C5 priority: nothing present → ANTHROPIC_MODEL undefined (no crash)", () => {
    const bare = { ANTHROPIC_BASE_URL: "https://x.example.com" };
    const env = buildSettingsEnv(bare);
    expect(env.ANTHROPIC_BASE_URL).toBe("https://x.example.com");
    // 没有 DEFAULT_* 时 ANTHROPIC_MODEL 无可派生值；实现可选 undefined 或抛错，
    // 这里只断言不崩 + base url 保留。若实现选择抛错，此断言驱动契约明确化。
    expect("ANTHROPIC_MODEL" in env).toBe(true);
  });

  it("buildSettingsEnv copies the rest of env verbatim", () => {
    const env = buildSettingsEnv(K3_ENV);
    expect(env.ANTHROPIC_BASE_URL).toBe(K3_ENV.ANTHROPIC_BASE_URL);
    expect(env.ANTHROPIC_API_KEY).toBe(K3_ENV.ANTHROPIC_API_KEY);
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe(
      K3_ENV.ANTHROPIC_DEFAULT_SONNET_MODEL,
    );
  });
});
