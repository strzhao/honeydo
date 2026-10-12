/** doctor 命令编排：python3 / venv / edge_tts import / voices API 可达性四项检查 + 指引。
 *  不做合成探测。检查行走 stderr，结论末行走 stdout；exit 0=全部通过 / 1=有失败。 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { runPython } from "./run-python.js";
import type { VoicesPayloadResult } from "./run-python.js";
import { driverScript, venvPython, venvRoot } from "./runtime.js";

function step(msg: string): void {
  process.stderr.write(`etts doctor: ${msg}\n`);
}

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export async function runDoctor(): Promise<number> {
  const root = venvRoot();
  const py = venvPython();
  const checks: Check[] = [];

  const pyR = spawnSync("python3", ["--version"], { encoding: "utf-8" });
  const pyOk = pyR.status === 0 && !pyR.error;
  checks.push({
    name: "python3",
    ok: pyOk,
    detail: pyOk ? (pyR.stdout?.trim() || pyR.stderr?.trim() || "ok") : "not found on PATH",
  });

  const venvOk = fs.existsSync(py);
  checks.push({
    name: "venv",
    ok: venvOk,
    detail: venvOk ? root : `not found at ${root}; run: etts setup`,
  });

  let version = "unknown";
  if (venvOk) {
    // 版本探测与 setup.ts 同源（importlib.metadata），不吃 edge_tts.__version__ 属性缺失的坑
    const imp = spawnSync(py, ["-c", "from importlib.metadata import version; print(version('edge-tts'))"], {
      encoding: "utf-8",
    });
    const impOk = imp.status === 0 && !imp.error;
    version = impOk ? imp.stdout.trim() : "unknown";
    checks.push({
      name: "edge_tts",
      ok: impOk,
      detail: impOk ? `import ok (${version})` : `import failed: ${(imp.stderr ?? "").trim().slice(-200)}`,
    });

    try {
      const r = await runPython<VoicesPayloadResult>(py, driverScript(), { op: "voices" });
      checks.push({
        name: "voices API",
        ok: true,
        detail: `reachable (${(r.voices ?? []).length} voices)`,
      });
    } catch (err) {
      checks.push({
        name: "voices API",
        ok: false,
        detail: `unreachable: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`,
      });
    }
  } else {
    checks.push({ name: "edge_tts", ok: false, detail: "skipped (no venv); run: etts setup" });
    checks.push({ name: "voices API", ok: false, detail: "skipped (no venv); run: etts setup" });
  }

  for (const c of checks) {
    step(`${c.name}: ${c.ok ? "ok" : "FAIL"} (${c.detail})`);
  }
  const passed = checks.filter((c) => c.ok).length;
  if (passed === checks.length) {
    process.stdout.write(`etts: doctor ok (venv=${root}, edge-tts=${version})\n`);
    return 0;
  }
  process.stdout.write(`etts: doctor failed (${passed}/${checks.length} checks ok)\n`);
  return 1;
}
