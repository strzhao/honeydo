#!/usr/bin/env node

/**
 * gcli — thin wrapper around the `agy` and `claude` CLI backends.
 *
 * Default backend is claude: bare `gcli ...` is exactly `gcli claude ...`.
 * `gcli agy ...` routes to the agy CLI (explicit subcommand required); the
 * claude backend can switch cc-switch providers inline via
 * `claude -p ... --settings`. Adds value over calling the backends directly:
 * prompt via argv or stdin (`-p -`), 50k-char output truncation, a hard
 * timeout (spawn SIGTERM), explicit exit codes, and empty-output detection.
 *
 * The claude backend resolves `--provider <name>` from the cc-switch SQLite
 * DB (read-only) and never rewrites ~/.claude/settings.json — the provider
 * switch happens entirely through claude's own `--settings` merge. In a TTY
 * without --provider it offers an interactive arrow-key picker over the
 * cc-switch provider list (↑↓/j/k move · Enter confirm · Esc keep default);
 * the last confirmed provider is remembered in ~/.config/gcli/last-provider
 * and reused silently in print mode. Without a TTY the picker never triggers
 * (zero prompts, zero DB reads, zero memory-file IO) so skills/CI never hang.
 *
 * Note: on the default (claude) path --yolo/--sandbox are rejected (exit 2);
 * agy users must opt in via the explicit `gcli agy` subcommand.
 *
 * Timeout is enforced by spawn SIGTERM (deterministic), not via either
 * backend's own timeout flag.
 */

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { emitKeypressEvents } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes
export const CHARACTER_LIMIT = 50_000;
export const API_DEFAULT_MAX_TOKENS = 80000;
const AGY_BIN = "agy";
const CLAUDE_BIN = "claude";
const VERSION_TIMEOUT_MS = 10_000;

/**
 * Path to the cc-switch SQLite database. cc-switch ships provider configs
 * (including ANTHROPIC_* env) here; gcli reads it read-only to resolve
 * `--provider <name>` for the claude backend.
 */
export const CC_SWITCH_DB_PATH = `${homedir()}/.cc-switch/cc-switch.db`;

/**
 * Memory file for the last picker-confirmed provider (D2). Content is a
 * single UTF-8 line with the provider name. Read on the TTY claude path with
 * no --provider (exact-name match against the current list; mismatch/missing/
 * unreadable → silently ignored); written best-effort after a picker confirm.
 * Never read or written on a non-TTY path (zero side effects for skills/CI).
 */
export const LAST_PROVIDER_PATH = `${homedir()}/.config/gcli/last-provider`;

/**
 * Quota subtitle cache (revise-3, C-Q5): `{[name]: {ts, ok, text?}}`.
 * TTL ok 60s / fail 15s (statusline-sage semantics); reads/writes are
 * best-effort — the quota subtitle is an optimization, never an error.
 */
export const QUOTA_CACHE_PATH = `${homedir()}/.config/gcli/quota-cache.json`;
const QUOTA_TTL_OK_MS = 60_000;
const QUOTA_TTL_FAIL_MS = 15_000;
const QUOTA_FETCH_TIMEOUT_MS = 2_500;

/** Provider-name allowlist (C4b). Names outside this set are rejected. */
const PROVIDER_NAME_RE = /^[A-Za-z0-9 &._-]+$/;

// ---------------------------------------------------------------------------
// Types — DI contract (aligns with acceptance tests)
// ---------------------------------------------------------------------------

export type Subcommand = "agy" | "claude" | "api";

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

/** One picker keypress → state transition (C-P2). */
export type PickerKeyAction =
  | { type: "move"; index: number }
  | { type: "confirm" }
  | { type: "skip" }
  | { type: "noop" };

/** One selectable row of the arrow-key picker: a cc-switch provider. */
export type PickerEntry = { name: string; quota?: string };

/** Result of the arrow-key picker (C-P1): a picked provider, or a skip. */
export type PickerOutcome =
  | { kind: "select"; entry: PickerEntry }
  | { kind: "skip" };

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
  /**
   * api backend: POST to an anthropic-compatible /v1/messages endpoint.
   * Implementations handle fetch + SSE parsing + idle/absolute timeout and
   * return a normalized RunOutcome (0 success / 1 error·timeout·empty).
   * Injected so acceptance tests never hit a real API.
   */
  runApi: (req: ApiRequest) => Promise<RunOutcome>;
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
  /**
   * TTY-only arrow-key provider picker (C-P1/C-P3): present the cc-switch
   * provider entries (the production impl appends its own trailing 不切换
   * row — `entries` holds providers only) and resolve the confirmed entry,
   * or {kind:"skip"} on Esc / the 不切换 row. `initialIndex` is the caller-
   * computed row to highlight (memory hit or 0); implementations clamp it.
   * Only ever invoked on the claude path in a TTY with no --provider —
   * non-interactive callers (skills/CI/pipes) must see zero prompts and
   * zero extra cc-switch DB reads.
   */
  pickProvider: (
    entries: PickerEntry[],
    initialIndex: number,
  ) => Promise<PickerOutcome>;
  /**
   * Quota subtitles (revise-3, C-Q4): given every menu provider's {name, env},
   * resolve name → formatted quota text (only providers with usable data are
   * in the Map). Only invoked on the TTY menu path right before pickProvider —
   * silent reuse / explicit --provider / non-TTY / degraded paths never call.
   */
  fetchProviderQuotas: (
    items: {
      name: string;
      env: Record<string, string>;
    }[],
  ) => Promise<Map<string, string>>;
  /**
   * Read the remembered provider name (D2): trimmed first line of
   * LAST_PROVIDER_PATH, or undefined when missing/empty/unreadable. Only
   * invoked on the TTY claude path with no --provider.
   */
  readLastProvider: () => Promise<string | undefined>;
  /**
   * Persist the picker-confirmed provider name (D2). Best-effort: failures
   * are swallowed (memory is an optimization, never an error). Only invoked
   * after an arrow-key picker confirm, before any backend spawn.
   */
  writeLastProvider: (name: string) => Promise<void>;
};

export type RunOutcome = { exitCode: number; stdout: string; stderr: string };

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

/**
 * Detect a leading `agy`/`claude`/`api` subcommand and strip it. Strict (C1):
 * - argv[0] === "agy"    → subcommand "agy",    rest = argv.slice(1)
 * - argv[0] === "claude" → subcommand "claude", rest = argv.slice(1)
 * - argv[0] === "api"    → subcommand "api",    rest = argv.slice(1)
 * - argv empty OR argv[0] starts with "-" → subcommand undefined (default
 *   backend: claude)
 * - argv[0] any other non-empty token → error "unknown subcommand: <x>"
 *
 * This keeps `gcli -p claude` (argv[0]="-p") on the default claude path with
 * prompt="claude" — the subcommand must literally lead.
 */
export function parseSubcommand(argv: string[]): SubcommandResult {
  if (argv.length === 0) return { subcommand: undefined, rest: argv };
  const first = argv[0];
  if (first === "agy") return { subcommand: "agy", rest: argv.slice(1) };
  if (first === "claude") return { subcommand: "claude", rest: argv.slice(1) };
  if (first === "api") return { subcommand: "api", rest: argv.slice(1) };
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

/**
 * Shape of a readline keypress event's `key` argument (C-P2, revise-2).
 */
export type PickerKeyInput = { name?: string; ctrl?: boolean; meta?: boolean };

/**
 * Map one arrow-key picker keypress to its state transition (C-P2, revise-2).
 *
 * `k` is the keypress event's `key` object:
 * - "up" / "k"   → move up one row, wrapping past the top (环形)
 * - "down" / "j" → move down one row, wrapping past the bottom (环形)
 * - "return" / "enter" → confirm the current row (the physical Enter key
 *   emits "return" in raw mode; "enter" is the LF byte, which a tty may
 *   substitute for CR in input buffered before raw mode was enabled)
 * - "escape"     → skip (不切换)
 * - Emacs (revise-2): ctrl+"n" ≡ down, ctrl+"p" ≡ up (same wrap); ctrl+"g"
 *   ≡ escape → skip; meta+"<" → first row (absolute), meta+">" → last row
 *   (absolute). Horizontal Emacs keys (C-f/C-b/C-a/C-e) and paging (C-v/M-v)
 *   are deliberately NOT mapped — meaningless in a vertical menu.
 * - anything else → noop (ctrl-c is handled by the caller: restore raw-mode,
 *   exit 130)
 *
 * `index` is the highlighted row, `count` the total rendered rows INCLUDING
 * the trailing 不切换 row. Movement wraps with `(index±1+count)%count`; with
 * count <= 0 moves are a noop (nothing is rendered).
 */
export function applyPickerKey(
  k: PickerKeyInput,
  index: number,
  count: number,
): PickerKeyAction {
  const name = k.name;
  if (name === undefined) return { type: "noop" };
  if (k.ctrl === true) {
    // Emacs cluster (revise-2): C-n/C-p move, C-g skips; other C-x noop.
    if (name === "n") {
      if (count <= 0) return { type: "noop" };
      return { type: "move", index: (index + 1) % count };
    }
    if (name === "p") {
      if (count <= 0) return { type: "noop" };
      return { type: "move", index: (index - 1 + count) % count };
    }
    if (name === "g") return { type: "skip" };
    return { type: "noop" };
  }
  if (k.meta === true) {
    // M-< / M-> jump to the first/last row (absolute, no wrap).
    if (name === "<" && count > 0) return { type: "move", index: 0 };
    if (name === ">" && count > 0) return { type: "move", index: count - 1 };
    return { type: "noop" };
  }
  if (name === "up" || name === "k") {
    if (count <= 0) return { type: "noop" };
    return { type: "move", index: (index - 1 + count) % count };
  }
  if (name === "down" || name === "j") {
    if (count <= 0) return { type: "noop" };
    return { type: "move", index: (index + 1) % count };
  }
  if (name === "return" || name === "enter") return { type: "confirm" };
  if (name === "escape") return { type: "skip" };
  return { type: "noop" };
}

// ---------------------------------------------------------------------------
// Quota subtitle pure helpers (revise-3, C-Q1..C-Q3) — protocol knowledge
// reused from martin/statusline-sage (kimi /coding/v1/usages, glm
// /api/monitor/usage/quota/limit); rewritten zero-dep for gcli.
// ---------------------------------------------------------------------------

/** One rate-limit window: usage percentage + ISO8601 reset timestamp. */
export type QuotaWindow = { pct: number; resetIso: string };

/** Parsed quota windows: short = 5h rolling, weekly = long window. */
export type QuotaWindows = { short?: QuotaWindow; weekly?: QuotaWindow };

/**
 * Map a provider env to its quota API request (C-Q1):
 * - base contains kimi.com / moonshot → kimi: `{domain}/coding/v1/usages`,
 *   `Authorization: Bearer <token>` (bare token gets 401)
 * - base contains bigmodel / z.ai → glm: `{domain}/api/monitor/usage/quota/limit`,
 *   `Authorization: <token>` (NO Bearer prefix)
 * - anything else (deepseek / packy / anthropic official / …) or missing
 *   base/token/scheme → null: no quota API, zero requests, no subtitle.
 */
export function buildQuotaRequest(env: {
  ANTHROPIC_BASE_URL?: string;
  ANTHROPIC_AUTH_TOKEN?: string;
}): { kind: "kimi" | "glm"; url: string; authHeader: string } | null {
  const base = env.ANTHROPIC_BASE_URL;
  const token = env.ANTHROPIC_AUTH_TOKEN;
  if (typeof base !== "string" || base === "") return null;
  if (typeof token !== "string" || token === "") return null;
  const m = /^https?:\/\/[^/]+/.exec(base);
  if (m === null) return null;
  const domain = m[0];
  if (base.includes("kimi.com") || base.includes("moonshot")) {
    return {
      kind: "kimi",
      url: `${domain}/coding/v1/usages`,
      authHeader: `Bearer ${token}`,
    };
  }
  if (base.includes("bigmodel") || base.includes("z.ai")) {
    return {
      kind: "glm",
      url: `${domain}/api/monitor/usage/quota/limit`,
      authHeader: token,
    };
  }
  return null;
}

/** Coerce a kimi/glm numeric field (they arrive as JSON strings) safely. */
function toNum(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Normalize a reset timestamp to an ISO string (runtime-verified: kimi's
 * resetTime is ISO8601, but GLM's nextResetTime is an epoch-ms NUMBER —
 * statusline-sage never parses dates so this was only discoverable live).
 * Accepts string (ISO) or finite positive number (epoch ms); else undefined.
 */
function toResetIso(v: unknown): string | undefined {
  if (typeof v === "string" && v !== "") return v;
  if (typeof v === "number" && Number.isFinite(v) && v > 0) {
    const iso = new Date(v).toISOString();
    return iso;
  }
  return undefined;
}

/**
 * One kimi-style usage window (C-Q2): used/limit are strings; used may be
 * absent → limit − remaining; any malformed piece drops the whole window
 * (never throws). pct = floor(used/limit*100).
 */
function kimiWindowOf(detail: unknown): QuotaWindow | undefined {
  if (typeof detail !== "object" || detail === null) return undefined;
  const d = detail as Record<string, unknown>;
  const limit = toNum(d.limit);
  let used = toNum(d.used);
  if (used === undefined) {
    const remaining = toNum(d.remaining);
    if (limit !== undefined && remaining !== undefined)
      used = limit - remaining;
  }
  if (limit === undefined || used === undefined || limit <= 0) return undefined;
  const resetIso = toResetIso(d.resetTime);
  if (resetIso === undefined) return undefined;
  return { pct: Math.floor((used / limit) * 100), resetIso };
}

/**
 * Parse kimi `/coding/v1/usages` (C-Q2): `limits[]` entries with
 * window.duration == 300 + MINUTE → short (5h) window; top-level `usage` →
 * weekly. Malformed shapes yield missing windows, never throw.
 */
export function parseKimiUsages(body: unknown): QuotaWindows {
  const out: QuotaWindows = {};
  if (typeof body !== "object" || body === null) return out;
  const b = body as Record<string, unknown>;
  const limits = Array.isArray(b.limits) ? b.limits : [];
  for (const item of limits) {
    if (typeof item !== "object" || item === null) continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.window !== "object" || rec.window === null) continue;
    const w = rec.window as Record<string, unknown>;
    if (toNum(w.duration) !== 300) continue;
    const unit = typeof w.timeUnit === "string" ? w.timeUnit : "";
    if (!unit.includes("MINUTE")) continue;
    const win = kimiWindowOf(rec.detail);
    if (win !== undefined) out.short = win;
  }
  const weekly = kimiWindowOf(b.usage);
  if (weekly !== undefined) out.weekly = weekly;
  return out;
}

/**
 * Parse GLM `/api/monitor/usage/quota/limit` (C-Q2): data.limits[] entries
 * with type == "TOKENS_LIMIT"; sorted by nextResetTime ascending — first is
 * the short (5h) window, last the weekly one.
 */
export function parseGlmQuota(body: unknown): QuotaWindows {
  const out: QuotaWindows = {};
  if (typeof body !== "object" || body === null) return out;
  const data = (body as Record<string, unknown>).data;
  if (typeof data !== "object" || data === null) return out;
  const limitsRaw = (data as Record<string, unknown>).limits;
  const limits = Array.isArray(limitsRaw) ? limitsRaw : [];
  const wins: QuotaWindow[] = [];
  for (const item of limits) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    if (r.type !== "TOKENS_LIMIT") continue;
    const pct = toNum(r.percentage);
    if (pct === undefined) continue;
    const resetIso = toResetIso(r.nextResetTime);
    if (resetIso === undefined) continue;
    wins.push({ pct: Math.floor(pct), resetIso });
  }
  wins.sort((a, b) =>
    a.resetIso < b.resetIso ? -1 : a.resetIso > b.resetIso ? 1 : 0,
  );
  if (wins.length > 0) out.short = wins[0];
  if (wins.length > 1) out.weekly = wins[wins.length - 1];
  return out;
}

/** Render a reset timestamp as a short relative duration (C-Q3). */
function formatReset(
  iso: string | undefined,
  nowMs: number,
): string | undefined {
  if (iso === undefined) return undefined;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return undefined;
  const min = Math.floor((t - nowMs) / 60_000);
  if (min < 1) return undefined; // already reset / about to — omit
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const rm = min % 60;
  if (h < 24) return rm > 0 ? `${h}h${rm}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh > 0 ? `${d}d${rh}h` : `${d}d`;
}

/**
 * Format quota windows as the menu subtitle (C-Q3): `5h:P% wk:P% ↻<rel>`
 * (short reset preferred for the ↻ segment); missing windows degrade; a
 * missing/expired reset omits the ↻ segment entirely; no windows → "".
 */
export function formatQuota(q: QuotaWindows, nowMs: number): string {
  const parts: string[] = [];
  if (q.short !== undefined) parts.push(`5h:${q.short.pct}%`);
  if (q.weekly !== undefined) parts.push(`wk:${q.weekly.pct}%`);
  if (parts.length === 0) return "";
  const rel = formatReset(q.short?.resetIso ?? q.weekly?.resetIso, nowMs);
  return rel === undefined ? parts.join(" ") : `${parts.join(" ")} ↻${rel}`;
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
// api backend pure helpers (HTTP to an anthropic-compatible messages API)
// ---------------------------------------------------------------------------

/**
 * Injectable api request (the shape deps.runApi consumes). All fields the
 * production fetch impl needs, with nothing backend-specific leaking into the
 * pure layer.
 */
export interface ApiRequest {
  url: string;
  token: string;
  model: string;
  maxTokens: number;
  prompt: string;
  stream: boolean;
  timeoutMs: number;
}

/**
 * Build the HTTP body for an anthropic-compatible /v1/messages request.
 *
 * thinking is intentionally NOT disabled: k3's extended thinking is the quality
 * source for creative+SVG tasks (dry-run: single-block ~768-char thinking yields
 * high-quality output in ~45s vs claude-agent's 53min). We rely on a sufficient
 * --max-tokens budget (default 80000) to cover both thinking and text, not on
 * disabling thinking. Disabling it would discard the very capability we chose
 * k3 for.
 */
export function buildApiBody(
  req: Pick<ApiRequest, "model" | "maxTokens" | "prompt" | "stream">,
): Record<string, unknown> {
  return {
    model: req.model,
    max_tokens: req.maxTokens,
    stream: req.stream,
    messages: [{ role: "user", content: req.prompt }],
  };
}

/**
 * Build the full URL for the messages endpoint. The cc-switch base_url is
 * stored with a trailing slash (e.g. `https://api.kimi.com/coding/`); we
 * append `v1/messages` without doubling the slash.
 */
export function buildApiEndpoint(baseUrl: string): string {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return `${base}v1/messages`;
}

/**
 * SSE line → extracted text delta, or null if the line carries no text payload.
 *
 * Handles anthropic-compatible streaming events:
 * - `data:{...}` JSON with `delta.type === "text_delta"` → the text fragment
 * - `thinking_delta` / `signature_delta` / control events → null (ignored)
 * - non-`data:` lines / malformed JSON → null
 *
 * The `data:` prefix is matched greedily and the remainder is trimmed, so both
 * `data:{...}` (kimi, no space) and `data: {...}` (with space) parse the same.
 */
export function extractTextDelta(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return null;
  const payload = trimmed.slice("data:".length).trim();
  if (!payload || payload === "[DONE]") return null;
  try {
    const evt = JSON.parse(payload) as {
      type?: string;
      delta?: { type?: string; text?: string };
    };
    if (
      evt.type === "content_block_delta" &&
      evt.delta?.type === "text_delta" &&
      typeof evt.delta.text === "string"
    ) {
      return evt.delta.text;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Aggregate text from a non-streaming messages response body.
 *
 * Non-stream responses look like `{ content: [{ type: "text", text: "..." }] }`;
 * we concatenate every text block in order.
 */
export function extractNonStreamText(body: unknown): string {
  if (typeof body !== "object" || body === null) return "";
  const content = (body as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const block of content) {
    if (
      typeof block === "object" &&
      block !== null &&
      (block as { type?: string }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      out += (block as { text: string }).text;
    }
  }
  return out;
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
  /** Force the provider picker menu, even in print mode (claude path only). */
  pick: boolean;
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
  "pick",
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
        pick: { type: "boolean" },
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
      if (!Number.isFinite(n) || n < 1000 || n > 1_800_000) {
        return {
          error: `--timeout must be a number in [1000, 1800000], got "${values.timeout}"`,
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
      pick: values.pick === true,
      passthrough,
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// api backend argv parsing — STRICT (unknown flags are errors, not forwarded)
// ---------------------------------------------------------------------------

/**
 * Parsed options for the api backend. Unlike agy/claude there is no
 * `passthrough`: the api backend builds an HTTP body directly, so unknown
 * flags have no target to forward to and are rejected (exit 2).
 */
export interface ParsedApiArgs {
  prompt?: string;
  model?: string;
  provider?: string;
  maxTokens: number;
  timeoutMs: number;
  stream: boolean;
  version: boolean;
  help: boolean;
  /** --cwd was supplied (warned + ignored by the api backend). */
  cwd?: string;
}

export type ParseApiResult = ParsedApiArgs | { error: string };

/**
 * Parse argv for the api backend. Strict (contract: api does NOT passthrough):
 * unknown flags and bare positionals are errors (`unknown option/positional`),
 * mapped to exit 2 by the caller. `--no-stream` is accepted via
 * `allowNegative` and flips `stream` to false.
 */
export function parseApiArgs(argv: string[]): ParseApiResult {
  // Agent-only flags get a precise rejection (not the generic "Unknown
  // option") so callers know the api backend refuses them on purpose.
  if (argv.includes("--yolo")) {
    return {
      error:
        "api backend does not support --yolo (agent flag; api has no agent)",
    };
  }
  if (argv.includes("--sandbox")) {
    return {
      error:
        "api backend does not support --sandbox (agent flag; api has no agent)",
    };
  }
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        prompt: { short: "p", type: "string" },
        model: { type: "string" },
        provider: { type: "string" },
        "max-tokens": { type: "string" },
        timeout: { type: "string" },
        stream: { type: "boolean" },
        version: { type: "boolean" },
        help: { type: "boolean" },
        cwd: { type: "string" },
      },
      strict: true,
      allowNegative: true,
    });

    let maxTokens = API_DEFAULT_MAX_TOKENS;
    if (values["max-tokens"] !== undefined) {
      const n = Number(values["max-tokens"]);
      if (!Number.isFinite(n) || n < 1 || n > 200_000) {
        return {
          error: `--max-tokens must be a number in [1, 200000], got "${values["max-tokens"]}"`,
        };
      }
      maxTokens = n;
    }

    let timeoutMs = DEFAULT_TIMEOUT_MS;
    if (values.timeout !== undefined) {
      const n = Number(values.timeout);
      if (!Number.isFinite(n) || n < 1000 || n > 1_800_000) {
        return {
          error: `--timeout must be a number in [1000, 1800000], got "${values.timeout}"`,
        };
      }
      timeoutMs = n;
    }

    return {
      prompt: typeof values.prompt === "string" ? values.prompt : undefined,
      model: typeof values.model === "string" ? values.model : undefined,
      provider:
        typeof values.provider === "string" ? values.provider : undefined,
      maxTokens,
      timeoutMs,
      // default stream=true; --no-stream (allowNegative) → false
      stream: values.stream !== false,
      version: values.version === true,
      help: values.help === true,
      cwd: typeof values.cwd === "string" ? values.cwd : undefined,
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/** True when a ParseApiResult is the ok variant. */
function isApiOk(r: ParseApiResult): r is ParsedApiArgs {
  return !("error" in r);
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
// api backend — production HTTP implementation (zero deps: fetch + TextDecoder)
// ---------------------------------------------------------------------------

/**
 * Production deps.runApi: POST an anthropic-compatible /v1/messages request
 * and return a normalized RunOutcome.
 *
 * - stream=true: reads the SSE body chunk-by-chunk, decodes UTF-8, splits on
 *   newlines, and aggregates `text_delta` payloads into stdout. Two clocks
 *   guard against hangs: an idle timer (reset on every text-bearing chunk)
 *   and an absolute timer (timeoutMs). Either firing aborts the fetch via
 *   AbortController → exit 1 with a timeout message.
 * - stream=false: awaits the full JSON body and extracts `content[].text`,
 *   then applies the 50k-char truncation.
 *
 * HTTP errors (non-2xx, network failure, abort) → exit 1 with diagnostics on
 * stderr; stdout stays empty so the caller's empty-output guard still works.
 */
export async function runApi(req: ApiRequest): Promise<RunOutcome> {
  const controller = new AbortController();
  const { signal } = controller;

  // Two timers: absolute + idle. timeoutMs is both the hard ceiling and the
  // default idle budget — SSE streams that go quiet for that long are treated
  // as hung. We reset the idle clock whenever we receive text.
  let idleTimer: NodeJS.Timeout | undefined;
  let absoluteTimer: NodeJS.Timeout | undefined;
  let timedOut = false;
  const resetIdle = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, req.timeoutMs);
  };
  absoluteTimer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, req.timeoutMs);
  resetIdle();

  const clearTimers = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    if (absoluteTimer) clearTimeout(absoluteTimer);
  };

  const headers: Record<string, string> = {
    Authorization: `Bearer ${req.token}`,
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
    accept: req.stream ? "text/event-stream" : "application/json",
  };

  let response: Response;
  try {
    response = await fetch(req.url, {
      method: "POST",
      headers,
      body: JSON.stringify(buildApiBody(req)),
      signal,
    });
  } catch (err) {
    clearTimers();
    if (timedOut) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `gcli: api timed out after ${req.timeoutMs}ms`,
      };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return {
      exitCode: 1,
      stdout: "",
      stderr: `gcli: api request failed: ${msg}`,
    };
  }

  if (!response.ok) {
    clearTimers();
    let detail = "";
    try {
      detail = await response.text();
    } catch {
      detail = "";
    }
    const trimmed = detail.trim().slice(0, 1000);
    return {
      exitCode: 1,
      stdout: "",
      stderr: `gcli: api returned HTTP ${response.status}${trimmed ? `: ${trimmed}` : ""}`,
    };
  }

  if (!req.stream) {
    clearTimers();
    let body: unknown;
    try {
      body = await response.json();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        exitCode: 1,
        stdout: "",
        stderr: `gcli: api returned malformed JSON: ${msg}`,
      };
    }
    const text = extractNonStreamText(body);
    if (!text) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: "gcli: api returned no text content",
      };
    }
    return { exitCode: 0, stdout: truncate(text), stderr: "" };
  }

  // Streaming: aggregate text_delta chunks. response.body is a web stream;
  // TextDecoder handles multi-byte UTF-8 split across chunk boundaries, and a
  // leftover buffer carries the partial final line until the next newline.
  if (response.body === null) {
    clearTimers();
    return { exitCode: 1, stdout: "", stderr: "gcli: api stream had no body" };
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let aggregated = "";
  let leftover = "";
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      leftover += decoder.decode(value, { stream: true });
      // SSE events are separated by newlines; process every complete line and
      // keep the trailing partial in `leftover`.
      const lines = leftover.split(/\r?\n/);
      leftover = lines.pop() ?? "";
      for (const line of lines) {
        const delta = extractTextDelta(line);
        if (delta !== null) {
          aggregated += delta;
          resetIdle();
        }
      }
    }
    // Flush any trailing line (some servers omit the final newline).
    const tail = decoder.decode();
    leftover += tail;
    if (leftover.length > 0) {
      const delta = extractTextDelta(leftover);
      if (delta !== null) aggregated += delta;
    }
  } catch (err) {
    clearTimers();
    if (timedOut) {
      // Timeout is a backend error (exit 1) per the contract, even when some
      // text was already received — callers must not treat a timed-out
      // response as success.
      return {
        exitCode: 1,
        stdout: "",
        stderr: `gcli: api timed out after ${req.timeoutMs}ms`,
      };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return {
      exitCode: 1,
      stdout: "",
      stderr: `gcli: api stream read failed: ${msg}`,
    };
  }
  clearTimers();

  if (!aggregated) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: "gcli: api stream produced no text",
    };
  }
  // Streaming output is not truncated (real-time, contract §A); only the
  // non-stream path truncates.
  return { exitCode: 0, stdout: aggregated, stderr: "" };
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
// Provider picker (TTY only) — arrow keys, zero deps
// ---------------------------------------------------------------------------

/**
 * Production deps.pickProvider: arrow-key menu rendered entirely on stderr
 * (stdout stays pipe-clean). ↑↓/j/k move with wrap, Enter confirms, Esc
 * skips, ctrl-c restores the terminal then exits 130; any other key is a
 * noop (C-P1).
 *
 * Zero deps: `readline.emitKeypressEvents` + raw-mode stdin + hand-written
 * ANSI. Rows are redrawn in place (cursor-up + `\r` + clear-to-EOL per line)
 * so navigation leaves no ghosting (C-P3). The trailing 不切换 row is
 * appended here — `entries` holds providers only (D4); confirming it (or
 * pressing Esc) resolves {kind:"skip"}.
 *
 * Raw-mode lifecycle: `process.stdin.isRaw` is saved before
 * `setRawMode(true)` and restored on EVERY exit path (confirm / Esc / ctrl-c
 * / stream end / error) before the promise settles, and the keypress (and
 * its lazily-attached internal `data`) listeners are removed — so the
 * spawned claude TUI takes stdin over cleanly. The picker always completes
 * before any backend spawn.
 */
function pickProviderInteractive(
  entries: PickerEntry[],
  initialIndex: number,
): Promise<PickerOutcome> {
  return new Promise((resolvePromise) => {
    const stderr = process.stderr;
    const stdin = process.stdin;
    const rowCount = entries.length + 1; // D1: count includes the 不切换 row
    let index = Math.min(Math.max(Math.trunc(initialIndex), 0), rowCount - 1); // clamp (D4)
    let settled = false;

    const SKIP_LABEL = "不切换（使用 cc-switch 当前生效配置）";
    const TITLE =
      "gcli: 选择 cc-switch provider（↑↓/j/k/C-n/C-p 移动 · Enter 确认 · Esc/C-g 不切换）:";

    const labelOf = (row: number): string => {
      if (row >= entries.length) return SKIP_LABEL;
      const entry = entries[row];
      return entry.quota ? `${entry.name}  ${entry.quota}` : entry.name;
    };
    // Selected row: ❯ + full-line inverse video; unselected: two-space indent
    // (C-P7). \x1b[K clears to EOL so a shorter previous render leaves no
    // ghosting (残影).
    const rowText = (row: number): string => {
      const label = labelOf(row);
      return row === index
        ? `\x1b[7m❯ ${label}\x1b[27m\x1b[K`
        : `  ${label}\x1b[K`;
    };
    const drawRows = (): void => {
      for (let row = 0; row < rowCount; row++) {
        stderr.write(`${rowText(row)}\n`);
      }
    };
    // In-place redraw: the cursor sits just below the last row after each
    // draw, so move it back up over every entry row before repainting.
    const redraw = (): void => {
      stderr.write(`\x1b[${rowCount}A\r`);
      drawRows();
    };

    // Raw-mode lifecycle (C-P3): save → raw → ... EVERY exit path restores.
    const wasRaw = stdin.isRaw === true;
    const dataListenersBefore = stdin.listeners("data") as (() => void)[];
    let onKeypress:
      | ((str: string, key: KeypressKey | undefined) => void)
      | undefined;
    let onGone: () => void = () => {};

    const cleanup = (): void => {
      if (onKeypress !== undefined) {
        stdin.removeListener("keypress", onKeypress);
      }
      stdin.removeListener("close", onGone);
      stdin.removeListener("error", onGone);
      // emitKeypressEvents lazily attaches an internal 'data' listener (via
      // its newListener hook) when the first keypress listener registers;
      // remove any data listeners we introduced so stdin is left exactly as
      // we found it and the spawned backend owns the terminal.
      for (const listener of stdin.listeners("data") as (() => void)[]) {
        if (!dataListenersBefore.includes(listener)) {
          stdin.removeListener("data", listener);
        }
      }
      stdin.pause();
      if (stdin.isTTY) stdin.setRawMode(wasRaw);
    };
    const finish = (outcome: PickerOutcome): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise(outcome);
    };

    // Title + hint drawn once; entry rows below it (C-P7).
    stderr.write(`${TITLE}\n`);
    drawRows();

    emitKeypressEvents(stdin);
    onKeypress = (_str: string, key: KeypressKey | undefined): void => {
      try {
        if (key?.ctrl && key.name === "c") {
          // C-P1: restore the terminal FIRST, then take the SIGINT exit code.
          cleanup();
          process.exit(130);
        }
        if (key === undefined) return;
        const action = applyPickerKey(key, index, rowCount);
        if (action.type === "move") {
          index = action.index;
          redraw();
        } else if (action.type === "confirm") {
          // The last row is the 不切换 row → skip (D4).
          finish(
            index < entries.length
              ? { kind: "select", entry: entries[index] }
              : { kind: "skip" },
          );
        } else if (action.type === "skip") {
          finish({ kind: "skip" });
        }
        // noop → nothing
      } catch {
        // Any unexpected failure must never wedge raw mode on: restore and
        // treat like a skip.
        finish({ kind: "skip" });
      }
    };
    // Defensive exit paths (EOF after `-p -`, terminal hangup): restore and
    // skip rather than hang.
    onGone = (): void => finish({ kind: "skip" });
    stdin.on("keypress", onKeypress);
    stdin.once("close", onGone);
    stdin.once("error", onGone);
    if (stdin.isTTY) stdin.setRawMode(true);
  });
}

/** Minimal shape of a readline keypress event's `key` argument. */
type KeypressKey = PickerKeyInput;

// ---------------------------------------------------------------------------
// Last-provider memory (D2) — production deps.readLastProvider/writeLastProvider
// ---------------------------------------------------------------------------

/**
 * Production deps.readLastProvider: trimmed first line of LAST_PROVIDER_PATH,
 * or undefined when missing/empty/unreadable (silent — the memory is a hint,
 * never a warning).
 */
function readLastProviderFromDisk(): Promise<string | undefined> {
  return new Promise((resolvePromise) => {
    try {
      const raw = readFileSync(LAST_PROVIDER_PATH, "utf8");
      const trimmed = raw.trim();
      resolvePromise(trimmed ? trimmed : undefined);
    } catch {
      resolvePromise(undefined);
    }
  });
}

/**
 * Production deps.writeLastProvider: persist the provider name as a single
 * UTF-8 line, creating the config directory if needed. Best-effort: any
 * failure is swallowed (memory is an optimization, never an error).
 */
function writeLastProviderToDisk(name: string): Promise<void> {
  return new Promise((resolvePromise) => {
    try {
      mkdirSync(dirname(LAST_PROVIDER_PATH), { recursive: true });
      writeFileSync(LAST_PROVIDER_PATH, `${name}\n`, "utf8");
    } catch {
      // best-effort: ignore
    }
    resolvePromise();
  });
}

// ---------------------------------------------------------------------------
// Quota subtitles (revise-3) — production deps.fetchProviderQuotas
// ---------------------------------------------------------------------------

type QuotaCacheEntry = { ts: number; ok: boolean; text?: string };
type QuotaCache = Record<string, QuotaCacheEntry>;

/**
 * Production deps.fetchProviderQuotas (C-Q5): cache-first with a 60s/15s TTL,
 * concurrent fetch (2.5s AbortController per request) for stale entries,
 * best-effort cache rewrite. Failures resolve to no subtitle — the menu must
 * never block or error on quota problems.
 */
async function fetchProviderQuotasHttp(
  items: {
    name: string;
    env: Record<string, string>;
  }[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  let cache: QuotaCache = {};
  try {
    const raw = JSON.parse(readFileSync(QUOTA_CACHE_PATH, "utf8"));
    if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
      cache = raw as QuotaCache;
    }
  } catch {
    cache = {};
  }
  const now = Date.now();
  const stale: {
    name: string;
    req: { kind: "kimi" | "glm"; url: string; authHeader: string };
  }[] = [];
  for (const item of items) {
    const c = cache[item.name];
    if (
      c !== undefined &&
      typeof c.ts === "number" &&
      now - c.ts < (c.ok ? QUOTA_TTL_OK_MS : QUOTA_TTL_FAIL_MS)
    ) {
      if (c.ok === true && typeof c.text === "string" && c.text !== "") {
        out.set(item.name, c.text);
      }
      continue;
    }
    const req = buildQuotaRequest(item.env);
    if (req === null) continue; // no quota API for this provider — skip, don't cache
    stale.push({ name: item.name, req });
  }
  await Promise.all(
    stale.map(async ({ name, req }) => {
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        QUOTA_FETCH_TIMEOUT_MS,
      );
      try {
        const headers: Record<string, string> = {
          Authorization: req.authHeader,
          Accept: "application/json",
        };
        if (req.kind === "glm") headers["Accept-Language"] = "en-US,en";
        const resp = await fetch(req.url, {
          headers,
          signal: controller.signal,
        });
        if (!resp.ok) {
          cache[name] = { ts: now, ok: false };
          return;
        }
        const body: unknown = await resp.json();
        const windows =
          req.kind === "kimi" ? parseKimiUsages(body) : parseGlmQuota(body);
        const text = formatQuota(windows, Date.now());
        if (text !== "") {
          cache[name] = { ts: now, ok: true, text };
          out.set(name, text);
        } else {
          cache[name] = { ts: now, ok: false };
        }
      } catch {
        cache[name] = { ts: now, ok: false };
      } finally {
        clearTimeout(timer);
      }
    }),
  );
  try {
    mkdirSync(dirname(QUOTA_CACHE_PATH), { recursive: true });
    writeFileSync(QUOTA_CACHE_PATH, JSON.stringify(cache), "utf8");
  } catch {
    // best-effort: ignore
  }
  return out;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const HELP = `Usage:
  gcli [claude] [options] [-- <args>]  wrap the claude CLI (default backend)
  gcli agy [options] [-- <args>]       wrap the agy CLI (explicit subcommand)
  gcli api [options]                   call an anthropic-compatible messages API

gcli sits in front of three backends and gives skills a stable entry point:
50k-char output truncation (agy/claude; api only when non-stream), a hard
timeout, explicit exit codes, and stdin piping (\`-p -\`).

Without -p, the agy/claude backends launch their interactive TUI (inherited
stdio; no timeout, no truncation; the child's exit code is passed through).
This requires a TTY — piping into gcli without -p is an error (use '-p -' to
pipe a prompt). The api backend is one-shot HTTP and always requires -p.

For agy/claude, unknown flags and bare args are forwarded to the backend
verbatim; \`--\` forwards everything after it unconditionally. The api backend
is STRICT — unknown flags are errors (exit 2), because it builds an HTTP body
directly with nothing to forward to.

agy backend (\`gcli agy ...\` — the subcommand is REQUIRED; bare \`gcli\` is claude):
  -p, --prompt <text|->   Prompt text, "-" for stdin; omit for interactive TUI
      --model <name>      agy model (e.g. gemini-2.5-pro)
      --yolo              Auto-approve tool actions (agy --dangerously-skip-permissions)
      --sandbox           Run agy in sandbox mode
      --cwd <dir>         Working directory (added via agy --add-dir)
      --timeout <ms>      Hard timeout in ms (default 300000, max 1800000)
      --version           Print the agy version
      --help              Show this help
      -- <args...>        Pass remaining args through to agy verbatim

claude backend (default; bare \`gcli ...\` === \`gcli claude ...\`):
  -p, --prompt <text|->   Prompt text, "-" for stdin; omit for interactive TUI
      --provider <name>   cc-switch provider (matched by exact/case/substring)
      --pick              Force the provider picker menu, even in print mode
      --model <name>      Override ANTHROPIC_MODEL in the provider env
      --cwd <dir>         Working directory (added via claude --add-dir)
      --timeout <ms>      Hard timeout in ms (default 300000, max 1800000)
      --version           Print the claude version
      --help              Show this help
      -- <args...>        Pass remaining args through to claude verbatim

  Notes:
    - --provider switches via \`claude -p ... --settings {'env':{...}}\`; it
      does NOT rewrite ~/.claude/settings.json.
    - No --provider in a TTY: gcli lists all cc-switch providers (in
      cc-switch's own DB order) in an arrow-key picker (↑↓/j/k and Emacs
      C-n/C-p move · Enter 确认 · Esc/C-g = 不切换, keep claude's default
      config; M-</M-> jump to first/last; ctrl-c exits 130). In print mode
      (-p) the last confirmed provider is reused silently (one stderr hint
      line); the menu only pops when nothing valid is remembered, or when
      --pick is given. Without a TTY the picker never triggers — no prompt,
      no cc-switch DB read, no memory-file IO.
    - Menu rows carry a quota subtitle (kimi/glm coding plans): 5h/weekly
      usage percent plus the next reset as a relative duration (e.g.
      \`5h:42% wk:17% ↻2h13m\`). Fetched once per menu open, cached 60s in
      ~/.config/gcli/quota-cache.json; providers without a quota API show
      no subtitle.
    - The last picker choice is remembered in ~/.config/gcli/last-provider
      (best-effort; explicit --provider neither reads nor writes it).
    - --yolo/--sandbox are rejected on the claude backend (default path
      included); use \`gcli agy\` for them. --pick is claude-only too (agy
      rejects it) and cannot be combined with --provider.
    - --provider passes the provider token via claude's argv (visible in 'ps');
      cc-switch's mechanism offers no sealed alternative.

api backend (\`gcli api ...\`) — pure HTTP, no agent, no subprocess:
  -p, --prompt <text|->   Prompt text, "-" for stdin (REQUIRED)
      --provider <name>   cc-switch provider (REQUIRED; supplies base URL/token/model)
      --model <name>      Override the provider's ANTHROPIC_MODEL
      --max-tokens <n>    Output token budget (default 80000)
      --timeout <ms>      Idle + absolute timeout in ms (default 300000, max 1800000)
      --stream|--no-stream  Stream SSE and aggregate live (default stream)
      --version           Print the api backend identity
      --help              Show this help

  Notes:
    - No --cwd (no file operations; supplied --cwd is warned + ignored).
    - --yolo/--sandbox are rejected (they are agent flags; api has no agent).
    - Unknown flags exit 2 (strict; nothing to forward to).
    - thinking is left ENABLED (k3 quality source); use a sufficient
      --max-tokens budget (default 80000) to cover thinking + text.

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
  // --pick is claude-backend-only (cc-switch provider picker); agy has no
  // provider switching, so reject it like the other unsupported flags.
  if (parsed.pick) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: "gcli: agy backend does not support --pick",
    };
  }

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

/** Outcome of the shared RawProvider → settingsEnv tail. */
type SettingsEnvResolve =
  | { kind: "ok"; env: Record<string, string> }
  | { kind: "error"; outcome: RunOutcome };

/**
 * Shared tail of the claude provider paths (explicit --provider and the TTY
 * picker): RawProvider → settingsEnv (C-D4). cc-switch stores
 * settings_config as a JSON string; a pre-parsed object is accepted too
 * (defensive). Env-extraction failures map to exit 1, unchanged.
 */
function settingsEnvFromRawProvider(
  target: RawProvider,
  model: string | undefined,
): SettingsEnvResolve {
  const cfgJson =
    typeof target.settingsConfig === "string"
      ? target.settingsConfig
      : JSON.stringify(target.settingsConfig);
  const envResult = extractProviderEnv(cfgJson);
  if ("error" in envResult) {
    return {
      kind: "error",
      outcome: { exitCode: 1, stdout: "", stderr: `gcli: ${envResult.error}` },
    };
  }
  return { kind: "ok", env: buildSettingsEnv(envResult.env, model) };
}

async function runClaudeBackend(
  parsed: ParsedArgs,
  deps: RunDeps,
): Promise<RunOutcome> {
  // D3 validation order: --pick/--provider mutual exclusion → non-TTY --pick
  // → the pre-existing yolo/version/TTY-guard sequence.
  if (parsed.pick && parsed.provider !== undefined) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: "gcli: --pick cannot be combined with --provider",
    };
  }
  // Placed BEFORE the TTY guard below on purpose: a non-TTY --pick must
  // report --pick even when -p is missing (which would otherwise produce the
  // generic "-p is required" error).
  if (parsed.pick && !deps.isInteractive()) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: "gcli: --pick requires a TTY",
    };
  }

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
  let pickerWarning: string | undefined;
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
    const resolved = settingsEnvFromRawProvider(target, parsed.model);
    if (resolved.kind === "error") {
      return resolved.outcome;
    }
    settingsEnv = resolved.env;
  } else {
    // Picker / memory path (D3 matrix): closed trigger set — claude dispatch
    // (we are here), no --provider, and past the --version short-circuit.
    // Non-TTY callers (skills/CI/pipes) skip this entirely: zero prompts,
    // zero cc-switch DB reads, zero memory-file IO (C-P9).
    if (deps.isInteractive()) {
      const lookup = await deps.readCcSwitchProvider();
      if (!lookup.ok) {
        // Soft degradation (C-P10): warn and continue without injection.
        pickerWarning = `gcli: provider picker unavailable: ${lookup.message}`;
      } else if (lookup.providers.length === 0) {
        pickerWarning = "gcli: no cc-switch providers configured";
      } else {
        // Memory read (D2): TTY claude path, no --provider. Exact-name match
        // against the current list; mismatch/missing/empty/unreadable is
        // silently ignored (initialIndex 0, no warning).
        const remembered = await deps.readLastProvider();
        // D5 (revise-2): NO sorting — the menu mirrors the cc-switch DB row
        // order (rowid/insertion order, what the cc-switch UI shows).
        const ordered = lookup.providers;
        const memoryIndex =
          remembered !== undefined
            ? ordered.findIndex((p) => p.name === remembered)
            : -1;
        const memoryValid = memoryIndex >= 0;
        const printMode = prompt !== undefined;
        // D3 matrix: TUI → always menu; print + valid memory + no --pick →
        // silent reuse; print + invalid/absent memory → menu; --pick →
        // force menu.
        const showMenu = parsed.pick || !printMode || !memoryValid;
        if (!showMenu) {
          // C-P5 silent reuse: inject the remembered provider with no menu
          // output; a single stderr hint line rides on outcome.stderr (same
          // mechanism as the v1 pickerWarning). Memory is NOT rewritten.
          const resolved = settingsEnvFromRawProvider(
            ordered[memoryIndex],
            parsed.model,
          );
          if (resolved.kind === "error") {
            return resolved.outcome;
          }
          settingsEnv = resolved.env;
          pickerWarning = `gcli: provider=${ordered[memoryIndex].name}（--pick 重选）`;
        } else {
          // C-Q4: quota fetch ONLY on the menu path (silent reuse / explicit
          // --provider / non-TTY never reach here). Extract each provider's
          // env first (same source as injection); broken configs are skipped.
          const quotaItems: {
            name: string;
            env: Record<string, string>;
          }[] = [];
          for (const p of ordered) {
            const cfgJson =
              typeof p.settingsConfig === "string"
                ? p.settingsConfig
                : JSON.stringify(p.settingsConfig);
            const envResult = extractProviderEnv(cfgJson);
            if (!("error" in envResult)) {
              quotaItems.push({ name: p.name, env: envResult.env });
            }
          }
          const quotaMap = await deps.fetchProviderQuotas(quotaItems);
          // D5/D6 (revise-3): rows are name + quota subtitle (host is gone);
          // the remembered row gets a（上次）marker after the subtitle.
          const entries: PickerEntry[] = ordered.map((p) => {
            let quota = quotaMap.get(p.name);
            if (remembered !== undefined && p.name === remembered) {
              quota = quota !== undefined ? `${quota}（上次）` : "（上次）";
            }
            return { name: p.name, quota };
          });
          const picked = await deps.pickProvider(
            entries,
            memoryValid ? memoryIndex : 0,
          );
          if (picked.kind === "select") {
            // Exact-name lookup (no matchProviderName): the picker returns
            // an entry straight from this list.
            const target = ordered.find((p) => p.name === picked.entry.name);
            if (target === undefined) {
              pickerWarning = `gcli: provider picker returned unknown name: ${picked.entry.name}`;
            } else {
              const resolved = settingsEnvFromRawProvider(target, parsed.model);
              if (resolved.kind === "error") {
                return resolved.outcome;
              }
              settingsEnv = resolved.env;
              // D2: write AFTER the picker confirm, BEFORE any spawn.
              await deps.writeLastProvider(picked.entry.name);
            }
          }
          // skip → keep claude's default config; memory untouched.
        }
      }
    }
    if (settingsEnv === undefined && parsed.model !== undefined) {
      // No provider injection (no --provider, picker skipped/unavailable):
      // still honour --model by injecting a minimal env that overrides
      // ANTHROPIC_MODEL via --settings merge (unchanged behaviour).
      settingsEnv = { ANTHROPIC_MODEL: parsed.model };
    }
  }

  // Picker degradation warnings ride along on the outcome's stderr without
  // changing the exit code (C-D5).
  const withPickerWarning = (o: RunOutcome): RunOutcome =>
    pickerWarning === undefined
      ? o
      : {
          ...o,
          stderr: o.stderr ? `${pickerWarning}\n${o.stderr}` : pickerWarning,
        };

  const cwdAbs = parsed.cwd ? resolve(parsed.cwd) : undefined;

  // Interactive mode (no -p in a TTY): inherit stdio, pass exit code through.
  if (prompt === undefined) {
    const args = buildClaudeArgs({
      settingsEnv,
      cwd: parsed.cwd,
      passthrough: parsed.passthrough,
    });
    const r = await deps.runClaudeInteractive(args, cwdAbs);
    return withPickerWarning({
      exitCode: r.exitCode,
      stdout: "",
      stderr: r.spawnError ?? "",
    });
  }

  const args = buildClaudeArgs({
    prompt,
    settingsEnv,
    cwd: parsed.cwd,
    passthrough: parsed.passthrough,
  });
  const result = await deps.runClaude(args, parsed.timeoutMs, cwdAbs);
  return withPickerWarning(mapSpawnResult(result, "claude", parsed.timeoutMs));
}

// ---------------------------------------------------------------------------
// api backend — pure HTTP to an anthropic-compatible /v1/messages endpoint
// ---------------------------------------------------------------------------

/**
 * Resolve provider env for the api backend: validate the name, look it up in
 * cc-switch, and extract the ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN /
 * ANTHROPIC_MODEL triple. Returns the resolved triple or an error outcome
 * (exit 1/2) for the caller to return verbatim.
 *
 * Mirrors the claude backend's provider path so provider matching is identical
 * (exact → case-insensitive → substring).
 */
type ProviderResolve =
  | { kind: "ok"; baseUrl: string; token: string; model: string }
  | { kind: "error"; outcome: RunOutcome };

async function resolveApiProviderEnv(
  providerName: string | undefined,
  model: string | undefined,
  deps: RunDeps,
): Promise<ProviderResolve> {
  const err = (exitCode: number, stderr: string): ProviderResolve => ({
    kind: "error",
    outcome: { exitCode, stdout: "", stderr },
  });
  if (providerName === undefined) {
    return err(2, "gcli: api backend requires --provider <name>");
  }
  const validated = validateProviderName(providerName);
  if (typeof validated !== "string") {
    return err(2, `gcli: ${validated.error}`);
  }
  const lookup = await deps.readCcSwitchProvider();
  if (!lookup.ok) {
    return err(1, `gcli: ${lookup.message}`);
  }
  const names = lookup.providers.map((p) => p.name);
  const match = matchProviderName(providerName, names);
  if ("none" in match) {
    return err(2, `gcli: provider not found: ${providerName}`);
  }
  if ("ambiguous" in match) {
    const candidates = match.ambiguous
      .map((n) => `"${n}"`)
      .sort()
      .join(", ");
    return err(2, `gcli: ambiguous provider: ${candidates}`);
  }
  const target = lookup.providers.find((p) => p.name === match.matched);
  if (target === undefined) {
    return err(2, `gcli: provider not found: ${providerName}`);
  }
  const cfgJson =
    typeof target.settingsConfig === "string"
      ? target.settingsConfig
      : JSON.stringify(target.settingsConfig);
  const envResult = extractProviderEnv(cfgJson);
  if ("error" in envResult) {
    return err(1, `gcli: ${envResult.error}`);
  }
  const baseUrl = envResult.env.ANTHROPIC_BASE_URL;
  const token = envResult.env.ANTHROPIC_AUTH_TOKEN;
  // Model resolution: --model > ANTHROPIC_MODEL > DEFAULT_SONNET > DEFAULT_HAIKU.
  // cc-switch stores context-window variants like "k3[1M]"; the [1M] marker is a
  // claude-agent convention the raw API rejects (HTTP 401 "model id does not
  // exist, recognized as other:k3[1M]"). Strip any trailing [...] suffix so
  // pure-API calls send "k3". Fallback chain also covers providers that only
  // define ANTHROPIC_DEFAULT_SONNET_MODEL (not ANTHROPIC_MODEL).
  const rawModel =
    model ??
    envResult.env.ANTHROPIC_MODEL ??
    envResult.env.ANTHROPIC_DEFAULT_SONNET_MODEL ??
    envResult.env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
  const resolvedModel = rawModel?.replace(/\[[^\]]*\]$/, "");
  if (!baseUrl) {
    return err(1, "gcli: provider env is missing ANTHROPIC_BASE_URL");
  }
  if (!token) {
    return err(1, "gcli: provider env is missing ANTHROPIC_AUTH_TOKEN");
  }
  if (!resolvedModel) {
    return err(
      1,
      "gcli: no model resolved (set --model or ANTHROPIC_MODEL in provider)",
    );
  }
  return { kind: "ok", baseUrl, token, model: resolvedModel };
}

/**
 * api backend entry (mirrors runClaudeBackend's shape). Strict argv, no
 * passthrough, no spawn. Resolves the provider, builds the ApiRequest, and
 * delegates to deps.runApi (HTTP + SSE + timeout).
 */
async function runApiBackend(
  parsed: ParsedApiArgs,
  deps: RunDeps,
): Promise<RunOutcome> {
  // --cwd is meaningless for the api backend (no file ops); warn into the
  // outcome's stderr (visible to callers/tests) rather than reject, per the
  // contract. main() forwards RunOutcome.stderr to the process.
  const cwdWarn =
    parsed.cwd !== undefined
      ? "gcli: --cwd is ignored by the api backend (no file operations)\n"
      : "";
  const wrap = (o: RunOutcome): RunOutcome => ({
    ...o,
    stderr: cwdWarn + o.stderr,
  });

  if (parsed.version) {
    // No subprocess to query; report the api backend identity.
    return wrap({
      exitCode: 0,
      stdout: "gcli api backend (anthropic-compatible /v1/messages over HTTP)",
      stderr: "",
    });
  }

  // -p is required for the api backend (there is no interactive TUI mode —
  // it's a one-shot HTTP request).
  if (parsed.prompt === undefined) {
    return wrap({
      exitCode: 2,
      stdout: "",
      stderr: "gcli: api backend requires -p/--prompt <text|->",
    });
  }

  let prompt = parsed.prompt;
  if (prompt === "-") {
    prompt = await deps.readStdin();
    if (!prompt.trim()) {
      return wrap({
        exitCode: 2,
        stdout: "",
        stderr: "gcli: -p - given but stdin is empty (no prompt piped)",
      });
    }
  }

  const resolved = await resolveApiProviderEnv(
    parsed.provider,
    parsed.model,
    deps,
  );
  if (resolved.kind === "error") {
    return wrap(resolved.outcome);
  }

  const req: ApiRequest = {
    url: buildApiEndpoint(resolved.baseUrl),
    token: resolved.token,
    model: resolved.model,
    maxTokens: parsed.maxTokens,
    prompt,
    stream: parsed.stream,
    timeoutMs: parsed.timeoutMs,
  };

  const outcome = await deps.runApi(req);
  // Empty output is a backend error (exit 1), consistent with the other
  // backends' empty-output detection.
  if (outcome.exitCode === 0 && !outcome.stdout.trim()) {
    return wrap({
      exitCode: 1,
      stdout: "",
      stderr: "gcli: api returned no output",
    });
  }
  return wrap(outcome);
}

/**
 * Route argv to the agy / claude / api backend via injectable deps (C1/C2).
 * Returns a {exitCode, stdout, stderr} outcome; main() owns process.exit.
 */
export async function run(argv: string[], deps: RunDeps): Promise<RunOutcome> {
  const sub = parseSubcommand(argv);
  if ("error" in sub) {
    return { exitCode: 2, stdout: "", stderr: `gcli: ${sub.error}` };
  }
  if (sub.subcommand === "api") {
    const parsed = parseApiArgs(sub.rest);
    if (!isApiOk(parsed)) {
      return { exitCode: 2, stdout: "", stderr: `gcli: ${parsed.error}` };
    }
    if (parsed.help) {
      return { exitCode: 0, stdout: HELP, stderr: "" };
    }
    return runApiBackend(parsed, deps);
  }
  const parsed = parseCliArgs(sub.rest);
  if (!isOk(parsed)) {
    return { exitCode: 2, stdout: "", stderr: `gcli: ${parsed.error}` };
  }
  if (parsed.help) {
    return { exitCode: 0, stdout: HELP, stderr: "" };
  }
  // Default backend is claude (C-D2): bare `gcli` === `gcli claude`.
  return sub.subcommand === "agy"
    ? runAgyBackend(parsed, deps)
    : runClaudeBackend(parsed, deps);
}

async function main(): Promise<void> {
  const deps: RunDeps = {
    readCcSwitchProvider: () => readCcSwitchProvider(CC_SWITCH_DB_PATH),
    runClaude: (args, timeoutMs, cwd) =>
      runClaude(args, timeoutMs ?? DEFAULT_TIMEOUT_MS, cwd),
    runAgy: (args, timeoutMs, cwd) =>
      runAgy(args, timeoutMs ?? DEFAULT_TIMEOUT_MS, cwd),
    runApi: (req) => runApi(req),
    readStdin: () => readStdin(),
    runClaudeInteractive: (args, cwd) => runClaudeInteractive(args, cwd),
    runAgyInteractive: (args, cwd) => runAgyInteractive(args, cwd),
    isInteractive: () => process.stdin.isTTY === true,
    pickProvider: (entries, initialIndex) =>
      pickProviderInteractive(entries, initialIndex),
    fetchProviderQuotas: (items) => fetchProviderQuotasHttp(items),
    readLastProvider: () => readLastProviderFromDisk(),
    writeLastProvider: (name) => writeLastProviderToDisk(name),
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
