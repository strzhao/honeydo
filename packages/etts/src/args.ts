/** 纯参数解析器：parseGenArgs / parseBatchArgs / parseVoicesArgs → {…} | {error}。
 *  只做解析 + 校验，不碰网络/子进程（导出供单测）。error → CLI 层统一 exit 2。 */
import { parseArgs } from "node:util";
import { resolveVoice, type Gender } from "./defaults.js";

export const DEFAULT_RETRY = 3;

export type ParseResult<T> = T | { error: string };

function fail(error: string): { error: string } {
  return { error };
}

/** `--retry` 整数 ≥1，缺省 3；`<1` 或非整数 → error（exit 2）。 */
export function parseRetry(v: string | undefined): number | string {
  if (v === undefined) return DEFAULT_RETRY;
  if (!/^\d+$/.test(v) || Number(v) < 1) {
    return `--retry must be an integer >= 1, got "${v}"`;
  }
  return Number(v);
}

export function parseGender(v: string | undefined): Gender | string {
  if (v === undefined || v === "f") return "f";
  if (v === "m") return "m";
  return `--gender must be m|f, got "${v}"`;
}

export interface GenArgs {
  text: string;
  voice: string;
  /** 经默认表解析命中时回显（stderr: `voice: <name> (via lang <locale>, gender <g>)`） */
  via?: { lang: string; gender: Gender };
  out: string;
  retry: number;
  proxy?: string;
}
export type GenParse = ParseResult<GenArgs>;

export function parseGenArgs(argv: string[]): GenParse {
  let values: Record<string, string | boolean | undefined>;
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args: argv,
      options: {
        voice: { type: "string" },
        lang: { type: "string" },
        gender: { type: "string" },
        out: { type: "string" },
        retry: { type: "string" },
        proxy: { type: "string" },
      },
      allowPositionals: true,
    });
    values = parsed.values;
    positionals = parsed.positionals;
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
  const gender = parseGender(values.gender as string | undefined);
  if (typeof gender === "string" && gender !== "m" && gender !== "f") return fail(gender);
  const retry = parseRetry(values.retry as string | undefined);
  if (typeof retry === "string") return fail(retry);
  if (positionals.length === 0) return fail("gen requires <text> as the first argument");
  if (positionals.length > 1) return fail("gen takes a single <text> argument (quote text with spaces)");
  const out = values.out as string | undefined;
  if (!out) return fail("gen requires --out <path>");
  const rv = resolveVoice(values.voice as string | undefined, values.lang as string | undefined, gender);
  if ("error" in rv) return fail(rv.error);
  return {
    text: positionals[0],
    voice: rv.voice,
    via: rv.via,
    out,
    retry,
    proxy: values.proxy as string | undefined,
  };
}

export interface BatchArgs {
  manifest: string;
  failures?: string;
  skipExisting: boolean;
  retry: number;
  proxy?: string;
}
export type BatchParse = ParseResult<BatchArgs>;

export function parseBatchArgs(argv: string[]): BatchParse {
  let values: Record<string, string | boolean | undefined>;
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args: argv,
      options: {
        failures: { type: "string" },
        "skip-existing": { type: "boolean", default: false },
        retry: { type: "string" },
        proxy: { type: "string" },
      },
      allowPositionals: true,
    });
    values = parsed.values;
    positionals = parsed.positionals;
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
  if (positionals.length === 0) return fail("batch requires <manifest.jsonl>");
  if (positionals.length > 1) return fail("batch takes a single <manifest.jsonl> argument");
  const retry = parseRetry(values.retry as string | undefined);
  if (typeof retry === "string") return fail(retry);
  return {
    manifest: positionals[0],
    failures: values.failures as string | undefined,
    skipExisting: values["skip-existing"] === true,
    retry,
    proxy: values.proxy as string | undefined,
  };
}

export interface VoicesArgs {
  lang?: string;
  json: boolean;
}
export type VoicesParse = ParseResult<VoicesArgs>;

export function parseVoicesArgs(argv: string[]): VoicesParse {
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        lang: { type: "string" },
        json: { type: "boolean", default: false },
      },
      allowPositionals: false,
    });
    return { lang: values.lang as string | undefined, json: values.json === true };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
