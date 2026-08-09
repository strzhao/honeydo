#!/usr/bin/env node

/**
 * minimax — CLI for the MiniMax API.
 *
 * Subcommands (only what little-bee actually uses; the official MCP exposes 10
 * tools but most are unused — add more on demand):
 *   tts <text>        text-to-audio            (POST /v1/t2a_v2)
 *   voice-clone       clone a voice from audio (POST /v1/files/upload + /v1/voice_clone)
 *   voices            list voices as JSON      (POST /v1/get_voice)
 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createClient } from "./client.js";
import { generateSpeech } from "./tts.js";
import { cloneVoice } from "./voice-clone.js";
import { listVoices, type VoiceType } from "./voices.js";

const DEFAULT_HOST = "https://api.minimax.chat";

// ---------------------------------------------------------------------------
// arg parsing (pure, unit-tested)
// ---------------------------------------------------------------------------

function num(v: string | undefined, name: string): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) {
    throw new Error(`--${name} must be a number, got "${v}"`);
  }
  return n;
}

export interface TtsCliArgs {
  text?: string;
  voiceId?: string;
  model?: string;
  output?: string;
  speed?: number;
  vol?: number;
  pitch?: number;
  emotion?: string;
  format?: string;
  sampleRate?: number;
  bitrate?: number;
  channel?: number;
  languageBoost?: string;
  /** R1 karaoke: 字幕开关 */
  subtitleEnable?: boolean;
  /** R1 karaoke: 字幕粒度（默认 'word'） */
  subtitleType?: "word" | "sentence";
}
export type TtsParse = TtsCliArgs | { error: string };

export function parseTtsArgs(argv: string[]): TtsParse {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      options: {
        voice: { type: "string" },
        model: { type: "string" },
        output: { type: "string" },
        speed: { type: "string" },
        vol: { type: "string" },
        pitch: { type: "string" },
        emotion: { type: "string" },
        format: { type: "string" },
        "sample-rate": { type: "string" },
        bitrate: { type: "string" },
        channel: { type: "string" },
        "language-boost": { type: "string" },
        subtitle: { type: "boolean", default: false },
        "subtitle-type": { type: "string" },
      },
      allowPositionals: true,
      allowNegative: true,
    });
    const subtitleTypeRaw = values["subtitle-type"] as string | undefined;
    const subtitleType: "word" | "sentence" | undefined =
      subtitleTypeRaw === "sentence" ? "sentence" : subtitleTypeRaw === "word" ? "word" : undefined;
    return {
      text: positionals[0],
      voiceId: values.voice,
      model: values.model,
      output: values.output,
      speed: num(values.speed, "speed"),
      vol: num(values.vol, "vol"),
      pitch: num(values.pitch, "pitch"),
      emotion: values.emotion,
      format: values.format,
      sampleRate: num(values["sample-rate"], "sample-rate"),
      bitrate: num(values.bitrate, "bitrate"),
      channel: num(values.channel, "channel"),
      languageBoost: values["language-boost"],
      subtitleEnable: values.subtitle === true,
      subtitleType,
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export interface VoiceCloneCliArgs {
  voiceId?: string;
  audioFile?: string;
  text?: string;
  output?: string;
}
export type VoiceCloneParse = VoiceCloneCliArgs | { error: string };

export function parseVoiceCloneArgs(argv: string[]): VoiceCloneParse {
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        voice: { type: "string" },
        audio: { type: "string" },
        text: { type: "string" },
        output: { type: "string" },
      },
      allowPositionals: false,
    });
    return {
      voiceId: values.voice,
      audioFile: values.audio,
      text: values.text,
      output: values.output,
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export interface VoicesCliArgs {
  type: VoiceType;
}
export type VoicesParse = VoicesCliArgs | { error: string };

const VOICE_TYPES: VoiceType[] = ["all", "system", "voice_cloning"];

export function parseVoicesArgs(argv: string[]): VoicesParse {
  try {
    const { values } = parseArgs({
      args: argv,
      options: { type: { type: "string" } },
      allowPositionals: false,
    });
    const t = (values.type ?? "all") as VoiceType;
    if (!VOICE_TYPES.includes(t)) {
      return {
        error: `--type must be one of ${VOICE_TYPES.join(", ")}, got "${t}"`,
      };
    }
    return { type: t };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// help
// ---------------------------------------------------------------------------

const HELP = `Usage: minimax <command> [options]

Commands:
  tts <text>          Text-to-audio            (POST /v1/t2a_v2)
  voice-clone         Clone a voice from audio (upload + /v1/voice_clone)
  voices              List voices as JSON      (POST /v1/get_voice)

Options:
  --help              Show this help (per-command: minimax <command> --help)

Env:
  MINIMAX_API_KEY     (required) API key
  MINIMAX_API_HOST    default ${DEFAULT_HOST}

Exit codes: 0 success | 1 API error / missing key | 2 bad args
On file output, last stdout line is the saved path.`;

const TTS_HELP = `Usage: minimax tts "<text>" [options]

Options:
  --voice <id>          Voice ID (default male-qn-qingse)
  --model <name>        speech-02-hd (default) | speech-02-turbo | speech-01-*
  --output <path>       Output file (default: ./<voice>_<ts>.mp3)
  --speed <n>           0.5-2.0 (default 1.0)
  --vol <n>             0.1-10.0 (default 1.0)
  --pitch <n>           -12 to 12 (default 0; negatives need --pitch=-N)
  --emotion <name>      happy|sad|angry|fearful|disgusted|surprised|neutral
  --format <f>          mp3 (default) | pcm | flac | wav
  --sample-rate <hz>    8000|16000|22050|24000|32000|44100
  --bitrate <bps>       64000...320000
  --channel <n>         1|2
  --language-boost <l>  auto (default) | Chinese | English | ...
  --subtitle            Enable subtitle (word-level timestamps; R1 karaoke)
  --subtitle-type <t>   word (default) | sentence`;

const VC_HELP = `Usage: minimax voice-clone --voice <id> --audio <file> [options]

Options:
  --voice <id>     (required) Voice ID to create
  --audio <file>   (required) Source audio file (mp3/m4a/wav)
  --text <demo>    Demo text (also synthesized to a demo wav)
  --output <dir>   Directory for the demo wav (default: current dir)`;

const VOICES_HELP = `Usage: minimax voices [--type <t>]

Options:
  --type <t>   all (default) | system | voice_cloning
Outputs JSON: { system: [{voice_id,voice_name}], cloned: [...] }`;

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function fail(msg: string, code: number): never {
  process.stderr.write(`minimax: ${msg}\n`);
  process.exit(code);
}

function envOrError(): { apiKey: string; host: string } | { error: string } {
  const apiKey = process.env.MINIMAX_API_KEY;
  if (!apiKey) {
    return { error: "MINIMAX_API_KEY environment variable is not set" };
  }
  return { apiKey, host: process.env.MINIMAX_API_HOST || DEFAULT_HOST };
}

function wantsHelp(rest: string[]): boolean {
  return rest.includes("--help") || rest.includes("-h");
}

async function runTts(rest: string[]): Promise<void> {
  if (wantsHelp(rest)) {
    process.stdout.write(`${TTS_HELP}\n`);
    process.exit(0);
  }
  const parsed = parseTtsArgs(rest);
  if ("error" in parsed) fail(parsed.error, 2);
  if (!parsed.text) fail('tts requires <text> as the first argument', 2);

  const env = envOrError();
  if ("error" in env) fail(env.error, 1);
  const client = createClient(env);
  const format = parsed.format || "mp3";
  const output =
    parsed.output || `./${parsed.voiceId ?? "voice"}_${Date.now()}.${format}`;

  try {
    const r = await generateSpeech(
      client,
      {
        text: parsed.text,
        voiceId: parsed.voiceId,
        model: parsed.model,
        speed: parsed.speed,
        vol: parsed.vol,
        pitch: parsed.pitch,
        emotion: parsed.emotion,
        format: parsed.format,
        sampleRate: parsed.sampleRate,
        bitrate: parsed.bitrate,
        channel: parsed.channel,
        languageBoost: parsed.languageBoost,
        subtitleEnable: parsed.subtitleEnable,
        subtitleType: parsed.subtitleType,
      },
      output,
    );
    process.stdout.write(`Saved to: ${r.filePath}\n`);
    if (r.timingsPath) {
      process.stdout.write(`Timings: ${r.timingsPath}\n`);
    }
    process.exit(0);
  } catch (err) {
    fail(
      `tts failed: ${err instanceof Error ? err.message : String(err)}`,
      1,
    );
  }
}

async function runVoiceClone(rest: string[]): Promise<void> {
  if (wantsHelp(rest)) {
    process.stdout.write(`${VC_HELP}\n`);
    process.exit(0);
  }
  const parsed = parseVoiceCloneArgs(rest);
  if ("error" in parsed) fail(parsed.error, 2);
  if (!parsed.voiceId) fail("voice-clone requires --voice <id>", 2);
  if (!parsed.audioFile) fail("voice-clone requires --audio <file>", 2);

  const env = envOrError();
  if ("error" in env) fail(env.error, 1);
  const client = createClient(env);

  try {
    const r = await cloneVoice(
      client,
      {
        voiceId: parsed.voiceId,
        audioFile: parsed.audioFile,
        text: parsed.text,
      },
      parsed.output || ".",
    );
    process.stdout.write(
      r.demoPath
        ? `Voice cloned: ${r.voiceId} (demo: ${r.demoPath})\n`
        : `Voice cloned: ${r.voiceId}\n`,
    );
    process.exit(0);
  } catch (err) {
    fail(
      `voice-clone failed: ${err instanceof Error ? err.message : String(err)}`,
      1,
    );
  }
}

async function runVoices(rest: string[]): Promise<void> {
  if (wantsHelp(rest)) {
    process.stdout.write(`${VOICES_HELP}\n`);
    process.exit(0);
  }
  const parsed = parseVoicesArgs(rest);
  if ("error" in parsed) fail(parsed.error, 2);

  const env = envOrError();
  if ("error" in env) fail(env.error, 1);
  const client = createClient(env);

  try {
    const result = await listVoices(client, parsed.type);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exit(0);
  } catch (err) {
    fail(
      `voices failed: ${err instanceof Error ? err.message : String(err)}`,
      1,
    );
  }
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "tts":
      return runTts(rest);
    case "voice-clone":
      return runVoiceClone(rest);
    case "voices":
      return runVoices(rest);
    case "--help":
    case "-h":
    case undefined:
      process.stdout.write(`${HELP}\n`);
      process.exit(0);
    default:
      fail(`unknown command "${cmd}". Run "minimax --help".`, 2);
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((err: unknown) => {
    process.stderr.write(
      `minimax: fatal ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
}
