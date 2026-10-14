/** batch 命令编排：manifest JSONL 批量合成 + 失败清单 + skip-existing + 单行 JSON 收尾。 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { BatchArgs } from "./args.js";
import { resolveVoice } from "./defaults.js";
import type { ManifestItemError } from "./manifest.js";
import { parseManifest } from "./manifest.js";
import { runPython } from "./run-python.js";
import type { SynthPayloadResult, SynthResult } from "./run-python.js";
import { driverScript, venvError, venvPython } from "./runtime.js";

interface FailureEntry extends ManifestItemError {}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function fileSize(p: string): number {
  try {
    return fs.statSync(p).size;
  } catch {
    return -1;
  }
}

export async function runBatch(a: BatchArgs): Promise<number> {
  // 参数侧校验（manifest 可读性）先于运行时校验（venv）——契约「manifest 不存在
  // → exit==2」不得依赖 venv 是否已置备（全新机器走到参数校验时 venv 常未 setup，
  // 先查 venv 会把坏参数误报成 exit 1，2026-10-14 CI ubuntu 实证）
  let raw: string;
  try {
    raw = fs.readFileSync(a.manifest, "utf-8");
  } catch (err) {
    process.stderr.write(`etts: cannot read manifest at ${a.manifest}: ${errText(err)}\n`);
    return 2;
  }
  const venvErr = venvError();
  if (venvErr) {
    process.stderr.write(`${venvErr}\n`);
    return 1;
  }

  const { items, itemErrors } = parseManifest(raw);
  const failures: FailureEntry[] = [...itemErrors];

  // 音色解析（--voice > --lang 查表）；解析失败的行记入失败清单，不中断其余行
  const pending: { index: number; text: string; out: string; voice: string }[] = [];
  for (const it of items) {
    const rv = resolveVoice(it.voice, it.lang, it.gender ?? "f");
    if ("error" in rv) {
      failures.push({ index: it.index, text: it.text, out: it.out, voice: it.voice, error: rv.error });
    } else {
      pending.push({ index: it.index, text: it.text, out: it.out, voice: rv.voice });
    }
  }

  // --skip-existing：out 已存在且 size>0 → skipped；size==0 视为不存在，重合成
  const toSynth: typeof pending = [];
  let skipped = 0;
  for (const p of pending) {
    if (a.skipExisting && fileSize(p.out) > 0) {
      skipped += 1;
      process.stderr.write(`[skip] ${p.out} (exists)\n`);
    } else {
      toSynth.push(p);
    }
  }

  const t0 = Date.now();
  let results: SynthResult[] = [];
  if (toSynth.length > 0) {
    for (const p of toSynth) {
      fs.mkdirSync(path.dirname(path.resolve(p.out)), { recursive: true });
    }
    try {
      const r = await runPython<SynthPayloadResult>(venvPython(), driverScript(), {
        op: "synth",
        items: toSynth.map(({ text, voice, out }) => ({ text, voice, out })),
        retry: a.retry,
        proxy: a.proxy,
      });
      results = r.results ?? [];
    } catch (err) {
      process.stderr.write(`etts: batch failed: ${errText(err)}\n`);
      return 1;
    }
  }

  let ok = 0;
  results.forEach((r, i) => {
    const p = toSynth[i];
    if (r.ok) {
      ok += 1;
      process.stdout.write(`Saved to: ${path.resolve(r.out)}\n`);
      process.stderr.write(`[${i + 1}/${toSynth.length}] ok ${r.out} (attempts ${r.attempts})\n`);
    } else {
      failures.push({
        index: p.index,
        text: p.text,
        out: p.out,
        voice: p.voice,
        error: r.error ?? "unknown driver error",
      });
      process.stderr.write(`[${i + 1}/${toSynth.length}] fail ${r.out} (attempts ${r.attempts}): ${r.error ?? ""}\n`);
    }
  });

  failures.sort((x, y) => x.index - y.index);
  // failed 计失败清单总数（坏行/解析失败/合成失败），不只是合成失败——
  // 否则 itemErrors/分辨率失败不进 summary、退出码错判 0（dogfood 实测抓到过）
  const failed = failures.length;
  if (a.failures) {
    const body = failures.map((f) => JSON.stringify(f)).join("\n");
    fs.writeFileSync(a.failures, failures.length > 0 ? `${body}\n` : "");
  }

  const total = items.length + itemErrors.length;
  const seconds = Number(((Date.now() - t0) / 1000).toFixed(2));
  process.stdout.write(
    `${JSON.stringify({ total, ok, skipped, failed, seconds })}\n`,
  );
  return failed > 0 ? 1 : 0;
}
