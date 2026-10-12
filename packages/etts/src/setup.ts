/** setup 命令编排：探测 python3 → 建 venv（幂等，已有则复用）→ pip 装 edge-tts（PyPI）
 *  → 合成探测 1 条短样例 → 403/NoAudioReceived 则改装 PR #491 分支并复测 → 报告结论。
 *  检查行走 stderr，结论末行走 stdout；exit 0=探测通过 / 1=失败。 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runPython } from "./run-python.js";
import type { SynthPayloadResult } from "./run-python.js";
import { driverScript, venvPython, venvRoot } from "./runtime.js";

/** 403 封锁期回退分支（2026-10-12 dry run 实测可用；7.2.9 发版后自然回归 PyPI） */
const FALLBACK_EDGE_TTS =
  "git+https://github.com/jonata/edge-tts.git@fix-locale-independent-server-date";
const PROBE_VOICE = "en-US-AvaMultilingualNeural";

function step(msg: string): void {
  process.stderr.write(`etts setup: ${msg}\n`);
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function runCapture(cmd: string, args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync(cmd, args, { encoding: "utf-8" });
}

function forwardOutput(r: ReturnType<typeof spawnSync>): void {
  if (r.stdout) process.stderr.write(r.stdout.toString());
  if (r.stderr) process.stderr.write(r.stderr.toString());
}

function probePython3(): string | null {
  const r = runCapture("python3", ["--version"]);
  if (r.status !== 0 || r.error) return null;
  return (r.stdout.toString().trim() || r.stderr.toString().trim()) || "python3";
}

function installEdgeTts(python: string, spec: string, force: boolean): boolean {
  const args = ["-m", "pip", "install", ...(force ? ["--force-reinstall", "--no-deps"] : []), spec];
  step(`pip install ${spec}${force ? " (force)" : ""}`);
  const r = runCapture(python, args);
  forwardOutput(r);
  if (r.status !== 0 || r.error) {
    step(`pip install failed (exit ${r.status ?? "?"})`);
    return false;
  }
  return true;
}

function edgeTtsVersion(python: string): string {
  const r = runCapture(python, [
    "-c",
    "from importlib.metadata import version; print(version('edge-tts'))",
  ]);
  const v = r.stdout?.toString().trim();
  return v && r.status === 0 ? v : "unknown";
}

async function probeSynth(): Promise<{ ok: boolean; error: string }> {
  const out = path.join(os.tmpdir(), `etts-setup-probe-${process.pid}.mp3`);
  try {
    const r = await runPython<SynthPayloadResult>(venvPython(), driverScript(), {
      op: "synth",
      items: [{ text: "setup probe.", voice: PROBE_VOICE, out }],
      retry: 1,
    });
    const first = r.results?.[0];
    return first?.ok
      ? { ok: true, error: "" }
      : { ok: false, error: first?.error ?? "unknown driver error" };
  } catch (err) {
    return { ok: false, error: errText(err) };
  } finally {
    try {
      fs.rmSync(out, { force: true });
    } catch {
      // 清理失败不影响结论
    }
  }
}

export async function runSetup(): Promise<number> {
  const root = venvRoot();
  const py = venvPython();

  const pyVer = probePython3();
  if (!pyVer) {
    process.stderr.write("etts setup: python3 not found on PATH; install python 3.10+ first\n");
    return 1;
  }
  step(`python3: ok (${pyVer})`);

  if (fs.existsSync(py)) {
    step(`venv exists, reusing ${root}`);
  } else {
    step(`creating venv at ${root}`);
    const r = runCapture("python3", ["-m", "venv", root]);
    forwardOutput(r);
    if (r.status !== 0 || r.error || !fs.existsSync(py)) {
      step(`venv creation failed (exit ${r.status ?? "?"})`);
      return 1;
    }
  }

  if (!installEdgeTts(py, "edge-tts", false)) {
    process.stderr.write(
      `etts: setup failed installing edge-tts from PyPI; check network/proxy and retry, or install manually:\n  ${py} -m pip install ${FALLBACK_EDGE_TTS}\n`,
    );
    return 1;
  }

  step("probing synthesis (1 short sample)");
  let probe = await probeSynth();
  if (!probe.ok && /403|NoAudioReceived/.test(probe.error)) {
    step("synthesis blocked (403/NoAudioReceived) — falling back to PR #491 branch");
    if (!installEdgeTts(py, FALLBACK_EDGE_TTS, true)) {
      process.stderr.write(
        `etts: setup failed installing the fallback branch; check network/proxy and retry:\n  ${py} -m pip install --force-reinstall ${FALLBACK_EDGE_TTS}\n`,
      );
      return 1;
    }
    probe = await probeSynth();
  }
  if (!probe.ok) {
    process.stderr.write(
      `etts: setup failed at the synthesis probe: ${probe.error}\n` +
        "hints: check network reachability to the Microsoft endpoint, or pass a proxy via ETTS_PROXY/HTTPS_PROXY\n",
    );
    return 1;
  }

  process.stdout.write(
    `etts: setup ok (venv=${root}, edge-tts=${edgeTtsVersion(py)})\n`,
  );
  return 0;
}
