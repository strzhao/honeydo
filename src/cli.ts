#!/usr/bin/env node

/**
 * gcli — thin wrapper around the `agy` and `claude` CLI backends.
 *
 * Default backend is agy (formerly gemini); `gcli claude ...` routes to the
 * claude CLI and can switch cc-switch providers inline via
 * `claude -p ... --settings`. Adds value over calling the backends directly:
 * prompt via argv or stdin (`-p -`), 50k-char output truncation, a hard
 * timeout (spawn SIGTERM), explicit exit codes, and empty-output detection.
 *
 * The claude backend resolves `--provider <name>` from the cc-switch SQLite
 * DB (read-only) and never rewrites ~/.claude/settings.json — the provider
 * switch happens entirely through claude's own `--settings` merge.
 *
 * Timeout is enforced by spawn SIGTERM (deterministic), not via either
 * backend's own timeout flag.
 */

import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes
export const CHARACTER_LIMIT = 50_000;
const AGY_BIN = "agy";
const CLAUDE_BIN = "claude";
const VERSION_TIMEOUT_MS = 10_000;

/**
 * Path to the cc-switch SQLite database. cc-switch ships provider configs
 * (including ANTHROPIC_* env) here; gcli reads it read-only to resolve
 * `--provider <name>` for the claude backend.
 */
export const CC_SWITCH_DB_PATH = `${homedir()}/.cc-switch/cc-switch.db`;

/** Provider-name allowlist (C4b). Names outside this set are rejected. */
const PROVIDER_NAME_RE = /^[A-Za-z0-9 &._-]+$/;

// ---------------------------------------------------------------------------
// Types — DI contract (aligns with acceptance tests)
// ---------------------------------------------------------------------------

export type Subcommand = "agy" | "claude";

export type SubcommandResult =
  | { subcommand: Subcommand | undefined; rest: string[] }
  | { error: string };

/** Three-layer provider-name match outcome (C4). */
export type MatchOutcome =
  | { matched: string }
  | { none: true }
  | { ambiguous: string[] };

export type ProviderEnvResult =
  | { env: Record<string, string> }
  | { error: string };

/** A cc-switch provider row as exposed to the claude backend. */
export type RawProvider = { name: string; settingsConfig: unknown };

export type ProviderLookup =
  | { ok: true; providers: RawProvider[] }
  | {
      ok: false;
      kind: "db-missing" | "sqlite-missing" | "parse";
      message: string;
    };

/** Normalized spawn result shared by both backends (print mode). */
export type SpawnResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal?: string | null;
  timedOut?: boolean;
};

/** Spawn result for interactive mode: stdio inherited, nothing captured. */
export type InteractiveSpawnResult = {
  exitCode: number;
  signal?: string | null;
  spawnError?: string;
};

/** Injectable dependencies for `run()` — tests pass fakes (C1/C2 routing). */
export type RunDeps = {
  readCcSwitchProvider: () => Promise<ProviderLookup>;
  runClaude: (
    args: string[],
    timeoutMs?: number,
    cwd?: string,
  ) => Promise<SpawnResult>;
  runAgy: (
    args: string[],
    timeoutMs?: number,
    cwd?: string,
  ) => Promise<SpawnResult>;
  readStdin: () => Promise<string>;
  // Interactive mode (no -p in a TTY): inherit stdio, no timeout/truncation,
  // pass the child's exit code through unchanged.
  runClaudeInteractive: (
    args: string[],
    cwd?: string,
  ) => Promise<InteractiveSpawnResult>;
  runAgyInteractive: (
    args: string[],
    cwd?: string,
  ) => Promise<InteractiveSpawnResult>;
  isInteractive: () => boolean;
};

export type RunOutcome = { exitCode: number; stdout: string; stderr: string };

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

/**
 * Detect a leading `agy`/`claude` subcommand and strip it. Strict (C1):
 * - argv[0] === "agy"    → subcommand "agy",    rest = argv.slice(1)
 * - argv[0] === "claude" → subcommand "claude", rest = argv.slice(1)
 * - argv empty OR argv[0] starts with "-" → subcommand undefined (default agy)
 * - argv[0] any other non-empty token → error "unknown subcommand: <x>"
 *
 * This keeps `gcli -p claude` (argv[0]="-p") on the default agy path with
 * prompt="claude" — the subcommand must literally lead.
 */
export function parseSubcommand(argv: string[]): SubcommandResult {
  if (argv.length === 0) return { subcommand: undefined, rest: argv };
  const first = argv[0];
  if (first === "agy") return { subcommand: "agy", rest: argv.slice(1) };
  if (first === "claude") return { subcommand: "claude", rest: argv.slice(1) };
  if (first.startsWith("-")) return { subcommand: undefined, rest: argv };
  return { error: `unknown subcommand: ${first}` };
}

export function truncate(text: string): string {
  if (text.length <= CHARACTER_LIMIT) return text;
  return (
    text.slice(0, CHARACTER_LIMIT) +
    `\n\n[Truncated — response exceeded ${CHARACTER_LIMIT} characters]`
  );
}

export interface GcliOptions {
  /** Omit for interactive mode (no -p emitted). */
  prompt?: string;
  model?: string;
  yolo: boolean;
  sandbox: boolean;
  cwd?: string;
  timeoutMs: number;
  /** Args forwarded to the backend verbatim (from `--`). */
  passthrough?: string[];
}

/** Translate gcli options into agy argv. Timeout is enforced by spawn kill.
 * prompt is optional — when undefined, no -p is emitted (interactive mode). */
export function buildAgyArgs(opts: GcliOptions): string[] {
  const args: string[] = [];
  if (opts.model) args.push("--model", opts.model);
  if (opts.yolo) args.push("--dangerously-skip-permissions");
  if (opts.sandbox) args.push("--sandbox");
  if (opts.cwd) args.push("--add-dir", resolve(opts.cwd));
  if (opts.prompt !== undefined) args.push("-p", opts.prompt);
  if (opts.passthrough?.length) args.push(...opts.passthrough);
  return args;
}

// ---------------------------------------------------------------------------
// Claude backend pure helpers
// ---------------------------------------------------------------------------

/**
 * Three-layer provider name matching (C4a):
 * 1. exact equality
 * 2. case-insensitive equality
 * 3. substring (query within name, case-insensitive)
 * Within the first layer that produces any hit: 1 → {matched}, >1 →
 * {ambiguous}, 0 → fall through. No layer hits → {none}.
 */
export function matchProviderName(
  query: string,
  names: string[],
): MatchOutcome {
  const layers = [
    names.filter((n) => n === query),
    names.filter((n) => n.toLowerCase() === query.toLowerCase()),
    names.filter((n) => n.toLowerCase().includes(query.toLowerCase())),
  ];
  for (const layer of layers) {
    if (layer.length === 0) continue;
    if (layer.length === 1) return { matched: layer[0] };
    return { ambiguous: layer };
  }
  return { none: true };
}

/**
 * Parse a `settings_config` JSON string and return its `env` block (C4c).
 * Errors (with diagnostics) on malformed JSON, non-object root, or a
 * missing/non-object env.
 */
export function extractProviderEnv(
  settingsConfigJson: string,
): ProviderEnvResult {
  let cfg: unknown;
  try {
    cfg = JSON.parse(settingsConfigJson);
  } catch {
    return { error: "malformed settings_config JSON" };
  }
  if (typeof cfg !== "object" || cfg === null || Array.isArray(cfg)) {
    return { error: "settings_config is not a JSON object" };
  }
  const env = (cfg as Record<string, unknown>).env;
  if (
    env === undefined ||
    env === null ||
    typeof env !== "object" ||
    Array.isArray(env)
  ) {
    return { error: "settings_config has no env block" };
  }
  return { env: env as Record<string, string> };
}

/**
 * Copy provider env and explicitly pin `ANTHROPIC_MODEL` (C5).
 *
 * Why: `claude --settings` is a *merge*, not replace — a stale
 * ANTHROPIC_MODEL in the global settings.json would leak through. We always
 * set the key (empty string when nothing is derivable — JSON.stringify omits
 * undefined, which would let a stale global value leak back in).
 *
 * Priority: model > provider ANTHROPIC_MODEL > DEFAULT_SONNET_MODEL
 * > DEFAULT_OPUS_MODEL > first sorted DEFAULT_*_MODEL.
 */
export function buildSettingsEnv(
  providerEnv: Record<string, string>,
  model?: string,
): Record<string, string> {
  const env: Record<string, string> = { ...providerEnv };
  const firstDefault = Object.keys(env)
    .filter((k) => k.startsWith("ANTHROPIC_DEFAULT_") && k.endsWith("_MODEL"))
    .sort()[0];
  const resolved =
    model ??
    env.ANTHROPIC_MODEL ??
    env.ANTHROPIC_DEFAULT_SONNET_MODEL ??
    env.ANTHROPIC_DEFAULT_OPUS_MODEL ??
    (firstDefault !== undefined ? env[firstDefault] : undefined);
  env.ANTHROPIC_MODEL = (resolved ?? "") as string;
  return env;
}

export interface ClaudeOptions {
  /** Omit for interactive mode (no -p emitted). */
  prompt?: string;
  /** If provided, the env is wrapped as `--settings '{"env":{...}}'`. */
  settingsEnv?: Record<string, string>;
  cwd?: string;
  /** Args forwarded to the backend verbatim (from `--`). */
  passthrough?: string[];
}

/**
 * Build claude argv (C8). `--model` is NOT passed here — for the claude
 * backend it goes into the settings env's ANTHROPIC_MODEL via buildSettingsEnv.
 * `--cwd` becomes `claude --add-dir` to match the agy convention.
 * prompt is optional — when undefined, no -p is emitted (interactive mode).
 */
export function buildClaudeArgs(opts: ClaudeOptions): string[] {
  const args: string[] = [];
  if (opts.prompt !== undefined) args.push("-p", opts.prompt);
  if (opts.settingsEnv) {
    args.push("--settings", JSON.stringify({ env: opts.settingsEnv }));
  }
  if (opts.cwd) {
    args.push("--add-dir", resolve(opts.cwd));
  }
  if (opts.passthrough?.length) args.push(...opts.passthrough);
  return args;
}

// ---------------------------------------------------------------------------
// argv parsing
// ---------------------------------------------------------------------------

export interface ParsedArgs {
  prompt?: string;
  model?: string;
  yolo: boolean;
  sandbox: boolean;
  cwd?: string;
  timeoutMs: number;
  version: boolean;
  help: boolean;
  provider?: string;
  /** Args after `--`, passed through to the backend verbatim. */
  passthrough: string[];
}

export type ParseResult = ParsedArgs | { error: string };

function isOk(r: ParseResult): r is ParsedArgs {
  return !("error" in r);
}

/** gcli's own option names; anything else is forwarded to the backend. */
const KNOWN_OPTION_NAMES = new Set([
  "prompt",
  "p",
  "model",
  "yolo",
  "sandbox",
  "cwd",
  "timeout",
  "version",
  "help",
  "provider",
]);

export function parseCliArgs(argv: string[]): ParseResult {
  // `--` explicitly forwards everything after it. Unknown flags and bare
  // positionals before `--` are also auto-forwarded, so callers don't need to
  // remember `--` — only gcli's own flags above are consumed.
  const ddIdx = argv.indexOf("--");
  const before = ddIdx >= 0 ? argv.slice(0, ddIdx) : argv;
  const afterDd = ddIdx >= 0 ? argv.slice(ddIdx + 1) : [];

  try {
    const { values, tokens } = parseArgs({
      args: before,
      options: {
        prompt: { short: "p", type: "string" },
        model: { type: "string" },
        yolo: { type: "boolean" },
        sandbox: { type: "boolean" },
        cwd: { type: "string" },
        timeout: { type: "string" },
        version: { type: "boolean" },
        help: { type: "boolean" },
        provider: { type: "string" },
      },
      strict: false,
      tokens: true,
      allowNegative: true,
    });

    // Auto-forward unknown options and bare positionals to the backend.
    const passthrough: string[] = [];
    for (const t of tokens) {
      if (t.kind === "positional") {
        passthrough.push(t.value);
      } else if (t.kind === "option" && !KNOWN_OPTION_NAMES.has(t.name)) {
        if (t.inlineValue && t.value !== undefined) {
          passthrough.push(`${t.rawName}=${t.value}`);
        } else {
          passthrough.push(t.rawName);
        }
      }
    }
    passthrough.push(...afterDd);

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
      prompt: typeof values.prompt === "string" ? values.prompt : undefined,
      model: typeof values.model === "string" ? values.model : undefined,
      yolo: values.yolo === true,
      sandbox: values.sandbox === true,
      cwd: typeof values.cwd === "string" ? values.cwd : undefined,
      timeoutMs,
      version: values.version === true,
      help: values.help === true,
      provider:
        typeof values.provider === "string" ? values.provider : undefined,
      passthrough,
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// Spawn
// ---------------------------------------------------------------------------

export function runAgy(
  args: string[],
  timeoutMs: number,
  cwd?: string,
): Promise<SpawnResult> {
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
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolveFn({
        stdout,
        stderr,
        exitCode: code,
        signal: signal ?? null,
        timedOut,
      });
    });
  });
}

/**
 * Spawn the claude CLI with the same IO/timeout contract as `runAgy` (C6/C9).
 * stdin is inherited so a piped prompt reaches claude when gcli passes `-p -`
 * through. SIGTERM enforces the timeout deterministically.
 */
export function runClaude(
  args: string[],
  timeoutMs: number,
  cwd?: string,
): Promise<SpawnResult> {
  return new Promise((resolveFn) => {
    const child = spawn(CLAUDE_BIN, args, {
      cwd,
      env: { ...process.env },
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
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolveFn({
        stdout,
        stderr,
        exitCode: code,
        signal: signal ?? null,
        timedOut,
      });
    });
  });
}

/**
 * Spawn a backend with stdio fully inherited (interactive TUI mode).
 *
 * Unlike runAgy/runClaude: no timeout, no stdout/stderr capture, no
 * truncation — the child owns the terminal. The child's exit code is passed
 * through unchanged (SIGINT→130, SIGTERM→143 per shell convention).
 */
function spawnInteractive(
  bin: string,
  args: string[],
  cwd?: string,
): Promise<InteractiveSpawnResult> {
  return new Promise((resolveFn) => {
    const child = spawn(bin, args, {
      cwd,
      env: { ...process.env },
      stdio: "inherit",
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      resolveFn({
        exitCode: 1,
        spawnError:
          err.code === "ENOENT"
            ? `${bin} binary not found on PATH`
            : `failed to spawn ${bin}: ${err.message}`,
      });
    });
    child.on("close", (code, signal) => {
      const exitCode = code ?? (signal ? 128 + signoFromSignal(signal) : 1);
      resolveFn({ exitCode, signal: signal ?? null });
    });
  });
}

/** Map a signal name to its conventional shell exit code (128 + signo). */
function signoFromSignal(signal: string): number {
  const map: Record<string, number> = {
    SIGHUP: 1,
    SIGINT: 2,
    SIGQUIT: 3,
    SIGABRT: 6,
    SIGKILL: 9,
    SIGTERM: 15,
  };
  return map[signal] ?? 2; // default to INT (130) for unknown signals
}

/** Spawn agy in interactive TUI mode (no -p, inherited stdio). */
export function runAgyInteractive(
  args: string[],
  cwd?: string,
): Promise<InteractiveSpawnResult> {
  return spawnInteractive(AGY_BIN, args, cwd);
}

/** Spawn claude in interactive TUI mode (no -p, inherited stdio). */
export function runClaudeInteractive(
  args: string[],
  cwd?: string,
): Promise<InteractiveSpawnResult> {
  return spawnInteractive(CLAUDE_BIN, args, cwd);
}

// ---------------------------------------------------------------------------
// cc-switch provider lookup
// ---------------------------------------------------------------------------

/**
 * Read all `app_type='claude'` providers from cc-switch.db (C4b/C4c).
 *
 * Uses `sqlite3 -readonly -json` (never opens the DB for write). Matching
 * stays in the pure `matchProviderName` so it is unit-testable without a DB.
 *
 * Errors are classified for the caller: sqlite-missing (binary not on PATH),
 * db-missing (sqlite3 exited non-zero, e.g. file absent), parse (bad JSON).
 */
export function readCcSwitchProvider(dbPath: string): Promise<ProviderLookup> {
  return new Promise((resolve) => {
    const sql =
      "SELECT name, settings_config FROM providers WHERE app_type='claude'";
    const child = spawn("sqlite3", ["-readonly", "-json", dbPath, sql], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      resolve({
        ok: false,
        kind: "sqlite-missing",
        message:
          err.code === "ENOENT"
            ? "sqlite3 binary not found on PATH"
            : `sqlite3 failed to spawn: ${err.message}`,
      });
    });

    child.on("close", (code) => {
      if (code !== 0) {
        const msg = stderr.trim();
        resolve({
          ok: false,
          kind: "db-missing",
          message: msg
            ? `cc-switch db error: ${msg}`
            : `cc-switch db error: sqlite3 exited with code ${code}`,
        });
        return;
      }
      const trimmed = stdout.trim();
      if (!trimmed) {
        resolve({ ok: true, providers: [] });
        return;
      }
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (!Array.isArray(parsed)) {
          resolve({
            ok: false,
            kind: "parse",
            message: "sqlite3 returned non-array JSON",
          });
          return;
        }
        // cc-switch stores settings_config as a JSON string; expose it as
        // settingsConfig for the caller (extractProviderEnv parses it).
        const providers: RawProvider[] = (
          parsed as Array<{ name: string; settings_config: string }>
        ).map((r) => ({
          name: r.name,
          settingsConfig: r.settings_config,
        }));
        resolve({ ok: true, providers });
      } catch (err) {
        resolve({
          ok: false,
          kind: "parse",
          message: `sqlite3 returned malformed JSON: ${
            err instanceof Error ? err.message : String(err)
          }`,
        });
      }
    });
  });
}

/**
 * Validate a provider name against the allowlist (C4b). Returns the name, or
 * an error object suitable for an exit-2 stderr line.
 */
export function validateProviderName(name: string): string | { error: string } {
  if (!PROVIDER_NAME_RE.test(name)) {
    return {
      error: `invalid provider name: "${name}" (allowed: letters, digits, space, &._-)`,
    };
  }
  return name;
}

// ---------------------------------------------------------------------------
// stdin
// ---------------------------------------------------------------------------

/**
 * Read all of stdin as a UTF-8 string.
 *
 * Both backends have a `-p -` blind spot (they take the literal "-"), so gcli
 * drains stdin itself and passes the content as an explicit `-p <text>` argv.
 * Resolves to "" on a TTY (nothing piped).
 */
function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve("");
      return;
    }
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const HELP = `Usage:
  gcli [agy] [options] [-- <args>]   wrap the agy CLI (default backend)
  gcli claude [options] [-- <args>]  wrap the claude CLI via cc-switch providers

gcli sits in front of two backends and gives skills a stable entry point:
50k-char output truncation, a hard timeout (spawn SIGTERM), explicit exit
codes, and stdin piping (\`-p -\`).

Without -p, gcli launches the backend's interactive TUI (inherited stdio;
no timeout, no truncation; the child's exit code is passed through). This
requires a TTY — piping into gcli without -p is an error (use '-p -' to
pipe a prompt).

Unknown flags and bare args are forwarded to the backend verbatim, so you can
use any native flag — e.g. \`gcli claude --dangerously-skip-permissions\` for
bypass mode. \`--\` forwards everything after it unconditionally.

agy backend (default; also reachable as \`gcli agy ...\`):
  -p, --prompt <text|->   Prompt text, "-" for stdin; omit for interactive TUI
      --model <name>      agy model (e.g. gemini-2.5-pro)
      --yolo              Auto-approve tool actions (agy --dangerously-skip-permissions)
      --sandbox           Run agy in sandbox mode
      --cwd <dir>         Working directory (added via agy --add-dir)
      --timeout <ms>      Hard timeout in ms (default 300000, max 600000)
      --version           Print the agy version
      --help              Show this help
      -- <args...>        Pass remaining args through to agy verbatim

claude backend (\`gcli claude ...\`):
  -p, --prompt <text|->   Prompt text, "-" for stdin; omit for interactive TUI
      --provider <name>   cc-switch provider (matched by exact/case/substring)
      --model <name>      Override ANTHROPIC_MODEL in the provider env
      --cwd <dir>         Working directory (added via claude --add-dir)
      --timeout <ms>      Hard timeout in ms (default 300000, max 600000)
      --version           Print the claude version
      --help              Show this help
      -- <args...>        Pass remaining args through to claude verbatim

  Notes:
    - --provider switches via \`claude -p ... --settings {'env':{...}}\`; it
      does NOT rewrite ~/.claude/settings.json.
    - --yolo/--sandbox are rejected on the claude backend.
    - --provider passes the provider token via claude's argv (visible in 'ps');
      cc-switch's mechanism offers no sealed alternative.

Exit codes: 0 success | 1 backend error / timeout / empty output | 2 bad args
         | N (interactive mode: child's exit code passed through unchanged)`;

/** Map a backend spawn result to a gcli exit outcome (C2). */
function mapSpawnResult(
  result: SpawnResult,
  backend: "agy" | "claude",
  timeoutMs: number,
): RunOutcome {
  if (result.timedOut) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `gcli: timed out after ${timeoutMs}ms`,
    };
  }
  const out = result.stdout.trim();
  if (result.exitCode !== 0) {
    const errInfo =
      result.stderr.trim() ||
      out ||
      `${backend} exited with code ${result.exitCode}`;
    return {
      exitCode: 1,
      stdout: "",
      stderr: `gcli: ${backend} failed (exit ${result.exitCode})\n${truncate(
        errInfo,
      )}`,
    };
  }
  if (!out) {
    const info = result.stderr.trim()
      ? `stderr: ${truncate(result.stderr)}`
      : "no output";
    return {
      exitCode: 1,
      stdout: "",
      stderr: `gcli: ${backend} returned ${info}`,
    };
  }
  return { exitCode: 0, stdout: truncate(out), stderr: "" };
}

async function runAgyBackend(
  parsed: ParsedArgs,
  deps: RunDeps,
): Promise<RunOutcome> {
  if (parsed.version) {
    const r = await deps.runAgy(["--version"], VERSION_TIMEOUT_MS);
    const out = (r.stdout || r.stderr).trim();
    return {
      exitCode: r.exitCode === 0 ? 0 : 1,
      stdout: out,
      stderr: r.exitCode === 0 ? "" : "gcli: agy --version failed",
    };
  }

  // TTY guard: no -p in a non-TTY (pipe/CI) is an error; in a TTY it
  // launches the backend's interactive TUI.
  if (parsed.prompt === undefined && !deps.isInteractive()) {
    return {
      exitCode: 2,
      stdout: "",
      stderr:
        "gcli: -p/--prompt is required (run in a TTY for interactive mode, or use '-p -' for stdin)",
    };
  }

  let prompt = parsed.prompt;
  if (prompt === "-") {
    prompt = await deps.readStdin();
    if (!prompt.trim()) {
      return {
        exitCode: 2,
        stdout: "",
        stderr: "gcli: -p - given but stdin is empty (no prompt piped)",
      };
    }
  }

  const cwdAbs = parsed.cwd ? resolve(parsed.cwd) : undefined;

  // Interactive mode (no -p in a TTY): inherit stdio, pass exit code through.
  if (prompt === undefined) {
    const args = buildAgyArgs({
      model: parsed.model,
      yolo: parsed.yolo,
      sandbox: parsed.sandbox,
      cwd: parsed.cwd,
      timeoutMs: parsed.timeoutMs,
      passthrough: parsed.passthrough,
    });
    const r = await deps.runAgyInteractive(args, cwdAbs);
    return { exitCode: r.exitCode, stdout: "", stderr: r.spawnError ?? "" };
  }

  const opts: GcliOptions = {
    prompt,
    model: parsed.model,
    yolo: parsed.yolo,
    sandbox: parsed.sandbox,
    cwd: parsed.cwd,
    timeoutMs: parsed.timeoutMs,
    passthrough: parsed.passthrough,
  };
  const args = buildAgyArgs(opts);
  const result = await deps.runAgy(args, parsed.timeoutMs, cwdAbs);
  return mapSpawnResult(result, "agy", parsed.timeoutMs);
}

async function runClaudeBackend(
  parsed: ParsedArgs,
  deps: RunDeps,
): Promise<RunOutcome> {
  // C8: claude backend rejects agy-only flags.
  if (parsed.yolo || parsed.sandbox) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: "gcli: claude backend does not support --yolo/--sandbox",
    };
  }

  if (parsed.version) {
    const r = await deps.runClaude(["--version"], VERSION_TIMEOUT_MS);
    const out = (r.stdout || r.stderr).trim();
    return {
      exitCode: r.exitCode === 0 ? 0 : 1,
      stdout: out,
      stderr: r.exitCode === 0 ? "" : "gcli: claude --version failed",
    };
  }

  // TTY guard: no -p in a non-TTY is an error; in a TTY it launches claude's
  // interactive TUI (with provider injection honored).
  if (parsed.prompt === undefined && !deps.isInteractive()) {
    return {
      exitCode: 2,
      stdout: "",
      stderr:
        "gcli: -p/--prompt is required (run in a TTY for interactive mode, or use '-p -' for stdin)",
    };
  }

  let prompt = parsed.prompt;
  if (prompt === "-") {
    prompt = await deps.readStdin();
    if (!prompt.trim()) {
      return {
        exitCode: 2,
        stdout: "",
        stderr: "gcli: -p - given but stdin is empty (no prompt piped)",
      };
    }
  }

  let settingsEnv: Record<string, string> | undefined;
  if (parsed.provider !== undefined) {
    const validated = validateProviderName(parsed.provider);
    if (typeof validated !== "string") {
      return { exitCode: 2, stdout: "", stderr: `gcli: ${validated.error}` };
    }
    const lookup = await deps.readCcSwitchProvider();
    if (!lookup.ok) {
      return { exitCode: 1, stdout: "", stderr: `gcli: ${lookup.message}` };
    }
    const names = lookup.providers.map((p) => p.name);
    const match = matchProviderName(parsed.provider, names);
    if ("none" in match) {
      return {
        exitCode: 2,
        stdout: "",
        stderr: `gcli: provider not found: ${parsed.provider}`,
      };
    }
    if ("ambiguous" in match) {
      const candidates = match.ambiguous
        .map((n) => `"${n}"`)
        .sort()
        .join(", ");
      return {
        exitCode: 2,
        stdout: "",
        stderr: `gcli: ambiguous provider: ${candidates}`,
      };
    }
    const target = lookup.providers.find((p) => p.name === match.matched);
    if (target === undefined) {
      return {
        exitCode: 2,
        stdout: "",
        stderr: `gcli: provider not found: ${parsed.provider}`,
      };
    }
    // cc-switch stores settings_config as a JSON string; extractProviderEnv
    // parses it. Accept a pre-parsed object too (defensive).
    const cfgJson =
      typeof target.settingsConfig === "string"
        ? target.settingsConfig
        : JSON.stringify(target.settingsConfig);
    const envResult = extractProviderEnv(cfgJson);
    if ("error" in envResult) {
      return { exitCode: 1, stdout: "", stderr: `gcli: ${envResult.error}` };
    }
    settingsEnv = buildSettingsEnv(envResult.env, parsed.model);
  } else if (parsed.model !== undefined) {
    // No --provider: still honour --model by injecting a minimal env that
    // overrides ANTHROPIC_MODEL via --settings merge.
    settingsEnv = { ANTHROPIC_MODEL: parsed.model };
  }

  const cwdAbs = parsed.cwd ? resolve(parsed.cwd) : undefined;

  // Interactive mode (no -p in a TTY): inherit stdio, pass exit code through.
  if (prompt === undefined) {
    const args = buildClaudeArgs({
      settingsEnv,
      cwd: parsed.cwd,
      passthrough: parsed.passthrough,
    });
    const r = await deps.runClaudeInteractive(args, cwdAbs);
    return { exitCode: r.exitCode, stdout: "", stderr: r.spawnError ?? "" };
  }

  const args = buildClaudeArgs({
    prompt,
    settingsEnv,
    cwd: parsed.cwd,
    passthrough: parsed.passthrough,
  });
  const result = await deps.runClaude(args, parsed.timeoutMs, cwdAbs);
  return mapSpawnResult(result, "claude", parsed.timeoutMs);
}

/**
 * Route argv to the agy or claude backend via injectable deps (C1/C2).
 * Returns a {exitCode, stdout, stderr} outcome; main() owns process.exit.
 */
export async function run(argv: string[], deps: RunDeps): Promise<RunOutcome> {
  const sub = parseSubcommand(argv);
  if ("error" in sub) {
    return { exitCode: 2, stdout: "", stderr: `gcli: ${sub.error}` };
  }
  const parsed = parseCliArgs(sub.rest);
  if (!isOk(parsed)) {
    return { exitCode: 2, stdout: "", stderr: `gcli: ${parsed.error}` };
  }
  if (parsed.help) {
    return { exitCode: 0, stdout: HELP, stderr: "" };
  }
  return sub.subcommand === "claude"
    ? runClaudeBackend(parsed, deps)
    : runAgyBackend(parsed, deps);
}

async function main(): Promise<void> {
  const deps: RunDeps = {
    readCcSwitchProvider: () => readCcSwitchProvider(CC_SWITCH_DB_PATH),
    runClaude: (args, timeoutMs, cwd) =>
      runClaude(args, timeoutMs ?? DEFAULT_TIMEOUT_MS, cwd),
    runAgy: (args, timeoutMs, cwd) =>
      runAgy(args, timeoutMs ?? DEFAULT_TIMEOUT_MS, cwd),
    readStdin: () => readStdin(),
    runClaudeInteractive: (args, cwd) => runClaudeInteractive(args, cwd),
    runAgyInteractive: (args, cwd) => runAgyInteractive(args, cwd),
    isInteractive: () => process.stdin.isTTY === true,
  };
  const r = await run(process.argv.slice(2), deps);
  if (r.stdout) process.stdout.write(`${r.stdout}\n`);
  if (r.stderr) process.stderr.write(`${r.stderr}\n`);
  process.exit(r.exitCode);
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
