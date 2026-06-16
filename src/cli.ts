#!/usr/bin/env node

/**
 * gcli — thin wrapper around the `agy` CLI (formerly `gemini` CLI).
 *
 * Adds value over calling agy directly: prompt via argv or stdin (`-p -`),
 * 50k-char output truncation, a hard timeout (spawn kill), explicit exit
 * codes, and empty-output detection. Gives skills a stable entry point so a
 * future rename of the underlying CLI only needs one place to change.
 *
 * Timeout is enforced by spawn SIGTERM (deterministic), not via agy's own
 * --print-timeout flag (whose Go-duration format we don't rely on).
 */

import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes
export const CHARACTER_LIMIT = 50_000;
const AGY_BIN = "agy";
const VERSION_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

export function truncate(text: string): string {
  if (text.length <= CHARACTER_LIMIT) return text;
  return (
    text.slice(0, CHARACTER_LIMIT) +
    `\n\n[Truncated — response exceeded ${CHARACTER_LIMIT} characters]`
  );
}

export interface GcliOptions {
  prompt: string; // prompt text, or "-" to read from stdin
  model?: string;
  yolo: boolean;
  sandbox: boolean;
  cwd?: string;
  timeoutMs: number;
}

/** Translate gcli options into agy argv. Timeout is enforced by spawn kill. */
export function buildAgyArgs(opts: GcliOptions): string[] {
  const args: string[] = [];
  if (opts.model) args.push("--model", opts.model);
  if (opts.yolo) args.push("--dangerously-skip-permissions");
  if (opts.sandbox) args.push("--sandbox");
  if (opts.cwd) args.push("--add-dir", resolve(opts.cwd));
  args.push("-p", opts.prompt);
  return args;
}

export interface ParsedArgs {
  prompt?: string;
  model?: string;
  yolo: boolean;
  sandbox: boolean;
  cwd?: string;
  timeoutMs: number;
  version: boolean;
  help: boolean;
}

export type ParseResult = ParsedArgs | { error: string };

function isOk(r: ParseResult): r is ParsedArgs {
  return !("error" in r);
}

export function parseCliArgs(argv: string[]): ParseResult {
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        prompt: { short: "p", type: "string" },
        model: { type: "string" },
        yolo: { type: "boolean" },
        sandbox: { type: "boolean" },
        cwd: { type: "string" },
        timeout: { type: "string" },
        version: { type: "boolean" },
        help: { type: "boolean" },
      },
      allowNegative: true,
    });

    let timeoutMs = DEFAULT_TIMEOUT_MS;
    if (values.timeout !== undefined) {
      const n = Number(values.timeout);
      if (!Number.isFinite(n) || n < 1000 || n > 600_000) {
        return {
          error: `--timeout must be a number in [1000, 600000], got "${values.timeout}"`,
        };
      }
      timeoutMs = n;
    }

    return {
      prompt: values.prompt,
      model: values.model,
      yolo: values.yolo ?? false,
      sandbox: values.sandbox ?? false,
      cwd: values.cwd,
      timeoutMs,
      version: values.version ?? false,
      help: values.help ?? false,
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// Spawn
// ---------------------------------------------------------------------------

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

export function runAgy(
  args: string[],
  timeoutMs: number,
  cwd?: string,
): Promise<RunResult> {
  return new Promise((resolveFn) => {
    const child = spawn(AGY_BIN, args, {
      cwd,
      env: { ...process.env },
      // inherit stdin so `agy -p -` can read a piped prompt through gcli
      stdio: ["inherit", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.on("error", () => {
      clearTimeout(timer);
      resolveFn({ stdout, stderr, exitCode: null, timedOut: false });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveFn({ stdout, stderr, exitCode: code, timedOut });
    });
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const HELP = `Usage: gcli [options]

Wrap the agy CLI (formerly gemini). Sends a prompt, truncates output to 50k
chars, enforces a hard timeout, and maps results to explicit exit codes.

Options:
  -p, --prompt <text|->   Prompt text, or "-" to read from stdin
      --model <name>      agy model (e.g. gemini-2.5-pro)
      --yolo              Auto-approve tool actions
      --sandbox           Run agy in sandbox mode
      --cwd <dir>         Working directory (added via agy --add-dir)
      --timeout <ms>      Hard timeout in ms (default 300000, max 600000)
      --version           Print the agy version
      --help              Show this help

Exit codes: 0 success | 1 agy error / timeout / empty output | 2 bad args`;

interface ExitPayload {
  code: number;
  stdout?: string;
  stderr?: string;
}

async function run(parsed: ParsedArgs): Promise<ExitPayload> {
  if (parsed.version) {
    const r = await runAgy(["--version"], VERSION_TIMEOUT_MS);
    const out = (r.stdout || r.stderr).trim();
    return { code: r.exitCode === 0 ? 0 : 1, stdout: out };
  }

  if (parsed.prompt === undefined) {
    return {
      code: 2,
      stderr: "-p/--prompt is required (use '-p -' for stdin)",
    };
  }

  const opts: GcliOptions = {
    prompt: parsed.prompt,
    model: parsed.model,
    yolo: parsed.yolo,
    sandbox: parsed.sandbox,
    cwd: parsed.cwd,
    timeoutMs: parsed.timeoutMs,
  };

  const args = buildAgyArgs(opts);
  const cwdAbs = opts.cwd ? resolve(opts.cwd) : undefined;
  const result = await runAgy(args, opts.timeoutMs, cwdAbs);

  if (result.timedOut) {
    return { code: 1, stderr: `timed out after ${opts.timeoutMs}ms` };
  }

  const out = result.stdout.trim();
  if (result.exitCode !== 0) {
    const errInfo =
      result.stderr.trim() || out || `agy exited with code ${result.exitCode}`;
    return {
      code: 1,
      stderr: `agy failed (exit ${result.exitCode})\n${truncate(errInfo)}`,
    };
  }
  if (!out) {
    const info = result.stderr.trim()
      ? `stderr: ${truncate(result.stderr)}`
      : "no output";
    return { code: 1, stderr: `agy returned ${info}` };
  }
  return { code: 0, stdout: truncate(out) };
}

async function main(): Promise<void> {
  const parsed = parseCliArgs(process.argv.slice(2));
  if (!isOk(parsed)) {
    process.stderr.write(`gcli: ${parsed.error}\n`);
    process.exit(2);
  }
  if (parsed.help) {
    process.stdout.write(`${HELP}\n`);
    process.exit(0);
  }
  const payload = await run(parsed);
  if (payload.stdout) process.stdout.write(`${payload.stdout}\n`);
  if (payload.stderr) process.stderr.write(`gcli: ${payload.stderr}\n`);
  process.exit(payload.code);
}

// realpathSync resolves the npm-link symlink so the guard holds when gcli is
// run via the global bin, not just via its source path.
const invokedDirectly =
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((err: unknown) => {
    process.stderr.write(
      `gcli: fatal ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
}
