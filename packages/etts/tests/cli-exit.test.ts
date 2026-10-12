/** dist 产物契约测试：退出码 0/1/2 分域 + stderr 指引文案——全部无网络可跑。
 *  venv 缺失路径用 ETTS_RUNTIME 指向不存在目录驱动（env > ~/.etts/venv），不碰真机 venv。 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(HERE, "..", "dist", "cli.js");
const hasDist = existsSync(CLI);

const NO_VENV = { ETTS_RUNTIME: "/nonexistent-etts-contract-test-venv" };

function run(
  args: string[],
  env: Record<string, string> = {},
): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf-8",
    env: { ...process.env, ...env },
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

describe.skipIf(!hasDist)("etts dist contract (no network)", () => {
  it("gen without --out → exit 2", () => {
    const r = run(["gen", "hi", "--voice", "x"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--out");
  });

  it("unknown flag → exit 2", () => {
    const r = run(["gen", "hi", "--voice", "x", "--out", "/tmp/x.mp3", "--bogus", "1"]);
    expect(r.status).toBe(2);
    expect(r.stderr).not.toBe("");
  });

  it("gen without voice and lang → exit 2", () => {
    const r = run(["gen", "hi", "--out", "/tmp/x.mp3"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--voice");
  });

  it("invalid --gender → exit 2", () => {
    const r = run(["gen", "hi", "--voice", "x", "--out", "/tmp/x.mp3", "--gender", "q"]);
    expect(r.status).toBe(2);
  });

  it("unknown subcommand → exit 2 with non-empty stderr", () => {
    const r = run(["frobnicate"]);
    expect(r.status).toBe(2);
    expect(r.stderr).not.toBe("");
  });

  it("venv missing → exit 1 with setup hint on stderr", () => {
    const r = run(["gen", "hi", "--voice", "x", "--out", "/tmp/x.mp3"], NO_VENV);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("venv not found at /nonexistent-etts-contract-test-venv");
    expect(r.stderr).toContain("run: etts setup");
  });

  it("batch with missing venv → exit 1 before touching the manifest", () => {
    const r = run(["batch", "/nonexistent-manifest.jsonl"], NO_VENV);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("run: etts setup");
  });
});
