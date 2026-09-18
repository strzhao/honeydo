#!/usr/bin/env node

/**
 * gcli — thin wrapper around the `agy` and `claude` CLI backends.
 *
 * Default backend is claude: bare `gcli ...` is exactly `gcli claude ...`.
 * `gcli agy ...` routes to the agy CLI (explicit subcommand required); the
 * claude backend can switch cc-switch providers inline via
 * `claude -p ... --settings`. Adds value over calling the backends directly:
 * prompt via argv or stdin (`-p -`), a hard timeout (spawn SIGTERM), explicit
 * exit codes, and empty-output detection. Output is passed through unmodified
 * — size limits are the endpoint's business, not ours.
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
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { emitKeypressEvents } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes
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

// ---------------------------------------------------------------------------
// hermes backend — paths & constants
// ---------------------------------------------------------------------------

const HERMES_BIN = "hermes";

/** hermes 主配置文件（model 段 + providers 段是本子命令的编辑目标）。 */
export const HERMES_CONFIG_PATH = `${homedir()}/.hermes/config.yaml`;

/** hermes env 文件（provider API key 的落点；全程保持 0o600）。 */
export const HERMES_ENV_PATH = `${homedir()}/.hermes/.env`;

/** hermes cron 任务定义（重 pin 只读它；改动经 `hermes cron edit` 下发）。 */
export const HERMES_CRON_JOBS_PATH = `${homedir()}/.hermes/cron/jobs.json`;

/** hermes 会话库（session_model_usage 表在此 —— 实测在顶层 state.db）。 */
export const HERMES_STATE_DB_PATH = `${homedir()}/.hermes/state.db`;

/** cc-switch name → hermes provider 字段映射（keyEnv/modelOverride）。 */
export const HERMES_PROVIDERS_REGISTRY_PATH = `${homedir()}/.config/gcli/hermes-providers.json`;

/** 上一次切换的一跳记录（0o600，含旧 token 的 prevValue）。 */
export const HERMES_STATE_PATH = `${homedir()}/.config/gcli/hermes-state.json`;

/** hermes providers 条目的 transport 常量（cc-switch 只提供 anthropic 兼容端点）。 */
export const HERMES_TRANSPORT = "anthropic_messages";

/** 切换后验证 ping 的硬超时。 */
export const HERMES_VERIFY_TIMEOUT_MS = 60_000;

/**
 * 内置 seed（防推导造出与现有配置平行的条目）：键是 cc-switch provider 名，
 * 值是 hermes 侧已手工建立好的 id/keyEnv。
 */
export const HERMES_PROVIDER_SEEDS: HermesProviderRegistry = {
  // cc-switch 真实条目名（09-06 sqlite3 实证）：kimi 系的 coding plan 条目叫 "kimi"
  kimi: { id: "kimi-coding", keyEnv: "KIMI_CODING_API_KEY" },
  "Kimi For Coding": { id: "kimi-coding", keyEnv: "KIMI_CODING_API_KEY" },
  "glm flash lastest": { id: "glm-flash", keyEnv: "BIGMODEL_API_KEY" },
};

/** `status`/`rollback` 为 hermes 子命令的保留字位置参数。 */
const HERMES_RESERVED_WORDS = new Set(["status", "rollback"]);

/** Provider-name allowlist (C4b). Names outside this set are rejected. */
const PROVIDER_NAME_RE = /^[A-Za-z0-9 &._-]+$/;

// ---------------------------------------------------------------------------
// Types — DI contract (aligns with acceptance tests)
// ---------------------------------------------------------------------------

export type Subcommand = "agy" | "claude" | "api" | "hermes";

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
export type PickerEntry = { name: string; quota?: string; tag?: string };

/** Result of the arrow-key picker (C-P1): a picked provider, or a skip. */
export type PickerOutcome =
  | { kind: "select"; entry: PickerEntry }
  | { kind: "skip" };

/** A cc-switch provider row as exposed to the claude backend. */
export type RawProvider = { name: string; settingsConfig: unknown };

// ---------------------------------------------------------------------------
// hermes backend — types
// ---------------------------------------------------------------------------

/** registry 单条：cc-switch name → hermes providers 条目字段。 */
export type HermesProviderRegistryEntry = {
  id: string;
  keyEnv: string;
  modelOverride?: string;
};

/** `~/.config/gcli/hermes-providers.json` 的形状（损坏/缺失视为空）。 */
export type HermesProviderRegistry = Record<
  string,
  HermesProviderRegistryEntry
>;

/** 一跳切换的一端（from/to 同构）。 */
export type HermesModelPoint = { id: string; model: string; base_url: string };

/** 一条被重 pin 的 cron job 的旧 pin（rollback 回放用）。 */
export type CronRepinTarget = {
  jobId: string;
  prevProvider: string;
  prevModel: string | null;
};

/** `~/.config/gcli/hermes-state.json`（0o600，env.prevValue 含旧 token）。 */
export type HermesStateFile = {
  lastSwitch: {
    ts: number;
    ccName: string;
    to: HermesModelPoint;
    from: HermesModelPoint;
    configBackup: string;
    env: { key: string; prevValue: string | null };
    cronRepinned: CronRepinTarget[];
  };
};

/** editHermesConfig 的编辑指令。 */
export type HermesConfigEdit = {
  model: { default: string; provider: string; base_url: string };
  provider: {
    id: string;
    name: string;
    base_url: string;
    transport: string;
    key_env: string;
    default_model: string;
  };
};

/** parseHermesConfig 的读取结果（status / 冲突检测共用）。 */
export type HermesConfigInfo = {
  model: { default?: string; provider?: string; base_url?: string };
  providerIds: string[];
};

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
  // Interactive mode (no -p in a TTY): inherit stdio, no timeout,
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
   * provider entries (the production impl renders a dim Esc 退出 footer;
   * row — `entries` holds providers only) and resolve the confirmed entry,
   * or {kind:"skip"} on Esc/C-g (= 退出，不启动后端). `initialIndex` is the caller-
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

  // --- hermes 子命令注入点（main() 一律装配；仅 hermes 路径消费） ---

  /** Spawn `hermes <args>`（cron edit / gateway / -z ping），照 runClaude 的 timeout/SIGTERM 契约。 */
  runHermes: (args: string[], timeoutMs?: number) => Promise<SpawnResult>;
  /** 读 UTF-8 文本文件；缺失/不可读 → undefined（不 throw）。 */
  readTextFile: (path: string) => Promise<string | undefined>;
  /** 原子写（tmp + rename）；mode 缺省时沿用目标文件现有权限（不存在则 0o600）。 */
  writeTextFileAtomic: (
    path: string,
    text: string,
    mode?: number,
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  /** 整文件复制（备份/整文件恢复）。 */
  copyFile: (
    src: string,
    dest: string,
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  /** 查 state.db session_model_usage 最新行（best-effort 验证）；任何失败 → undefined。 */
  queryLastSessionModel: () => Promise<
    { model: string; provider: string } | undefined
  >;
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
  if (first === "hermes") return { subcommand: "hermes", rest: argv.slice(1) };
  if (first.startsWith("-")) return { subcommand: undefined, rest: argv };
  return { error: `unknown subcommand: ${first}` };
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
 * - "escape"     → skip (退出，不启动后端)
 * - Emacs (revise-2): ctrl+"n" ≡ down, ctrl+"p" ≡ up (same wrap); ctrl+"g"
 *   ≡ escape → skip; meta+"<" → first row (absolute), meta+">" → last row
 *   (absolute). Horizontal Emacs keys (C-f/C-b/C-a/C-e) and paging (C-v/M-v)
 *   are deliberately NOT mapped — meaningless in a vertical menu.
 * - anything else → noop (ctrl-c is handled by the caller: restore raw-mode,
 *   exit 130)
 *
 * `index` is the highlighted row, `count` the total rendered rows INCLUDING
 * the footer row. Movement wraps with `(index±1+count)%count`; with
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
 * with type "TOKENS_LIMIT" (coding-plan 订阅) or "CREDIT_LIMIT" (credit 资源
 * 包) — billing type is per-account, fields are identical, same rendering
 * (parity with statusline-sage); sorted by nextResetTime ascending — first is
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
    if (r.type !== "TOKENS_LIMIT" && r.type !== "CREDIT_LIMIT") continue;
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
 * Structured render input shared by the plain and the colored quota
 * renderers: one percentage + one relative reset per window (each window's
 * reset computed independently; missing/expired → omitted for that window).
 * No windows at all → empty parts (the plain join then yields "").
 */
function quotaParts(
  q: QuotaWindows,
  nowMs: number,
): {
  shortPct?: number;
  weeklyPct?: number;
  shortResetRel?: string;
  weeklyResetRel?: string;
} {
  const shortPct = q.short?.pct;
  const weeklyPct = q.weekly?.pct;
  if (shortPct === undefined && weeklyPct === undefined) return {};
  return {
    shortPct,
    weeklyPct,
    shortResetRel:
      q.short === undefined ? undefined : formatReset(q.short.resetIso, nowMs),
    weeklyResetRel:
      q.weekly === undefined
        ? undefined
        : formatReset(q.weekly.resetIso, nowMs),
  };
}

/**
 * Format quota windows as the menu subtitle (C-Q3, 2026-09 双窗重置):
 * `5h:P% ↻<rel> wk:P% ↻<rel>` — each window carries its own reset time.
 * Missing windows degrade; a missing/expired reset omits that window's ↻;
 * no windows → "". Byte-exact contract with downstream consumers — the
 * plain-text output is locked by unit tests; colors live in `colorQuota`,
 * never here.
 */
export function formatQuota(q: QuotaWindows, nowMs: number): string {
  const p = quotaParts(q, nowMs);
  const parts: string[] = [];
  if (p.shortPct !== undefined) {
    parts.push(
      p.shortResetRel === undefined
        ? `5h:${p.shortPct}%`
        : `5h:${p.shortPct}% ↻${p.shortResetRel}`,
    );
  }
  if (p.weeklyPct !== undefined) {
    parts.push(
      p.weeklyResetRel === undefined
        ? `wk:${p.weeklyPct}%`
        : `wk:${p.weeklyPct}% ↻${p.weeklyResetRel}`,
    );
  }
  return parts.join(" ");
}

// Limit 染色阈值（对齐 statusline-sage 的 GLM_HIGH/GLM_MID）。
export const QUOTA_HIGH = 85;
export const QUOTA_MID = 60;

/** truecolor Sage 同款三色：#3A7D68 苔绿 / #D4920A 琥珀 / #D94F3D 朱红。 */
const COLOR_SAGE = "\x1b[38;2;58;125;104m";
const COLOR_AMBER = "\x1b[38;2;212;146;10m";
const COLOR_VERMILION = "\x1b[38;2;217;79;61m";
/** 关闭前景色回到终端默认，但不复位背景——选中行的整行高亮依赖这一点。 */
const FG_OFF = "\x1b[39m";

/**
 * Limit 用量 → 段颜色：≥85 朱红、≥60 琥珀、其余（含非有限数）回退苔绿
 * （阈值语义照搬 statusline-sage `_level_color`）。
 */
export function levelColor(pct: number): string {
  if (!Number.isFinite(pct)) return COLOR_SAGE;
  if (pct >= QUOTA_HIGH) return COLOR_VERMILION;
  if (pct >= QUOTA_MID) return COLOR_AMBER;
  return COLOR_SAGE;
}

/**
 * `formatQuota` 的染色版（picker 用）：`5h:P% ↻rel`/`wk:P% ↻rel` 每个窗口段
 * 按各自 pct 独立选色，各自的重置时间恒 dim，不参与染色。结构与降级规则和
 * `formatQuota` 一致（无窗口 → ""）。行内使用 `\x1b[39m`/`\x1b[22m` 收尾而
 * 非全复位，以免抹掉选中行背景。
 */
export function colorQuota(q: QuotaWindows, nowMs: number): string {
  const p = quotaParts(q, nowMs);
  const parts: string[] = [];
  if (p.shortPct !== undefined) {
    parts.push(
      p.shortResetRel === undefined
        ? `${levelColor(p.shortPct)}5h:${p.shortPct}%${FG_OFF}`
        : `${levelColor(p.shortPct)}5h:${p.shortPct}%${FG_OFF} \x1b[2m↻${p.shortResetRel}\x1b[22m`,
    );
  }
  if (p.weeklyPct !== undefined) {
    parts.push(
      p.weeklyResetRel === undefined
        ? `${levelColor(p.weeklyPct)}wk:${p.weeklyPct}%${FG_OFF}`
        : `${levelColor(p.weeklyPct)}wk:${p.weeklyPct}%${FG_OFF} \x1b[2m↻${p.weeklyResetRel}\x1b[22m`,
    );
  }
  return parts.join(" ");
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
  /**
   * Explicit thinking control: "off" sends {type:"disabled"}, "on" sends
   * {type:"enabled", budget_tokens: floor(maxTokens/2)}. Undefined (= CLI
   * `--thinking auto`) omits the field entirely and keeps the endpoint's
   * default — which on bigmodel GLM endpoints means thinking ON, where
   * thinking shares the max_tokens budget with text (small budgets can end
   * up thinking-only, no text block).
   */
  thinking?: "off" | "on";
  /** Transient-failure retries (network error / 408/429/5xx / malformed JSON / empty body). 0 = single attempt. */
  retries?: number;
}

/**
 * Build the HTTP body for an anthropic-compatible /v1/messages request.
 *
 * thinking is intentionally NOT disabled: k3's extended thinking is the quality
 * source for creative+SVG tasks (dry-run: single-block ~768-char thinking yields
 * high-quality output in ~45s vs claude-agent's 53min). We rely on a sufficient
 * --max-tokens budget (default 80000) to cover both thinking and text, not on
 * disabling thinking. Disabling it would discard the very capability we chose
 * k3 for. (`--thinking auto`, the CLI default, preserves this omitted-field
 * behaviour. bigmodel GLM endpoints default thinking ON and share max_tokens
 * between thinking and text — small explicit budgets can end up thinking-only;
 * --thinking off/on send explicit disabled/enabled for that case.)
 */
export function buildApiBody(
  req: Pick<
    ApiRequest,
    "model" | "maxTokens" | "prompt" | "stream" | "thinking"
  >,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.model,
    max_tokens: req.maxTokens,
    stream: req.stream,
    messages: [{ role: "user", content: req.prompt }],
  };
  if (req.thinking === "off") {
    body.thinking = { type: "disabled" };
  } else if (req.thinking === "on") {
    body.thinking = {
      type: "enabled",
      budget_tokens: Math.floor(req.maxTokens / 2),
    };
  }
  return body;
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
  return extractSseLineMeta(line).text;
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

/** What a single SSE `data:` line contributes to the stream aggregation. */
export interface SseLineMeta {
  /** Text fragment for content_block_delta/text_delta events, else null. */
  text: string | null;
  /** Characters contributed by a thinking_delta (thinking models spend the
   * shared max_tokens budget here before any text is emitted). */
  thinkingChars: number;
  /** stop_reason carried by a message_delta event (e.g. "max_tokens"). */
  stopReason?: string;
  /** True when the line was a `data:` payload that JSON-parsed (any event type). */
  parsed: boolean;
}

const SSE_LINE_EMPTY: SseLineMeta = {
  text: null,
  thinkingChars: 0,
  parsed: false,
};

/**
 * SSE line → structured meta (text delta + thinking volume + stop_reason).
 *
 * One JSON.parse per line feeding both the text aggregation and the "why did a
 * stream produce no text" diagnosis (thinking-only streams that end in
 * stop_reason=max_tokens are an endpoint budget issue, not a transport one).
 * Non-`data:` lines / malformed JSON → empty meta.
 */
export function extractSseLineMeta(line: string): SseLineMeta {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return SSE_LINE_EMPTY;
  const payload = trimmed.slice("data:".length).trim();
  if (!payload || payload === "[DONE]") return SSE_LINE_EMPTY;
  try {
    const evt = JSON.parse(payload) as {
      type?: string;
      delta?: {
        type?: string;
        text?: string;
        thinking?: string;
        stop_reason?: string;
      };
    };
    const meta: SseLineMeta = {
      text: null,
      thinkingChars: 0,
      parsed: true,
    };
    if (evt.type === "content_block_delta") {
      if (
        evt.delta?.type === "text_delta" &&
        typeof evt.delta.text === "string"
      ) {
        meta.text = evt.delta.text;
      } else if (
        evt.delta?.type === "thinking_delta" &&
        typeof evt.delta.thinking === "string"
      ) {
        meta.thinkingChars = evt.delta.thinking.length;
      }
    } else if (
      evt.type === "message_delta" &&
      typeof evt.delta?.stop_reason === "string"
    ) {
      meta.stopReason = evt.delta.stop_reason;
    }
    return meta;
  } catch {
    return SSE_LINE_EMPTY;
  }
}

/** Non-streaming body → why extractNonStreamText found no text. */
export interface NoTextBodyInfo {
  /** content block type names in order, comma-joined ("" = no content at all). */
  blocks: string;
  sawThinking: boolean;
  stopReason?: string;
}

/**
 * Inspect a 200 non-streaming messages body that yielded no text, so the error
 * can say WHY (thinking-only under a starved max_tokens budget vs an empty
 * content array from a flaky gateway — the former is deterministic, the latter
 * is worth retrying).
 */
export function describeNoTextBody(body: unknown): NoTextBodyInfo {
  const info: NoTextBodyInfo = { blocks: "", sawThinking: false };
  if (typeof body !== "object" || body === null) return info;
  const obj = body as {
    content?: unknown;
    stop_reason?: unknown;
  };
  if (typeof obj.stop_reason === "string") info.stopReason = obj.stop_reason;
  if (!Array.isArray(obj.content)) return info;
  const names: string[] = [];
  for (const block of obj.content) {
    if (typeof block === "object" && block !== null) {
      const type = (block as { type?: unknown }).type;
      if (typeof type === "string") {
        names.push(type);
        if (type === "thinking") info.sawThinking = true;
      }
    }
  }
  info.blocks = names.join(",");
  return info;
}

/** HTTP statuses worth an automatic retry (transient server/gateway trouble). */
export const API_RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

/** Parsed options for the hermes subcommand (strict: unknown flags error). */
export interface ParsedHermesArgs {
  /** Positional: provider name, or a reserved word (status/rollback). */
  provider?: string;
  model?: string;
  dryRun: boolean;
  verify: boolean;
  keepOnFail: boolean;
  help: boolean;
}

export type ParseHermesResult = ParsedHermesArgs | { error: string };

// ---------------------------------------------------------------------------
// hermes backend — pure helpers (unit-tested in cli.test.ts)
// ---------------------------------------------------------------------------

/**
 * Strip a trailing context-window marker like `[1M]` (a claude-agent
 * convention cc-switch stores in model names; raw APIs reject it).
 * Only a suffix anchored at the very end is removed.
 */
export function stripContextSuffix(model: string): string {
  return model.replace(/\[[^\]]*\]$/, "");
}

/** cc-switch 值入行级文件（.env/config.yaml）前的消毒：拒绝裸换行（防行注入）。 */
function containsLineBreak(value: string): boolean {
  return value.includes("\n") || value.includes("\r");
}

/**
 * Parse argv for `gcli hermes ...`. Strict like parseApiArgs (unknown flags
 * are exit-2 errors — there is no backend to forward to). `--no-verify` is
 * accepted via allowNegative. At most one positional.
 */
export function parseHermesArgs(argv: string[]): ParseHermesResult {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      options: {
        model: { type: "string" },
        "dry-run": { type: "boolean" },
        verify: { type: "boolean" },
        "keep-on-fail": { type: "boolean" },
        help: { type: "boolean" },
      },
      strict: true,
      allowPositionals: true,
      allowNegative: true,
    });
    if (positionals.length > 1) {
      return {
        error: `hermes: unexpected extra argument: "${positionals[1]}" (usage: gcli hermes <provider|status|rollback> [--model <m>] [--dry-run] [--no-verify] [--keep-on-fail])`,
      };
    }
    return {
      provider: positionals[0],
      model: typeof values.model === "string" ? values.model : undefined,
      dryRun: values["dry-run"] === true,
      verify: values.verify !== false,
      keepOnFail: values["keep-on-fail"] === true,
      help: values.help === true,
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Derive a hermes provider id from a cc-switch display name: lowercase,
 * non-[a-z0-9] runs folded to `-`, leading/trailing dashes trimmed.
 * May return "" for names with no alphanumerics (caller treats as error).
 */
export function deriveHermesId(ccName: string): string {
  return ccName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Derive the .env key name from a hermes provider id: UPPER + `_API_KEY`. */
export function deriveKeyEnv(id: string): string {
  return `${id.toUpperCase().replace(/-/g, "_")}_API_KEY`;
}

/** Safe YAML scalars are written bare; anything else is single-quoted. */
const SAFE_YAML_SCALAR_RE = /^[A-Za-z0-9._/:@-]+$/;

/** Quote a scalar for our line-level YAML writer ('' escapes a single quote). */
export function quoteYamlScalar(value: string): string {
  if (value === "") return "''";
  if (SAFE_YAML_SCALAR_RE.test(value)) return value;
  return `'${value.replace(/'/g, "''")}'`;
}

/** Inverse of quoteYamlScalar for reading (unescapes '' inside '...'). */
function unquoteYamlScalar(raw: string): string {
  const t = raw.trim();
  if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) {
    return t.slice(1, -1).replace(/''/g, "'");
  }
  return t;
}

/** col-0 bare section header, e.g. `model:` / `providers:` (nothing after `:`). */
const TOP_SECTION_RE = /^(\S[^:]*):\s*$/;

type SectionSpan = { key: string; headerLine: number; endLine: number };

/**
 * Where to insert new lines at a section's end: just before endLine, unless
 * the preceding element is the trailing-newline artifact (`"a\n".split("\n")
 * → ["a",""]`), in which case before that empty element — so an appended
 * block keeps the file's trailing newline and gains no stray blank line.
 */
function sectionInsertAt(lines: string[], span: SectionSpan): number {
  let at = span.endLine;
  while (at > span.headerLine + 1 && lines[at - 1] === "") at--;
  return at;
}

/**
 * Build the top-level section table: col-0 `key:` headers delimit sections;
 * any other col-0 line (a scalar like `timezone: Asia/Shanghai`) is still a
 * boundary. endLine is exclusive.
 */
function findTopLevelSections(lines: string[]): SectionSpan[] {
  const col0: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^\S/.test(lines[i])) col0.push(i);
  }
  const spans: SectionSpan[] = [];
  for (let j = 0; j < col0.length; j++) {
    const start = col0[j];
    const m = TOP_SECTION_RE.exec(lines[start]);
    if (m === null) continue;
    const end = j + 1 < col0.length ? col0[j + 1] : lines.length;
    spans.push({ key: m[1], headerLine: start, endLine: end });
  }
  return spans;
}

/**
 * Edit the top-level `model:` section (2-space `key: value` lines only):
 * replace the wanted keys in place; insert missing ones at the section end;
 * any unexpected structure (deeper nesting, a bare `key:` sub-section) is an
 * error — 宁报错不猜.
 */
function editModelSection(
  lines: string[],
  span: SectionSpan,
  model: HermesConfigEdit["model"],
): { lines: string[] } | { error: string } {
  const wanted: [string, string][] = [
    ["default", model.default],
    ["provider", model.provider],
    ["base_url", model.base_url],
  ];
  const out = [...lines];
  const found = new Set<string>();
  for (let i = span.headerLine + 1; i < span.endLine; i++) {
    const line = out[i];
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    // exactly 2-space indent, then `key: value`; a 4-space line (nested) or a
    // bare `key:` (sub-section) fails this match → structural error.
    const m = /^( {2})([^\s:#][^:]*?):(.+)$/.exec(line);
    if (m === null) {
      return {
        error: `config.yaml model 段第 ${i + 1} 行结构无法识别（意外嵌套？）: ${line.trim()}`,
      };
    }
    const key = m[2].trim();
    const w = wanted.find(([k]) => k === key);
    if (w !== undefined) {
      out[i] = `${m[1]}${key}: ${quoteYamlScalar(w[1])}`;
      found.add(key);
    }
  }
  const missing = wanted.filter(([k]) => !found.has(k));
  if (missing.length > 0) {
    out.splice(
      sectionInsertAt(out, span),
      0,
      ...missing.map(([k, v]) => `  ${k}: ${quoteYamlScalar(v)}`),
    );
  }
  return { lines: out };
}

/**
 * Edit the top-level `providers:` section: entries are 2-space `id:` blocks
 * with 4-space `key: value` fields. Upserts the wanted fields of the entry
 * `prov.id` (missing fields appended at the block end); appends a new block
 * at the section end when the id is absent. Any other shape → error.
 */
function editProvidersSection(
  lines: string[],
  span: SectionSpan,
  prov: HermesConfigEdit["provider"],
): { lines: string[] } | { error: string } {
  const wanted: [string, string][] = [
    ["name", prov.name],
    ["base_url", prov.base_url],
    ["transport", prov.transport],
    ["key_env", prov.key_env],
    ["default_model", prov.default_model],
  ];
  type Entry = { id: string; start: number; end: number };
  const entries: Entry[] = [];
  let cur: Entry | undefined;
  for (let i = span.headerLine + 1; i < span.endLine; i++) {
    const line = lines[i];
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const h = /^ {2}(\S[^:]*):\s*$/.exec(line);
    if (h !== null) {
      cur = { id: h[1], start: i, end: i + 1 };
      entries.push(cur);
      continue;
    }
    const f = /^ {4}\S[^:]*:/.exec(line);
    if (f !== null && cur !== undefined) {
      cur.end = i + 1;
      continue;
    }
    return {
      error: `config.yaml providers 段第 ${i + 1} 行结构无法识别（意外嵌套？）: ${line.trim()}`,
    };
  }
  const out = [...lines];
  const target = entries.find((e) => e.id === prov.id);
  if (target === undefined) {
    const block = [
      `  ${prov.id}:`,
      ...wanted.map(([k, v]) => `    ${k}: ${quoteYamlScalar(v)}`),
    ];
    out.splice(sectionInsertAt(out, span), 0, ...block);
    return { lines: out };
  }
  const found = new Set<string>();
  for (let i = target.start + 1; i < target.end; i++) {
    const line = out[i];
    const f = /^( {4})([^\s:#][^:]*?):/.exec(line);
    if (f === null) continue; // blank/comment line inside the block
    const key = f[2].trim();
    const w = wanted.find(([k]) => k === key);
    if (w !== undefined) {
      out[i] = `${f[1]}${key}: ${quoteYamlScalar(w[1])}`;
      found.add(key);
    }
  }
  const missing = wanted.filter(([k]) => !found.has(k));
  if (missing.length > 0) {
    out.splice(
      target.end,
      0,
      ...missing.map(([k, v]) => `    ${k}: ${quoteYamlScalar(v)}`),
    );
  }
  return { lines: out };
}

/**
 * Targeted line-level YAML editor for hermes' config.yaml (zero-dep: no yaml
 * lib guaranteed). Only the top-level `model:` (3 keys) and `providers:`
 * (one entry) sections are touched; everything else is byte-preserved.
 * Missing sections / unexpected nesting → {error}, never a guess (callers
 * must not write on error). Idempotent by construction.
 */
export function editHermesConfig(
  text: string,
  edit: HermesConfigEdit,
): { text: string } | { error: string } {
  const lines = text.split("\n");
  const modelSpan = findTopLevelSections(lines).find((s) => s.key === "model");
  if (modelSpan === undefined) {
    return { error: "config.yaml 缺少顶层 model: 段" };
  }
  const r1 = editModelSection(lines, modelSpan, edit.model);
  if ("error" in r1) return r1;
  const provSpan = findTopLevelSections(r1.lines).find(
    (s) => s.key === "providers",
  );
  if (provSpan === undefined) {
    return { error: "config.yaml 缺少顶层 providers: 段" };
  }
  const r2 = editProvidersSection(r1.lines, provSpan, edit.provider);
  if ("error" in r2) return r2;
  return { text: r2.lines.join("\n") };
}

/**
 * Read (not edit) the parts of config.yaml the hermes backend needs: the
 * current model section values and the list of providers entry ids.
 * Missing model: section or unparseable model lines → {error}.
 */
export function parseHermesConfig(
  text: string,
): { info: HermesConfigInfo } | { error: string } {
  const lines = text.split("\n");
  const sections = findTopLevelSections(lines);
  const modelSpan = sections.find((s) => s.key === "model");
  if (modelSpan === undefined) {
    return { error: "config.yaml 缺少顶层 model: 段" };
  }
  const model: HermesConfigInfo["model"] = {};
  for (let i = modelSpan.headerLine + 1; i < modelSpan.endLine; i++) {
    const line = lines[i];
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const m = /^ {2}([^\s:#][^:]*?):(.*)$/.exec(line);
    if (m === null) {
      return {
        error: `config.yaml model 段第 ${i + 1} 行结构无法识别: ${line.trim()}`,
      };
    }
    const key = m[1].trim();
    const val = unquoteYamlScalar(m[2]);
    if (key === "default") model.default = val;
    else if (key === "provider") model.provider = val;
    else if (key === "base_url") model.base_url = val;
  }
  const providerIds: string[] = [];
  const provSpan = sections.find((s) => s.key === "providers");
  if (provSpan !== undefined) {
    for (let i = provSpan.headerLine + 1; i < provSpan.endLine; i++) {
      const h = /^ {2}(\S[^:]*):\s*$/.exec(lines[i]);
      if (h !== null) providerIds.push(h[1]);
    }
  }
  return { info: { model, providerIds } };
}

/**
 * Upsert one `KEY=value` line in a .env text (pure). Only active lines
 * (`^KEY=`) match — commented-out occurrences are left alone; comments and
 * blank lines are byte-preserved. value=null deletes the line(s); a missing
 * key with a non-null value is appended at the end.
 */
export function upsertEnvLines(
  text: string,
  key: string,
  value: string | null,
): string {
  const lines = text.split("\n");
  const prefix = `${key}=`;
  let seen = false;
  const out: string[] = [];
  for (const line of lines) {
    if (line.startsWith(prefix)) {
      seen = true;
      if (value !== null) out.push(`${key}=${value}`);
      continue; // null → drop the line
    }
    out.push(line);
  }
  if (!seen && value !== null) {
    // keep a trailing newline trailing: insert before a final empty element
    if (out.length > 0 && out[out.length - 1] === "") {
      out.splice(out.length - 1, 0, `${key}=${value}`);
    } else {
      out.push(`${key}=${value}`);
    }
  }
  return out.join("\n");
}

/**
 * Plan cron re-pins: jobs that are enabled AND pinned to `oldProvider`
 * (jobs.json shape `{jobs: [...]}`, a bare array tolerated). Malformed input
 * yields an empty plan, never a throw.
 */
export function buildCronRepinPlan(
  jobsJson: unknown,
  oldProvider: string,
): CronRepinTarget[] {
  const jobs = Array.isArray(jobsJson)
    ? jobsJson
    : typeof jobsJson === "object" && jobsJson !== null
      ? (jobsJson as Record<string, unknown>).jobs
      : undefined;
  if (!Array.isArray(jobs)) return [];
  const out: CronRepinTarget[] = [];
  for (const j of jobs) {
    if (typeof j !== "object" || j === null) continue;
    const r = j as Record<string, unknown>;
    if (r.enabled !== true) continue;
    if (r.provider !== oldProvider) continue;
    if (typeof r.id !== "string" || r.id === "") continue;
    out.push({
      jobId: r.id,
      prevProvider: oldProvider,
      prevModel: typeof r.model === "string" && r.model !== "" ? r.model : null,
    });
  }
  return out;
}

/**
 * Parse the provider registry (`hermes-providers.json`). Corrupt/missing
 * content is best-effort → empty registry; entries lacking id/keyEnv are
 * dropped.
 */
export function parseHermesRegistry(text: string): HermesProviderRegistry {
  try {
    const raw: unknown = JSON.parse(text);
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return {};
    }
    const out: HermesProviderRegistry = {};
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v !== "object" || v === null) continue;
      const r = v as Record<string, unknown>;
      if (typeof r.id !== "string" || r.id === "") continue;
      if (typeof r.keyEnv !== "string" || r.keyEnv === "") continue;
      const entry: HermesProviderRegistryEntry = { id: r.id, keyEnv: r.keyEnv };
      if (typeof r.modelOverride === "string" && r.modelOverride !== "") {
        entry.modelOverride = r.modelOverride;
      }
      out[k] = entry;
    }
    return out;
  } catch {
    return {};
  }
}

export function serializeHermesRegistry(reg: HermesProviderRegistry): string {
  return `${JSON.stringify(reg, null, 2)}\n`;
}

function parseHermesModelPoint(v: unknown): HermesModelPoint | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const r = v as Record<string, unknown>;
  if (
    typeof r.id !== "string" ||
    typeof r.model !== "string" ||
    typeof r.base_url !== "string"
  ) {
    return undefined;
  }
  return { id: r.id, model: r.model, base_url: r.base_url };
}

/**
 * Parse `hermes-state.json` STRICTLY (畸形 → {error}，不猜): it carries the
 * previous token and the rollback plan, so a half-broken state must not be
 * acted on.
 */
export function parseHermesStateFile(
  text: string,
): { state: HermesStateFile } | { error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { error: "state 文件不是合法 JSON" };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { error: "state 文件根不是对象" };
  }
  const ls = (raw as Record<string, unknown>).lastSwitch;
  if (typeof ls !== "object" || ls === null || Array.isArray(ls)) {
    return { error: "state 缺少 lastSwitch 对象" };
  }
  const r = ls as Record<string, unknown>;
  const to = parseHermesModelPoint(r.to);
  const from = parseHermesModelPoint(r.from);
  if (to === undefined || from === undefined) {
    return { error: "state lastSwitch.to/from 畸形" };
  }
  if (
    typeof r.ts !== "number" ||
    typeof r.ccName !== "string" ||
    typeof r.configBackup !== "string"
  ) {
    return { error: "state lastSwitch 标量字段畸形" };
  }
  const env = r.env;
  if (typeof env !== "object" || env === null || Array.isArray(env)) {
    return { error: "state env 畸形" };
  }
  const e = env as Record<string, unknown>;
  if (
    typeof e.key !== "string" ||
    (e.prevValue !== null && typeof e.prevValue !== "string")
  ) {
    return { error: "state env 畸形" };
  }
  const cr = r.cronRepinned;
  if (!Array.isArray(cr)) {
    return { error: "state cronRepinned 畸形" };
  }
  const cronRepinned: CronRepinTarget[] = [];
  for (const c of cr) {
    if (typeof c !== "object" || c === null) {
      return { error: "state cronRepinned 条目畸形" };
    }
    const x = c as Record<string, unknown>;
    if (
      typeof x.jobId !== "string" ||
      typeof x.prevProvider !== "string" ||
      (x.prevModel !== null && typeof x.prevModel !== "string")
    ) {
      return { error: "state cronRepinned 条目畸形" };
    }
    cronRepinned.push({
      jobId: x.jobId,
      prevProvider: x.prevProvider,
      prevModel: x.prevModel,
    });
  }
  return {
    state: {
      lastSwitch: {
        ts: r.ts,
        ccName: r.ccName,
        to,
        from,
        configBackup: r.configBackup,
        env: { key: e.key, prevValue: e.prevValue },
        cronRepinned,
      },
    },
  };
}

export function serializeHermesStateFile(s: HermesStateFile): string {
  return `${JSON.stringify(s, null, 2)}\n`;
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
      if (!Number.isFinite(n) || n < 1000) {
        return {
          error: `--timeout must be a number >= 1000, got "${values.timeout}"`,
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
  /** `auto` (default) omits the thinking field; `off`/`on` send it explicitly. */
  thinking: "auto" | "off" | "on";
  /** Transient-failure retries (default 1; 0 disables). */
  retries: number;
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
        thinking: { type: "string" },
        retry: { type: "string" },
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
      if (!Number.isFinite(n) || n < 1) {
        return {
          error: `--max-tokens must be a finite number >= 1, got "${values["max-tokens"]}"`,
        };
      }
      maxTokens = n;
    }

    let timeoutMs = DEFAULT_TIMEOUT_MS;
    if (values.timeout !== undefined) {
      const n = Number(values.timeout);
      if (!Number.isFinite(n) || n < 1000) {
        return {
          error: `--timeout must be a number >= 1000, got "${values.timeout}"`,
        };
      }
      timeoutMs = n;
    }

    // thinking: auto (default, omit field — endpoint default, k3 keeps its
    // quality source) | off (disabled; avoids thinking-only responses on
    // budget-starved requests) | on (enabled, budget = max_tokens/2, hence
    // the >= 2048 floor).
    let thinking: "auto" | "off" | "on" = "auto";
    if (values.thinking !== undefined) {
      const t = values.thinking;
      if (t !== "auto" && t !== "off" && t !== "on") {
        return {
          error: `--thinking must be auto|off|on, got "${t}"`,
        };
      }
      thinking = t;
    }
    if (thinking === "on" && maxTokens < 2048) {
      return {
        error: `--thinking on needs --max-tokens >= 2048 (thinking budget = max_tokens/2 = ${Math.floor(maxTokens / 2)}), got ${maxTokens}`,
      };
    }

    let retries = 1;
    if (values.retry !== undefined) {
      const n = Number(values.retry);
      if (!Number.isInteger(n) || n < 0) {
        return {
          error: `--retry must be a non-negative integer, got "${values.retry}"`,
        };
      }
      retries = n;
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
      thinking,
      retries,
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
 * Unlike runAgy/runClaude: no timeout, no stdout/stderr capture —
 * the child owns the terminal. The child's exit code is passed
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

/** One HTTP attempt: the outcome plus a retry reason when transient, else false. */
interface ApiAttempt {
  outcome: RunOutcome;
  retryable: string | false;
}

const API_RETRY_BASE_DELAY_MS = 400;
const API_RETRY_MAX_DELAY_MS = 4000;

/**
 * Production deps.runApi: POST an anthropic-compatible /v1/messages request
 * and return a normalized RunOutcome.
 *
 * - stream=true: reads the SSE body chunk-by-chunk, decodes UTF-8, splits on
 *   newlines, and aggregates `text_delta` payloads into stdout. Two clocks
 *   guard against hangs: an idle timer (reset on EVERY received chunk —
 *   thinking models can emit long non-text stretches) and an absolute timer
 *   (timeoutMs). Either firing aborts the fetch via AbortController → exit 1
 *   with a timeout message.
 * - stream=false: awaits the full JSON body and extracts `content[].text`,
 *   returned as-is (no size cap — endpoint limits are the endpoint's call).
 *
 * TRANSIENT failures are retried automatically (default 1 retry, `--retry N`):
 * network-level fetch errors, HTTP 408/429/5xx, malformed JSON, empty-content
 * 200 bodies, and streams that die or deliver no SSE events at all. Each retry
 * note lands on stderr (stdout stays pipe-clean), so a recovered attempt still
 * leaves a trace. Deterministic failures are NOT retried — timeouts, 4xx, and
 * thinking-only responses (retrying cannot fix a max_tokens budget starved by
 * endpoint-default thinking); those errors carry a diagnosis instead.
 *
 * HTTP errors (non-2xx, network failure, abort) → exit 1 with diagnostics on
 * stderr; stdout stays empty so the caller's empty-output guard still works.
 */
export async function runApi(req: ApiRequest): Promise<RunOutcome> {
  const maxAttempts = Math.max(1, (req.retries ?? 0) + 1);
  const retryNotes: string[] = [];
  for (let attempt = 1; ; attempt++) {
    const res = await runApiAttempt(req);
    if (res.retryable === false || attempt >= maxAttempts) {
      if (retryNotes.length === 0) return res.outcome;
      return {
        ...res.outcome,
        stderr: [...retryNotes, res.outcome.stderr].join("\n"),
      };
    }
    const delayMs = Math.min(
      API_RETRY_MAX_DELAY_MS,
      API_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1),
    );
    retryNotes.push(
      `gcli: api attempt ${attempt}/${maxAttempts} failed (${res.retryable}); retrying in ${delayMs}ms`,
    );
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

/** A single fetch + body-consumption pass (fresh AbortController + timers). */
async function runApiAttempt(req: ApiRequest): Promise<ApiAttempt> {
  const controller = new AbortController();
  const { signal } = controller;

  // Two timers: absolute + idle. timeoutMs is both the hard ceiling and the
  // default idle budget — SSE streams that go quiet for that long are treated
  // as hung. We reset the idle clock whenever we receive any chunk.
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
  const timeoutOutcome = (): RunOutcome => ({
    exitCode: 1,
    stdout: "",
    stderr: `gcli: api timed out after ${req.timeoutMs}ms`,
  });

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
    if (timedOut) return { outcome: timeoutOutcome(), retryable: false };
    const msg = err instanceof Error ? err.message : String(err);
    return {
      outcome: {
        exitCode: 1,
        stdout: "",
        stderr: `gcli: api request failed: ${msg}`,
      },
      retryable: `fetch failed: ${msg}`.slice(0, 120),
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
      outcome: {
        exitCode: 1,
        stdout: "",
        stderr: `gcli: api returned HTTP ${response.status}${trimmed ? `: ${trimmed}` : ""}`,
      },
      retryable: API_RETRYABLE_STATUS.has(response.status)
        ? `HTTP ${response.status}`
        : false,
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
        outcome: {
          exitCode: 1,
          stdout: "",
          stderr: `gcli: api returned malformed JSON: ${msg}`,
        },
        retryable: "malformed JSON",
      };
    }
    // Some gateways answer 200 with an error envelope instead of a message.
    const errEnvelope = body as { type?: unknown; error?: unknown };
    if (errEnvelope.type === "error" || errEnvelope.error != null) {
      return {
        outcome: {
          exitCode: 1,
          stdout: "",
          stderr: `gcli: api returned an error body: ${JSON.stringify(body).slice(0, 500)}`,
        },
        retryable: false,
      };
    }
    const text = extractNonStreamText(body);
    if (!text) {
      const info = describeNoTextBody(body);
      if (!info.blocks) {
        // 200 with nothing usable in content — gateway hiccup, worth a retry.
        return {
          outcome: {
            exitCode: 1,
            stdout: "",
            stderr: "gcli: api returned no text content (empty content[])",
          },
          retryable: "empty content[]",
        };
      }
      return {
        outcome: {
          exitCode: 1,
          stdout: "",
          stderr:
            `gcli: api returned no text content (blocks=[${info.blocks}]` +
            `${info.stopReason ? `, stop_reason=${info.stopReason}` : ""})` +
            (info.sawThinking
              ? " — thinking consumed the whole max_tokens budget; raise --max-tokens or pass --thinking off"
              : ""),
        },
        // thinking-only is a deterministic budget outcome, not a flake
        retryable: false,
      };
    }
    return {
      outcome: { exitCode: 0, stdout: text, stderr: "" },
      retryable: false,
    };
  }

  // Streaming: aggregate text_delta chunks. response.body is a web stream;
  // TextDecoder handles multi-byte UTF-8 split across chunk boundaries, and a
  // leftover buffer carries the partial final line until the next newline.
  if (response.body === null) {
    clearTimers();
    return {
      outcome: {
        exitCode: 1,
        stdout: "",
        stderr: "gcli: api stream had no body",
      },
      retryable: "stream had no body",
    };
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let aggregated = "";
  let leftover = "";
  let sawEvent = false;
  let thinkingChars = 0;
  let stopReason: string | undefined;
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      // Any traffic proves the stream is alive — reset the idle clock on every
      // chunk, not only text-bearing ones (thinking models can emit long
      // non-text stretches before the first text_delta).
      resetIdle();
      leftover += decoder.decode(value, { stream: true });
      // SSE events are separated by newlines; process every complete line and
      // keep the trailing partial in `leftover`.
      const lines = leftover.split(/\r?\n/);
      leftover = lines.pop() ?? "";
      for (const line of lines) {
        const meta = extractSseLineMeta(line);
        if (meta.parsed) sawEvent = true;
        if (meta.text !== null) aggregated += meta.text;
        thinkingChars += meta.thinkingChars;
        if (meta.stopReason !== undefined) stopReason = meta.stopReason;
      }
    }
    // Flush any trailing line (some servers omit the final newline).
    const tail = decoder.decode();
    leftover += tail;
    if (leftover.length > 0) {
      const meta = extractSseLineMeta(leftover);
      if (meta.parsed) sawEvent = true;
      if (meta.text !== null) aggregated += meta.text;
      thinkingChars += meta.thinkingChars;
      if (meta.stopReason !== undefined) stopReason = meta.stopReason;
    }
  } catch (err) {
    clearTimers();
    if (timedOut) {
      // Timeout is a backend error (exit 1) per the contract, even when some
      // text was already received — callers must not treat a timed-out
      // response as success. Nothing has been emitted yet (stream output is
      // aggregated before printing), so a retry would also be safe — but a
      // request that already burned its whole time budget won't get one.
      return { outcome: timeoutOutcome(), retryable: false };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return {
      outcome: {
        exitCode: 1,
        stdout: "",
        stderr: `gcli: api stream read failed: ${msg}`,
      },
      retryable: `stream read failed: ${msg}`.slice(0, 120),
    };
  }
  clearTimers();

  if (!aggregated) {
    if (!sawEvent) {
      // Connection delivered no SSE events at all — transport-level flake.
      return {
        outcome: {
          exitCode: 1,
          stdout: "",
          stderr:
            "gcli: api stream produced no text (stream closed with no SSE events)",
        },
        retryable: "no SSE events",
      };
    }
    const detail =
      thinkingChars > 0
        ? ` (thinking ~${thinkingChars}ch${stopReason ? `, stop_reason=${stopReason}` : ""}) — thinking consumed the whole max_tokens budget; raise --max-tokens or pass --thinking off`
        : stopReason
          ? ` (stop_reason=${stopReason})`
          : "";
    return {
      outcome: {
        exitCode: 1,
        stdout: "",
        stderr: `gcli: api stream produced no text${detail}`,
      },
      retryable: false,
    };
  }
  return {
    outcome: { exitCode: 0, stdout: aggregated, stderr: "" },
    retryable: false,
  };
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

// Picker frame colors: 16-color structure + truecolor Sage accents (B2).
const DIM_ON = "\x1b[2m";
const INTENSITY_OFF = "\x1b[22m";
const CYAN = "\x1b[36m";
const BOLD_ON = "\x1b[1m";
const RESET_ALL = "\x1b[0m";
/** 选中行背景 #292e42（truecolor）。 */
const SELECTED_BG = "\x1b[48;2;41;46;66m";

const PICKER_TITLE_MAIN = "◆ gcli";
const PICKER_TITLE_SUB = " · 选择 provider";
const PICKER_HINT_KEYS = "↑↓/j/k 移动 · Enter 确认 · Esc 退出";
const PICKER_HINT_SKIP = "Esc 退出";
const PICKER_SEPARATOR = "─".repeat(50);
const NO_QUOTA_MARK = "—";

/**
 * 给 picker 实际持有的 quota 文本（`formatQuota` 输出格式，byte-locked）上
 * 色：`5h:P%`/`wk:P%` token 按各自 pct 染色，`↻rel` token 恒 dim。与
 * `colorQuota` 同一视觉，只是入参是已格式化文本（DI 契约里 entries.quota
 * 为 string，渲染层拿不到结构化窗口）。前提：pct 为整数——生产 parsers
 * 均 Math.floor 保证；异形 token 优雅退化为不染色。
 */
function colorQuotaText(text: string): string {
  return text
    .split(" ")
    .map((token) => {
      const win = /^(5h|wk):(\d+)%$/.exec(token);
      if (win !== null) {
        return `${levelColor(Number(win[2]))}${token}${FG_OFF}`;
      }
      if (token.startsWith("↻")) return `${DIM_ON}${token}${INTENSITY_OFF}`;
      return token;
    })
    .join(" ");
}

/**
 * One entry row: `❯ `/two-space prefix | name column (max name width + 2,
 * left-aligned) | colored quota (or dim — placeholder) | cyan `●<tag>`.
 * Selected rows add the truecolor background + a bold name and end with a
 * full reset; unselected rows keep the same structure without background.
 */
function pickerEntryRow(
  entry: PickerEntry,
  selected: boolean,
  nameWidth: number,
  noColor: boolean,
): string {
  const name = entry.name.padEnd(nameWidth);
  const quotaText =
    entry.quota !== undefined && entry.quota !== "" ? entry.quota : undefined;
  const quota =
    quotaText === undefined
      ? noColor
        ? NO_QUOTA_MARK
        : `${DIM_ON}${NO_QUOTA_MARK}${INTENSITY_OFF}`
      : noColor
        ? quotaText
        : colorQuotaText(quotaText);
  const tag =
    entry.tag !== undefined && entry.tag !== ""
      ? noColor
        ? ` ●${entry.tag}`
        : ` ${CYAN}●${entry.tag}${FG_OFF}`
      : "";
  if (noColor) {
    return `${selected ? "❯ " : "  "}${name}${quota}${tag}`;
  }
  return selected
    ? `${SELECTED_BG}${COLOR_SAGE}❯${FG_OFF} ${BOLD_ON}${name}${INTENSITY_OFF}${quota}${tag}${RESET_ALL}`
    : `  ${name}${quota}${tag}`;
}

/**
 * The full picker frame as plain lines: 标题 2 行 + dim 分隔线 + 条目 N 行 +
 * dim 末行提示 (`Esc 退出`, non-selectable — skip 只经 Esc/C-g（skip = 退出不启动）). Pure:
 * no I/O; with `noColor` (NO_COLOR downgrade) zero ANSI escapes — 仅纯文本
 * 排版，❯ 缩进 + 列对齐保留。Redraw cursor-up height = `entries.length + 4`.
 */
export function renderPickerRows(
  entries: PickerEntry[],
  selectedIndex: number,
  noColor: boolean,
): string[] {
  const nameWidth = entries.reduce((w, e) => Math.max(w, e.name.length), 0) + 2;
  const rows: string[] = [
    noColor
      ? `${PICKER_TITLE_MAIN}${PICKER_TITLE_SUB}`
      : `${CYAN}${BOLD_ON}${PICKER_TITLE_MAIN}${RESET_ALL}${PICKER_TITLE_SUB}`,
    noColor ? PICKER_HINT_KEYS : `${DIM_ON}${PICKER_HINT_KEYS}${INTENSITY_OFF}`,
    noColor ? PICKER_SEPARATOR : `${DIM_ON}${PICKER_SEPARATOR}${INTENSITY_OFF}`,
  ];
  for (let i = 0; i < entries.length; i++) {
    rows.push(
      pickerEntryRow(entries[i], i === selectedIndex, nameWidth, noColor),
    );
  }
  rows.push(
    noColor ? PICKER_HINT_SKIP : `${DIM_ON}${PICKER_HINT_SKIP}${INTENSITY_OFF}`,
  );
  return rows;
}

/**
 * Production deps.pickProvider: arrow-key menu rendered entirely on stderr
 * (stdout stays pipe-clean). ↑↓/j/k move with wrap, Enter confirms, Esc
 * skips, ctrl-c restores the terminal then exits 130; any other key is a
 * noop (C-P1). Frame = 标题 2 行 + 分隔线 + 条目 N 行 + dim `Esc 退出`
 * 末行提示——旧的可选中「不切换」行已退化为提示（skip 走 Esc/C-g），移动
 * 只覆盖条目行。
 *
 * Zero deps: `readline.emitKeypressEvents` + raw-mode stdin + hand-written
 * ANSI (16-color structure + truecolor Sage Limit 染色; `NO_COLOR` 非空 →
 * 全无色纯文本). Rows are redrawn in place (cursor-up + `\r` + clear-to-EOL
 * per line) so navigation leaves no ghosting (C-P3).
 *
 * Raw-mode lifecycle: `process.stdin.isRaw` is saved before
 * `setRawMode(true)` and restored on EVERY exit path (confirm / Esc / ctrl-c
 * / stream end / error) before the promise settles, and the keypress (and
 * its lazily-attached internal `data`) listeners are removed — so the
 * spawned claude TUI takes stdin over cleanly. The picker always completes
 * before any backend spawn.
 */
export function pickProviderInteractive(
  entries: PickerEntry[],
  initialIndex: number,
): Promise<PickerOutcome> {
  return new Promise((resolvePromise) => {
    const stderr = process.stderr;
    const stdin = process.stdin;
    const noColor = (process.env.NO_COLOR ?? "") !== "";
    const frameRows = entries.length + 4; // 标题2 + 分隔线1 + 条目N + 末行1
    let index = Math.min(
      Math.max(Math.trunc(initialIndex), 0),
      Math.max(entries.length - 1, 0),
    ); // clamp (D4)
    let settled = false;

    // Full repaint: pure row construction + per-line clear-to-EOL so a
    // shorter previous render leaves no ghosting (残影).
    const drawFrame = (): void => {
      for (const line of renderPickerRows(entries, index, noColor)) {
        stderr.write(`${line}\x1b[K\n`);
      }
    };
    // In-place redraw: the cursor sits just below the last row after each
    // draw, so move it back up over every frame line before repainting.
    const redraw = (): void => {
      stderr.write(`\x1b[${frameRows}A\r`);
      drawFrame();
    };

    // Raw-mode lifecycle (C-P3): save → raw → ... EVERY exit path restores.
    const wasRaw = stdin.isRaw === true;
    const dataListenersBefore = stdin.listeners("data") as (() => void)[];
    let onKeypress:
      | ((str: string, key: KeypressKey | undefined) => void)
      | undefined;
    let onGone: () => void = () => {};

    // 孤立 ESC 快速路径：emitKeypressEvents 不带 interface 参数时没有 escape
    // 消歧超时，真实终端按 Esc 发出的孤立 \x1b 会被状态机无限挂起（keypress
    // 永不发出）——实测 PTY 下 30s 无事件。因此监听 data 层：单字节 \x1b 且
    // 50ms 内无后续字节 → 视为 Esc 键 skip；有后续（箭头序列拆包等）→ 取消
    // 计时器交还 readline 正常解析。readline 的 name==="escape" 路径保留，
    // settled 守卫防双触发。
    let escTimer: ReturnType<typeof setTimeout> | undefined;
    const onDataFastEsc = (chunk: string | Buffer): void => {
      const s = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (s !== "\x1b") {
        if (escTimer !== undefined) {
          clearTimeout(escTimer);
          escTimer = undefined;
        }
        return;
      }
      if (escTimer !== undefined) clearTimeout(escTimer);
      escTimer = setTimeout(() => {
        escTimer = undefined;
        finish({ kind: "skip" });
      }, 50);
    };

    const cleanup = (): void => {
      if (onKeypress !== undefined) {
        stdin.removeListener("keypress", onKeypress);
      }
      if (escTimer !== undefined) {
        clearTimeout(escTimer);
        escTimer = undefined;
      }
      stdin.removeListener("data", onDataFastEsc);
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

    // Title + hint drawn once; entry rows below it get repainted (C-P7).
    drawFrame();

    emitKeypressEvents(stdin);
    onKeypress = (_str: string, key: KeypressKey | undefined): void => {
      try {
        if (key?.ctrl && key.name === "c") {
          // C-P1: restore the terminal FIRST, then take the SIGINT exit code.
          cleanup();
          process.exit(130);
        }
        if (key === undefined) return;
        // Movement covers entry rows only (the 末行提示 is not selectable).
        const action = applyPickerKey(key, index, entries.length);
        if (action.type === "move") {
          index = action.index;
          redraw();
        } else if (action.type === "confirm") {
          // index is always an entry row; the guard only matters for the
          // empty-list edge (nothing selectable → skip).
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
    stdin.on("data", onDataFastEsc);
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
// hermes backend — production deps implementations
// ---------------------------------------------------------------------------

/**
 * Production deps.runHermes: spawn `hermes <args>` with the same IO/timeout
 * contract as runClaude (pipe stdout/stderr, SIGTERM on timeout, no stdin
 * inheritance needed — cron edit / gateway / -z ping never read stdin).
 */
function runHermesProcess(
  args: string[],
  timeoutMs: number,
): Promise<SpawnResult> {
  return new Promise((resolveFn) => {
    const child = spawn(HERMES_BIN, args, {
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
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

/** Production deps.readTextFile: UTF-8 read; missing/unreadable → undefined. */
function readTextFileFromDisk(path: string): Promise<string | undefined> {
  return new Promise((resolvePromise) => {
    try {
      resolvePromise(readFileSync(path, "utf8"));
    } catch {
      resolvePromise(undefined);
    }
  });
}

/**
 * Production deps.writeTextFileAtomic: tmp + rename (atomic on POSIX).
 * mode 缺省时沿用目标文件现有权限，目标不存在则 0o600。Any failure →
 * {ok:false} (never throws); the tmp file is cleaned up best-effort.
 */
function writeTextFileAtomicToDisk(
  path: string,
  text: string,
  mode?: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  return new Promise((resolvePromise) => {
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
    try {
      let m = mode;
      if (m === undefined) {
        try {
          m = statSync(path).mode & 0o777;
        } catch {
          m = 0o600;
        }
      }
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(tmp, text, { encoding: "utf8", mode: m });
      renameSync(tmp, path);
      resolvePromise({ ok: true });
    } catch (err) {
      try {
        rmSync(tmp, { force: true });
      } catch {
        // best-effort cleanup
      }
      resolvePromise({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

/** Production deps.copyFile: full-file copy (backup / whole-file restore). */
function copyFileOnDisk(
  src: string,
  dest: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  return new Promise((resolvePromise) => {
    try {
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(src, dest);
      resolvePromise({ ok: true });
    } catch (err) {
      resolvePromise({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

/**
 * Production deps.queryLastSessionModel: sqlite3 -readonly -json against
 * HERMES_STATE_DB_PATH for the newest session_model_usage row (best-effort
 * verification; any failure → undefined). Same spawn skeleton as
 * readCcSwitchProvider.
 */
function queryLastSessionModelFromDb(): Promise<
  { model: string; provider: string } | undefined
> {
  return new Promise((resolvePromise) => {
    const sql =
      "SELECT model, billing_provider AS provider FROM session_model_usage ORDER BY last_seen DESC LIMIT 1";
    const child = spawn(
      "sqlite3",
      ["-readonly", "-json", HERMES_STATE_DB_PATH, sql],
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.on("error", () => resolvePromise(undefined));
    child.on("close", (code) => {
      if (code !== 0) {
        resolvePromise(undefined);
        return;
      }
      try {
        const parsed: unknown = JSON.parse(stdout.trim() || "[]");
        if (!Array.isArray(parsed) || parsed.length === 0) {
          resolvePromise(undefined);
          return;
        }
        const row = parsed[0] as Record<string, unknown>;
        if (typeof row.model !== "string" || typeof row.provider !== "string") {
          resolvePromise(undefined);
          return;
        }
        resolvePromise({ model: row.model, provider: row.provider });
      } catch {
        resolvePromise(undefined);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const HELP = `Usage:
  gcli [claude] [options] [-- <args>]  wrap the claude CLI (default backend)
  gcli agy [options] [-- <args>]       wrap the agy CLI (explicit subcommand)
  gcli api [options]                   call an anthropic-compatible messages API
  gcli hermes <provider|status|rollback> [options]  hermes agent 主模型一键切换

gcli sits in front of three backends and gives skills a stable entry point:
a hard timeout, explicit exit codes, and stdin piping (\`-p -\`). Output is
passed through unmodified — size limits are the endpoint's business.

Without -p, the agy/claude backends launch their interactive TUI (inherited
stdio; no timeout; the child's exit code is passed through).
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
      --timeout <ms>      Hard timeout in ms (default 300000)
      --version           Print the agy version
      --help              Show this help
      -- <args...>        Pass remaining args through to agy verbatim

claude backend (default; bare \`gcli ...\` === \`gcli claude ...\`):
  -p, --prompt <text|->   Prompt text, "-" for stdin; omit for interactive TUI
      --provider <name>   cc-switch provider (matched by exact/case/substring)
      --pick              Force the provider picker menu, even in print mode
      --model <name>      Override ANTHROPIC_MODEL in the provider env
      --cwd <dir>         Working directory (added via claude --add-dir)
      --timeout <ms>      Hard timeout in ms (default 300000)
      --version           Print the claude version
      --help              Show this help
      -- <args...>        Pass remaining args through to claude verbatim

  Notes:
    - --provider switches via \`claude -p ... --settings {'env':{...}}\`; it
      does NOT rewrite ~/.claude/settings.json.
    - No --provider in a TTY: gcli lists all cc-switch providers (in
      cc-switch's own DB order) in an arrow-key picker (↑↓/j/k and Emacs
      C-n/C-p move · Enter 确认 · Esc/C-g = 退出（不启动 claude）;
      M-</M-> jump to first/last; ctrl-c exits 130). In print mode
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
      --max-tokens <n>    Output token budget (default 80000; upper bound is
                          whatever the endpoint accepts)
      --timeout <ms>      Idle + absolute timeout in ms (default 300000)
      --stream|--no-stream  Stream SSE and aggregate live (default stream)
      --thinking <mode>   auto|off|on (default auto = omit the thinking field,
                          endpoint default applies; off sends disabled; on
                          sends enabled with budget = max_tokens/2, needs
                          --max-tokens >= 2048)
      --retry <n>         Auto retries for transient failures: network errors,
                          HTTP 408/429/5xx, malformed JSON, empty content
                          (default 1; exponential backoff 400ms..4s)
      --version           Print the api backend identity
      --help              Show this help

  Notes:
    - No --cwd (no file operations; supplied --cwd is warned + ignored).
    - --yolo/--sandbox are rejected (they are agent flags; api has no agent).
    - Unknown flags exit 2 (strict; nothing to forward to).
    - thinking auto keeps the endpoint's own default. Beware bigmodel GLM
      endpoints: thinking defaults ON there and shares the max_tokens budget
      with text, so a small explicit budget can yield a thinking-only response
      ("no text content ... blocks=[thinking], stop_reason=max_tokens").
      Fix: raise --max-tokens or pass --thinking off (k3 quality workflows:
      keep auto/on + a generous budget). Deterministic failures are never
      retried; transient ones (network/408/429/5xx/empty body) are, with each
      attempt noted on stderr.

hermes backend (\`gcli hermes ...\`) — hermes agent 主模型/provider 一键切换:
  <provider>            cc-switch provider 名（exact/case/substring 三层匹配）;
                        TTY 下省略则弹出选择菜单；非 TTY 省略 → exit 2 零交互
  status                当前 model 段 + .env key 存在性 + 上次切换记录
  rollback              切回上一个 provider（from/to 互换写回，支持来回 toggle）
      --model <name>    覆盖模型名（自动剥 [1M] 后缀），并持久化进 registry
      --dry-run         只输出计划：零写入零 spawn（.env 行显示 KEY=<redacted>）
      --no-verify       跳过切换后的 hermes -z ping 验证
      --keep-on-fail    验证/网关失败时不自动回滚（默认自动回滚）

  Notes:
    - 切换流程 = 备份 config.yaml → 改 model/providers 段（原子写）→ .env
      upsert key（0o600）→ cron 重 pin（仅 enabled 且 pin 在旧 provider 的
      job，单条失败 warn 继续）→ 重启网关 → hermes -z ping 验证（60s 硬门槛）
      + state.db session_model_usage best-effort 比对。
    - 验证或网关失败默认自动回滚整链路（config/.env/cron pin/网关）。
    - 备份命名 config.yaml.bak-before-<id>-<epoch>，写入均 tmp+rename 原子写。
    - registry: ~/.config/gcli/hermes-providers.json（cc-switch 名 → id/keyEnv
      /modelOverride）；state: ~/.config/gcli/hermes-state.json（0o600，含旧
      token 的 prevValue 供 rollback）。
    - 输出红线：任何 stdout/stderr/dry-run 计划只打印 key 名，永不打印 token 值。
    - 绝不修改 ~/.claude/settings.json 与 cc-switch.db（后者只读）。
    - config.yaml 结构不认识（缺 model:/providers: 段、意外嵌套）→ 报错零写盘。

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
      stderr: `gcli: ${backend} failed (exit ${result.exitCode})\n${errInfo}`,
    };
  }
  if (!out) {
    const info = result.stderr.trim()
      ? `stderr: ${result.stderr}`
      : "no output";
    return {
      exitCode: 1,
      stdout: "",
      stderr: `gcli: ${backend} returned ${info}`,
    };
  }
  return { exitCode: 0, stdout: out, stderr: "" };
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
  let pickerSkipped = false;
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
          // the remembered row carries its ●上次 marker as a structured tag
          // (rendering decides placement/color; quota text stays byte-clean).
          const entries: PickerEntry[] = ordered.map((p) => {
            const entry: PickerEntry = {
              name: p.name,
              quota: quotaMap.get(p.name),
            };
            if (remembered !== undefined && p.name === remembered) {
              entry.tag = "上次";
            }
            return entry;
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
          } else {
            pickerSkipped = true; // Esc/C-g → 退出，不启动 claude
          }
          // skip 语义（2026-09 用户裁定）：退出。memory untouched.
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

  // Esc/C-g skip = 退出（2026-09 用户裁定，替代旧「不切换照常启动」语义）：
  // 不 spawn 任何后端，干净退出 exit 0。stderr 提示确认动作已被感知。
  if (pickerSkipped) {
    return withPickerWarning({
      exitCode: 0,
      stdout: "",
      stderr: "gcli: 已退出（未启动 claude）",
    });
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
  const resolvedModel =
    rawModel === undefined ? undefined : stripContextSuffix(rawModel);
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
    // auto = omit the thinking field entirely (endpoint default)
    thinking: parsed.thinking === "auto" ? undefined : parsed.thinking,
    retries: parsed.retries,
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

// ---------------------------------------------------------------------------
// hermes backend — orchestration (status / rollback / switch)
// ---------------------------------------------------------------------------

const HERMES_USAGE =
  "gcli hermes <provider|status|rollback> [--model <m>] [--dry-run] [--no-verify] [--keep-on-fail]";

function hermesFail(exitCode: number, stderr: string): RunOutcome {
  return { exitCode, stdout: "", stderr };
}

/** Read the active (uncommented) value of KEY from a .env text, or null. */
function envValueOf(envText: string, key: string): string | null {
  const prefix = `${key}=`;
  for (const line of envText.split("\n")) {
    if (line.startsWith(prefix)) return line.slice(prefix.length);
  }
  return null;
}

/**
 * `gcli hermes status`：当前 model 段 + .env key 存在性 + 上次切换记录。
 * 无切换历史时优雅显示（exit 0）。config 不可读/不可解析 → exit 1。
 */
async function hermesStatus(deps: RunDeps): Promise<RunOutcome> {
  const configText = await deps.readTextFile(HERMES_CONFIG_PATH);
  if (configText === undefined) {
    return hermesFail(1, "gcli: hermes: 无法读取 ~/.hermes/config.yaml");
  }
  const info = parseHermesConfig(configText);
  if ("error" in info) {
    return hermesFail(1, `gcli: hermes: ${info.error}`);
  }
  const provider = info.info.model.provider ?? "(unset)";
  const model = info.info.model.default ?? "(unset)";
  const baseUrl = info.info.model.base_url ?? "(unset)";

  // .env key 存在性：按当前 provider id 反查 registry/seed 的 keyEnv
  const regText = await deps.readTextFile(HERMES_PROVIDERS_REGISTRY_PATH);
  const registry = regText === undefined ? {} : parseHermesRegistry(regText);
  const known = [
    ...Object.values(registry),
    ...Object.values(HERMES_PROVIDER_SEEDS),
  ];
  const entry = known.find((e) => e.id === provider);
  let envLine = "env_key: unknown（provider 不在 registry/seed 中）";
  if (entry !== undefined) {
    const envText = await deps.readTextFile(HERMES_ENV_PATH);
    const present =
      envText !== undefined && envValueOf(envText, entry.keyEnv) !== null;
    envLine = `env_key: ${entry.keyEnv} ${present ? "present" : "missing"}`;
  }

  let lastLine = "last_switch: none";
  const stateText = await deps.readTextFile(HERMES_STATE_PATH);
  if (stateText !== undefined) {
    const st = parseHermesStateFile(stateText);
    if ("state" in st) {
      const s = st.state.lastSwitch;
      lastLine = `last_switch: ${s.from.id} -> ${s.to.id}（${s.from.model} -> ${s.to.model}）@ ${new Date(s.ts).toISOString()}`;
    } else {
      lastLine = "last_switch: (state file malformed)";
    }
  }

  return {
    exitCode: 0,
    stdout: [
      `provider: ${provider}`,
      `model: ${model}`,
      `base_url: ${baseUrl}`,
      envLine,
      lastLine,
    ].join("\n"),
    stderr: "",
  };
}

type HermesRollbackExec = {
  /** config+env 已恢复、网关已起、验证通过（verify=false 时不含验证）。 */
  ok: boolean;
  /** 回滚前对现状 config 的快照（toggle 的下一站备份）；快照失败则缺失。 */
  snapshotPath?: string;
  /** 回滚前 .env 里该 key 的值（toggle 写回用）。 */
  currentEnvValue: string | null;
};

/**
 * 回滚执行体（rollback 命令与切换失败自动回滚共用）：
 * 快照现状 config → copyFile 整文件恢复 → .env 回写/删行 → cron 逐条回放旧
 * pin（单条失败 warn 继续）→ 网关重启（stop 失败仅 warn，start 失败=失败）→
 * ping 验证（可选）。全程不 throw。
 */
async function performHermesRollback(
  s: HermesStateFile["lastSwitch"],
  deps: RunDeps,
  verify: boolean,
  logs: string[],
): Promise<HermesRollbackExec> {
  let ok = true;
  let snapshotPath: string | undefined;
  const snap = `${HERMES_CONFIG_PATH}.bak-before-${s.from.id}-${Math.floor(Date.now() / 1000)}`;
  const snapR = await deps.copyFile(HERMES_CONFIG_PATH, snap);
  if (snapR.ok) {
    snapshotPath = snap;
  } else {
    logs.push(
      `gcli: hermes: rollback: warn: 现状快照失败（toggle 将不可用）: ${snapR.error}`,
    );
  }
  const envText = (await deps.readTextFile(HERMES_ENV_PATH)) ?? "";
  const currentEnvValue = envValueOf(envText, s.env.key);

  const rc = await deps.copyFile(s.configBackup, HERMES_CONFIG_PATH);
  if (!rc.ok) {
    logs.push(
      `gcli: hermes: rollback: 备份恢复失败（${s.configBackup}）: ${rc.error}`,
    );
    return { ok: false, snapshotPath, currentEnvValue };
  }
  logs.push("gcli: hermes: rollback: config.yaml 已整文件恢复");

  const we = await deps.writeTextFileAtomic(
    HERMES_ENV_PATH,
    upsertEnvLines(envText, s.env.key, s.env.prevValue),
    0o600,
  );
  if (!we.ok) {
    logs.push(`gcli: hermes: rollback: .env 回写失败: ${we.error}`);
    ok = false;
  } else {
    logs.push(`gcli: hermes: rollback: .env 已回写 ${s.env.key}`);
  }

  for (const c of s.cronRepinned) {
    const args = ["cron", "edit", c.jobId, "--provider", c.prevProvider];
    if (c.prevModel !== null) args.push("--model", c.prevModel);
    const r = await deps.runHermes(args, DEFAULT_TIMEOUT_MS);
    if (r.exitCode !== 0) {
      logs.push(
        `gcli: hermes: rollback: warn: cron edit ${c.jobId} 回放失败（继续）: ${(r.stderr || r.stdout).trim().slice(0, 200)}`,
      );
    } else {
      logs.push(
        `gcli: hermes: rollback: cron ${c.jobId} 已回 pin → ${c.prevProvider}`,
      );
    }
  }

  const gst = await deps.runHermes(["gateway", "stop"], DEFAULT_TIMEOUT_MS);
  if (gst.exitCode !== 0) {
    logs.push(
      "gcli: hermes: rollback: warn: gateway stop 非零退出（网关可能本就没跑），继续 start",
    );
  }
  const gsa = await deps.runHermes(["gateway", "start"], DEFAULT_TIMEOUT_MS);
  if (gsa.exitCode !== 0) {
    logs.push(
      `gcli: hermes: rollback: gateway start 失败: ${(gsa.stderr || gsa.stdout).trim().slice(0, 300)}`,
    );
    ok = false;
  } else {
    logs.push("gcli: hermes: rollback: 网关已重启");
  }

  if (verify) {
    const ping = await deps.runHermes(["-z", "ping"], HERMES_VERIFY_TIMEOUT_MS);
    if (ping.timedOut === true || ping.exitCode !== 0) {
      logs.push("gcli: hermes: rollback: 回滚后验证 ping 未通过");
      ok = false;
    } else {
      logs.push("gcli: hermes: rollback: 验证 ping 通过");
    }
  }
  return { ok, snapshotPath, currentEnvValue };
}

/** `gcli hermes rollback`：无 state → exit 1；畸形 → exit 1（不猜）。 */
async function hermesRollback(
  parsed: ParsedHermesArgs,
  deps: RunDeps,
): Promise<RunOutcome> {
  const stateText = await deps.readTextFile(HERMES_STATE_PATH);
  if (stateText === undefined) {
    return hermesFail(
      1,
      "gcli: hermes: 无可回滚的切换历史 / no switch history to roll back",
    );
  }
  const st = parseHermesStateFile(stateText);
  if ("error" in st) {
    return hermesFail(
      1,
      `gcli: hermes: state 文件畸形，拒绝回滚（不猜）: ${st.error}`,
    );
  }
  const s = st.state.lastSwitch;
  const logs: string[] = [
    `gcli: hermes: 回滚 ${s.to.id}（${s.to.model}）-> ${s.from.id}（${s.from.model}）…`,
  ];
  const r = await performHermesRollback(s, deps, parsed.verify, logs);
  if (!r.ok || r.snapshotPath === undefined) {
    logs.push("gcli: hermes: 回滚未完全成功（详见上方日志）");
    return { exitCode: 1, stdout: "", stderr: logs.join("\n") };
  }
  // toggle：from/to 互换写回；configBackup 指向本次快照（= 旧 to 的配置）。
  const swapped: HermesStateFile = {
    lastSwitch: {
      ts: Date.now(),
      ccName: s.ccName,
      to: s.from,
      from: s.to,
      configBackup: r.snapshotPath,
      env: { key: s.env.key, prevValue: r.currentEnvValue },
      cronRepinned: s.cronRepinned,
    },
  };
  const ws = await deps.writeTextFileAtomic(
    HERMES_STATE_PATH,
    serializeHermesStateFile(swapped),
    0o600,
  );
  if (!ws.ok) {
    logs.push(
      `gcli: hermes: warn: state 写回失败（toggle 将不可用）: ${ws.error}`,
    );
  }
  logs.push(`gcli: hermes: 回滚完成，当前 ${s.from.id} / ${s.from.model}`);
  return { exitCode: 0, stdout: "", stderr: logs.join("\n") };
}

/**
 * `gcli hermes <provider>` 一键切换（设计文档流程 0-9）。所有失败 resolve
 * RunOutcome，禁止 throw。进度/诊断全走 stderr；stdout 仅 dry-run 计划。
 * token 红线：任何输出只打印 key 名，token 值永不出现。
 */
async function hermesSwitch(
  parsed: ParsedHermesArgs,
  deps: RunDeps,
): Promise<RunOutcome> {
  const logs: string[] = [];

  // 0. 目标 provider 名：位置参数，或 TTY picker；非 TTY 缺参 → exit 2 零交互
  let ccQuery = parsed.provider;
  if (ccQuery === undefined) {
    if (!deps.isInteractive()) {
      return hermesFail(
        2,
        `gcli: hermes 需要 provider 位置参数（或保留字 status/rollback）；非 TTY 下零交互。\nusage: ${HERMES_USAGE}`,
      );
    }
    const lookup0 = await deps.readCcSwitchProvider();
    if (!lookup0.ok) {
      return hermesFail(1, `gcli: hermes: ${lookup0.message}`);
    }
    if (lookup0.providers.length === 0) {
      return hermesFail(1, "gcli: hermes: no cc-switch providers configured");
    }
    const picked = await deps.pickProvider(
      lookup0.providers.map((p) => ({ name: p.name })),
      0,
    );
    if (picked.kind === "skip") {
      return {
        exitCode: 0,
        stdout: "",
        stderr: "gcli: hermes: 已取消，未切换",
      };
    }
    ccQuery = picked.entry.name;
  }

  // 1. cc-switch 取 provider（复用三层匹配）
  const lookup = await deps.readCcSwitchProvider();
  if (!lookup.ok) {
    return hermesFail(1, `gcli: hermes: ${lookup.message}`);
  }
  const match = matchProviderName(
    ccQuery,
    lookup.providers.map((p) => p.name),
  );
  if ("none" in match) {
    return hermesFail(
      2,
      `gcli: hermes: provider not found / 未知 provider: ${ccQuery}`,
    );
  }
  if ("ambiguous" in match) {
    const candidates = match.ambiguous
      .map((n) => `"${n}"`)
      .sort()
      .join(", ");
    return hermesFail(2, `gcli: hermes: ambiguous provider: ${candidates}`);
  }
  const ccName = match.matched;
  const target = lookup.providers.find((p) => p.name === ccName);
  if (target === undefined) {
    return hermesFail(2, `gcli: hermes: provider not found: ${ccQuery}`);
  }
  const cfgJson =
    typeof target.settingsConfig === "string"
      ? target.settingsConfig
      : JSON.stringify(target.settingsConfig);
  const envResult = extractProviderEnv(cfgJson);
  if ("error" in envResult) {
    return hermesFail(1, `gcli: hermes: ${envResult.error}`);
  }
  const penv = envResult.env;
  const baseUrl = penv.ANTHROPIC_BASE_URL;
  const token = penv.ANTHROPIC_AUTH_TOKEN ?? penv.ANTHROPIC_API_KEY;
  if (baseUrl === undefined || baseUrl === "") {
    return hermesFail(
      1,
      "gcli: hermes: provider env is missing ANTHROPIC_BASE_URL",
    );
  }
  if (token === undefined || token === "") {
    return hermesFail(
      1,
      "gcli: hermes: provider env is missing ANTHROPIC_AUTH_TOKEN（无 token）",
    );
  }
  // 换行消毒：cc-switch 值将写入行级文件（.env/config.yaml），裸换行会破坏行结构
  for (const [label, value] of [
    ["name", ccName],
    ["ANTHROPIC_BASE_URL", baseUrl],
    ["token", token],
  ] as const) {
    if (containsLineBreak(value)) {
      return hermesFail(
        1,
        `gcli: hermes: cc-switch provider ${label} 含裸换行，拒绝写入（宁报错不猜）`,
      );
    }
  }

  // 2. 读现状（= rollback 的 from）并验证结构
  const configText = await deps.readTextFile(HERMES_CONFIG_PATH);
  if (configText === undefined) {
    return hermesFail(1, "gcli: hermes: 无法读取 ~/.hermes/config.yaml");
  }
  const info = parseHermesConfig(configText);
  if ("error" in info) {
    return hermesFail(
      1,
      `gcli: hermes: ${info.error} —— 无法安全解析 config.yaml，拒绝写入`,
    );
  }
  const fromId = info.info.model.provider ?? "";
  const fromModel = info.info.model.default ?? "";
  if (fromId === "" || fromModel === "") {
    return hermesFail(
      1,
      "gcli: hermes: config.yaml model 段缺 provider/default，拒绝写入",
    );
  }
  const from: HermesModelPoint = {
    id: fromId,
    model: fromModel,
    base_url: info.info.model.base_url ?? "",
  };

  // 3. registry 解析 hermes 字段（文件 → seed → 推导+写回）
  const regText = await deps.readTextFile(HERMES_PROVIDERS_REGISTRY_PATH);
  const registry: HermesProviderRegistry =
    regText === undefined ? {} : parseHermesRegistry(regText);
  let entry = registry[ccName] ?? HERMES_PROVIDER_SEEDS[ccName];
  let registryDirty = false;
  if (entry === undefined) {
    const id = deriveHermesId(ccName);
    if (id === "") {
      return hermesFail(1, `gcli: hermes: 无法从 "${ccName}" 推导 provider id`);
    }
    if (info.info.providerIds.includes(id)) {
      return hermesFail(
        1,
        `gcli: hermes: 推导 id "${id}" 与 config.yaml 已有 providers 条目冲突，拒绝覆盖；请在 ${HERMES_PROVIDERS_REGISTRY_PATH} 手工登记`,
      );
    }
    entry = { id, keyEnv: deriveKeyEnv(id) };
    registry[ccName] = entry;
    registryDirty = true;
  }

  // 4. 模型名推导：--model > registry modelOverride > cc-switch（剥 [1M] 后缀）
  const ccModel =
    penv.ANTHROPIC_MODEL !== undefined
      ? stripContextSuffix(penv.ANTHROPIC_MODEL)
      : undefined;
  if (parsed.model !== undefined) {
    // --model 持久化进 registry 的 modelOverride
    entry = { ...entry, modelOverride: parsed.model };
    registry[ccName] = entry;
    registryDirty = true;
  }
  const model = parsed.model ?? entry.modelOverride ?? ccModel;
  if (model === undefined || model === "") {
    return hermesFail(
      1,
      "gcli: hermes: no model resolved（cc-switch 无 ANTHROPIC_MODEL，可用 --model 指定）",
    );
  }
  if (containsLineBreak(model)) {
    return hermesFail(
      1,
      "gcli: hermes: 模型名含裸换行，拒绝写入（宁报错不猜）",
    );
  }
  const to: HermesModelPoint = { id: entry.id, model, base_url: baseUrl };

  // 5. 构造编辑（纯函数；结构异常 → 报错零写盘）
  const edit: HermesConfigEdit = {
    model: { default: model, provider: to.id, base_url: baseUrl },
    provider: {
      id: to.id,
      name: ccName,
      base_url: baseUrl,
      transport: HERMES_TRANSPORT,
      key_env: entry.keyEnv,
      default_model: model,
    },
  };
  const edited = editHermesConfig(configText, edit);
  if ("error" in edited) {
    return hermesFail(
      1,
      `gcli: hermes: ${edited.error} —— 无法安全识别 config.yaml 结构，拒绝写入 / refusing to write`,
    );
  }

  // cron 重 pin 计划（读 jobs.json；读不到/畸形 → warn 跳过，不阻塞）
  let cronPlan: CronRepinTarget[] = [];
  let cronWarn: string | undefined;
  const jobsText = await deps.readTextFile(HERMES_CRON_JOBS_PATH);
  if (jobsText === undefined) {
    cronWarn = "无法读取 cron jobs.json，跳过重 pin";
  } else {
    try {
      cronPlan = buildCronRepinPlan(JSON.parse(jobsText), from.id);
    } catch {
      cronWarn = "cron jobs.json 不是合法 JSON，跳过重 pin";
    }
  }

  // 6. dry-run：输出计划，零写入零 spawn（备份路径仅为预告）
  const backupPath = `${HERMES_CONFIG_PATH}.bak-before-${to.id}-${Math.floor(Date.now() / 1000)}`;
  if (parsed.dryRun) {
    const planLines = [
      "gcli hermes 切换计划（dry-run，未做任何写入）:",
      `  provider: ${to.id}（cc-switch: ${ccName}）`,
      `  model: ${model}`,
      `  base_url: ${baseUrl}`,
      `  backup: ${backupPath}`,
      `  config.yaml: model.default=${model} model.provider=${to.id} model.base_url=${baseUrl}; providers upsert ${to.id}`,
      `  .env: upsert ${entry.keyEnv}=<redacted>`,
      `  cron: repin ${cronPlan.length} job(s) ${from.id} -> ${to.id}${cronPlan.length > 0 ? `（${cronPlan.map((c) => c.jobId).join(", ")}）` : ""}`,
      "  gateway: hermes gateway stop && hermes gateway start",
      `  verify: ${parsed.verify ? `hermes -z ping（${HERMES_VERIFY_TIMEOUT_MS}ms 超时）+ state.db best-effort 比对` : "已跳过（--no-verify）"}`,
    ];
    if (cronWarn !== undefined) planLines.push(`  warn: ${cronWarn}`);
    return { exitCode: 0, stdout: planLines.join("\n"), stderr: "" };
  }

  // 7. registry 写回（推导/modelOverride 持久化；best-effort）
  if (registryDirty) {
    const w = await deps.writeTextFileAtomic(
      HERMES_PROVIDERS_REGISTRY_PATH,
      serializeHermesRegistry(registry),
    );
    if (!w.ok) {
      logs.push(
        `gcli: hermes: warn: registry 写回失败（不影响本次切换）: ${w.error}`,
      );
    }
  }

  // 8. 备份先行 → 原子写 config
  const bak = await deps.copyFile(HERMES_CONFIG_PATH, backupPath);
  if (!bak.ok) {
    return hermesFail(
      1,
      `gcli: hermes: 备份失败，中止切换（未写入任何内容）: ${bak.error}`,
    );
  }
  logs.push(`gcli: hermes: 已备份 config.yaml → ${backupPath}`);
  const wc = await deps.writeTextFileAtomic(HERMES_CONFIG_PATH, edited.text);
  if (!wc.ok) {
    return hermesFail(
      1,
      `gcli: hermes: config.yaml 写入失败（备份在 ${backupPath}）: ${wc.error}`,
    );
  }
  logs.push(`gcli: hermes: config.yaml 已切换到 ${to.id} / ${model}`);

  // 9. .env upsert（保持 0o600；失败则从备份恢复 config 避免半切换态）
  const envText = (await deps.readTextFile(HERMES_ENV_PATH)) ?? "";
  const prevValue = envValueOf(envText, entry.keyEnv);
  const we = await deps.writeTextFileAtomic(
    HERMES_ENV_PATH,
    upsertEnvLines(envText, entry.keyEnv, token),
    0o600,
  );
  if (!we.ok) {
    await deps.copyFile(backupPath, HERMES_CONFIG_PATH);
    return hermesFail(
      1,
      `gcli: hermes: .env 写入失败，已从备份恢复 config.yaml: ${we.error}`,
    );
  }
  logs.push(`gcli: hermes: .env 已 upsert ${entry.keyEnv}=<redacted>`);

  // 10. cron 重 pin（单条失败 warn 继续，不触发回滚）
  const cronRepinned: CronRepinTarget[] = [];
  if (cronWarn !== undefined) {
    logs.push(`gcli: hermes: warn: ${cronWarn}`);
  }
  for (const c of cronPlan) {
    cronRepinned.push(c);
    const r = await deps.runHermes(
      ["cron", "edit", c.jobId, "--provider", to.id, "--model", model],
      DEFAULT_TIMEOUT_MS,
    );
    if (r.exitCode !== 0) {
      logs.push(
        `gcli: hermes: warn: cron edit ${c.jobId} 失败（继续，不触发回滚）: ${(r.stderr || r.stdout).trim().slice(0, 200)}`,
      );
    } else {
      logs.push(`gcli: hermes: cron ${c.jobId} 重 pin → ${to.id}`);
    }
  }

  // 11. 网关重启（stop 失败仅 warn；start 失败 = 网关失败）
  let gatewayFailed: string | undefined;
  const gst = await deps.runHermes(["gateway", "stop"], DEFAULT_TIMEOUT_MS);
  if (gst.exitCode !== 0) {
    logs.push(
      "gcli: hermes: warn: gateway stop 非零退出（网关可能本就没跑），继续 start",
    );
  }
  const gsa = await deps.runHermes(["gateway", "start"], DEFAULT_TIMEOUT_MS);
  if (gsa.exitCode !== 0) {
    gatewayFailed = `hermes gateway start 失败: ${(gsa.stderr || gsa.stdout).trim().slice(0, 300)}`;
    logs.push(`gcli: hermes: ${gatewayFailed}`);
  } else {
    logs.push("gcli: hermes: 网关已重启");
  }

  // 12. 验证：(a) ping 硬门槛；(b) state.db 比对 best-effort（不一致仅 warn）
  let verifyFailed: string | undefined;
  if (parsed.verify) {
    const ping = await deps.runHermes(["-z", "ping"], HERMES_VERIFY_TIMEOUT_MS);
    if (ping.timedOut === true) {
      verifyFailed = `hermes -z ping 超时（${HERMES_VERIFY_TIMEOUT_MS}ms）`;
    } else if (ping.exitCode !== 0) {
      verifyFailed = `hermes -z ping 退出码 ${ping.exitCode}: ${(ping.stderr || ping.stdout).trim().slice(0, 300)}`;
    } else {
      logs.push("gcli: hermes: 验证 ping 通过");
    }
    if (verifyFailed === undefined) {
      const last = await deps.queryLastSessionModel();
      if (last === undefined) {
        logs.push(
          "gcli: hermes: warn: state.db 比对不可用（best-effort，跳过）",
        );
      } else if (last.provider !== to.id) {
        logs.push(
          `gcli: hermes: warn: state.db 最新 session 的 billing_provider=${last.provider}（期望 ${to.id}）——请人工复核`,
        );
      }
    }
  } else {
    logs.push("gcli: hermes: 已跳过验证（--no-verify）");
  }

  const stateRecord: HermesStateFile = {
    lastSwitch: {
      ts: Date.now(),
      ccName,
      to,
      from,
      configBackup: backupPath,
      env: { key: entry.keyEnv, prevValue },
      cronRepinned,
    },
  };

  // 13. 失败 → 默认自动回滚（--keep-on-fail 抑制，但仍写 state 以便手动 rollback）
  const failedReason = gatewayFailed ?? verifyFailed;
  if (failedReason !== undefined) {
    logs.push(
      `gcli: hermes: 切换验证失败 / verification failed: ${failedReason}`,
    );
    const ws = await deps.writeTextFileAtomic(
      HERMES_STATE_PATH,
      serializeHermesStateFile(stateRecord),
      0o600,
    );
    if (!ws.ok) {
      logs.push(`gcli: hermes: warn: state 文件写入失败: ${ws.error}`);
    }
    if (parsed.keepOnFail) {
      logs.push(
        "gcli: hermes: --keep-on-fail 生效，保留现场（可 gcli hermes rollback 手动回滚）",
      );
      return { exitCode: 1, stdout: "", stderr: logs.join("\n") };
    }
    logs.push("gcli: hermes: 开始自动回滚…");
    const rb = await performHermesRollback(
      stateRecord.lastSwitch,
      deps,
      parsed.verify,
      logs,
    );
    logs.push(
      rb.ok
        ? "gcli: hermes: 验证失败，已自动回滚 / rolled back"
        : "gcli: hermes: 自动回滚未完全成功，请检查现场（备份文件仍在）",
    );
    return { exitCode: 1, stdout: "", stderr: logs.join("\n") };
  }

  // 14. 成功 → 写 state（best-effort；失败仅 warn，切换本身已成功）
  const ws = await deps.writeTextFileAtomic(
    HERMES_STATE_PATH,
    serializeHermesStateFile(stateRecord),
    0o600,
  );
  if (!ws.ok) {
    logs.push(
      `gcli: hermes: warn: state 文件写入失败（rollback 将不可用）: ${ws.error}`,
    );
  }
  logs.push(`gcli: hermes: 切换完成 ${from.id} -> ${to.id}（${model}）`);
  return { exitCode: 0, stdout: "", stderr: logs.join("\n") };
}

/** hermes 子命令入口：status / rollback / switch 三分支。 */
async function runHermesBackend(
  parsed: ParsedHermesArgs,
  deps: RunDeps,
): Promise<RunOutcome> {
  if (
    parsed.provider !== undefined &&
    HERMES_RESERVED_WORDS.has(parsed.provider)
  ) {
    return parsed.provider === "status"
      ? hermesStatus(deps)
      : hermesRollback(parsed, deps);
  }
  return hermesSwitch(parsed, deps);
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
  if (sub.subcommand === "hermes") {
    const parsed = parseHermesArgs(sub.rest);
    if ("error" in parsed) {
      return { exitCode: 2, stdout: "", stderr: `gcli: ${parsed.error}` };
    }
    if (parsed.help) {
      return { exitCode: 0, stdout: HELP, stderr: "" };
    }
    return runHermesBackend(parsed, deps);
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
    runHermes: (args, timeoutMs) =>
      runHermesProcess(args, timeoutMs ?? DEFAULT_TIMEOUT_MS),
    readTextFile: (path) => readTextFileFromDisk(path),
    writeTextFileAtomic: (path, text, mode) =>
      writeTextFileAtomicToDisk(path, text, mode),
    copyFile: (src, dest) => copyFileOnDisk(src, dest),
    queryLastSessionModel: () => queryLastSessionModelFromDb(),
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
