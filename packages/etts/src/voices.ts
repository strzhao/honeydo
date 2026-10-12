/** voices 命令编排：枚举 edge-tts 音色（人读表格 / --json 单行数组）。 */
import type { VoicesArgs } from "./args.js";
import { runPython } from "./run-python.js";
import type { VoicesPayloadResult, VoiceEntry } from "./run-python.js";
import { driverScript, venvError, venvPython } from "./runtime.js";

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function table(voices: VoiceEntry[]): string {
  const w = (header: string, rows: string[]): number =>
    Math.max(header.length, ...rows.map((r) => r.length));
  const c1 = w("ShortName", voices.map((v) => v.shortName));
  const c2 = w("Gender", voices.map((v) => v.gender));
  const lines = [
    `${"ShortName".padEnd(c1)}  ${"Gender".padEnd(c2)}  Locale`,
    ...voices.map(
      (v) => `${v.shortName.padEnd(c1)}  ${v.gender.padEnd(c2)}  ${v.locale}`,
    ),
  ];
  return lines.join("\n");
}

export async function runVoices(a: VoicesArgs): Promise<number> {
  const venvErr = venvError();
  if (venvErr) {
    process.stderr.write(`${venvErr}\n`);
    return 1;
  }
  try {
    const r = await runPython<VoicesPayloadResult>(venvPython(), driverScript(), {
      op: "voices",
      lang: a.lang,
    });
    const voices = r.voices ?? [];
    if (a.json) {
      process.stdout.write(`${JSON.stringify(voices)}\n`);
    } else {
      process.stdout.write(`${table(voices)}\n`);
    }
    return 0;
  } catch (err) {
    process.stderr.write(`etts: voices failed: ${errText(err)}\n`);
    return 1;
  }
}
