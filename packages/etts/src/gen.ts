/** gen 命令编排：单条合成（网络/子进程都在这层）。 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { GenArgs } from "./args.js";
import { runPython } from "./run-python.js";
import type { SynthPayloadResult } from "./run-python.js";
import { driverScript, venvError, venvPython } from "./runtime.js";

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function runGen(a: GenArgs): Promise<number> {
  const venvErr = venvError();
  if (venvErr) {
    process.stderr.write(`${venvErr}\n`);
    return 1;
  }
  // 实际所用音色回显（stderr；表解析命中带 via 说明）
  process.stderr.write(
    a.via
      ? `voice: ${a.voice} (via lang ${a.via.lang}, gender ${a.via.gender})\n`
      : `voice: ${a.voice}\n`,
  );
  fs.mkdirSync(path.dirname(path.resolve(a.out)), { recursive: true });
  try {
    const r = await runPython<SynthPayloadResult>(venvPython(), driverScript(), {
      op: "synth",
      items: [{ text: a.text, voice: a.voice, out: a.out }],
      retry: a.retry,
      proxy: a.proxy,
    });
    const first = r.results?.[0];
    if (first?.ok) {
      process.stdout.write(`Saved to: ${path.resolve(a.out)}\n`);
      return 0;
    }
    process.stderr.write(`etts: gen failed: ${first?.error ?? "unknown driver error"}\n`);
    return 1;
  } catch (err) {
    process.stderr.write(`etts: gen failed: ${errText(err)}\n`);
    return 1;
  }
}
