#!/usr/bin/env node
/**
 * etts — free Microsoft neural TTS (edge-tts) as a scriptable CLI.
 *
 * Subcommands:
 *   gen      one text → one mp3
 *   batch    JSONL manifest → many mp3s (+ failure list)
 *   voices   list available voices
 *   setup    provision the venv + edge-tts (403 fallback aware)
 *   doctor   four-point self check
 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseBatchArgs, parseGenArgs, parseVoicesArgs } from "./args.js";
import { runBatch } from "./batch.js";
import { runDoctor } from "./doctor.js";
import { runGen } from "./gen.js";
import { runSetup } from "./setup.js";
import { runVoices } from "./voices.js";

const HELP = `etts — free Microsoft neural TTS (edge-tts), scriptable and batch-friendly.

Usage: etts <command> [options]

Commands:
  gen <text> --out <path> [--voice <name>] [--lang <bcp47>] [--gender m|f] [--retry <n>] [--proxy <url>]
      Synthesize one mp3. Voice resolution: --voice wins; else --lang looks up the
      built-in default table (15 locales, f/m columns; e.g. --lang ja = Nanami).
  batch <manifest.jsonl> [--failures <path>] [--skip-existing] [--retry <n>] [--proxy <url>]
      Synthesize a JSONL manifest ({"text","out","voice"|"lang","gender"?}).
      Failed lines never abort the run; they land in the failure list and exit 1.
  voices [--lang <prefix>] [--json]
      List voices (aligned table; --json prints one JSON array line).
  setup
      Create the venv and install edge-tts; on endpoint 403 falls back to the
      PR #491 branch and re-probes. Idempotent (safe to re-run).
  doctor
      Check python3 / venv / edge_tts import / voices API reachability. No synthesis.

Options:
  --gender m|f      default f (used with --lang table lookup)
  --retry <n>       per-item attempts, integer >= 1 (default 3)
  --proxy <url>     proxy for the Microsoft endpoint (env: ETTS_PROXY, then HTTPS_PROXY)

Env:
  ETTS_RUNTIME      venv location (default ~/.etts/venv)

Exit codes: 0 success | 1 runtime error (incl. batch failures) | 2 bad args
Results go to stdout ("Saved to: <path>", batch summary JSON); progress to stderr.
Docs: packages/etts/USAGE.md`;

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (
    cmd === undefined ||
    cmd === "help" ||
    cmd === "--help" ||
    cmd === "-h" ||
    rest.includes("--help") ||
    rest.includes("-h")
  ) {
    process.stdout.write(`${HELP}\n`);
    return cmd === undefined ? 2 : 0;
  }
  switch (cmd) {
    case "gen": {
      const parsed = parseGenArgs(rest);
      if ("error" in parsed) {
        process.stderr.write(`etts: ${parsed.error}\n`);
        return 2;
      }
      return runGen(parsed);
    }
    case "batch": {
      const parsed = parseBatchArgs(rest);
      if ("error" in parsed) {
        process.stderr.write(`etts: ${parsed.error}\n`);
        return 2;
      }
      return runBatch(parsed);
    }
    case "voices": {
      const parsed = parseVoicesArgs(rest);
      if ("error" in parsed) {
        process.stderr.write(`etts: ${parsed.error}\n`);
        return 2;
      }
      return runVoices(parsed);
    }
    case "setup":
      return runSetup();
    case "doctor":
      return runDoctor();
    default:
      process.stderr.write(`etts: unknown command "${cmd}". Run "etts --help".\n`);
      return 2;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      process.stderr.write(
        `etts: fatal ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exitCode = 1;
    });
}
