import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { MiniMaxClient } from "./client.js";
import {
  DEFAULTS,
  ensureValidBitrate,
  ensureValidChannel,
  ensureValidEmotion,
  ensureValidFormat,
  ensureValidModel,
  ensureValidSampleRate,
  removeUndefined,
} from "./validate.js";

export interface TtsRequest {
  text: string;
  voiceId?: string;
  model?: string;
  speed?: number;
  vol?: number;
  pitch?: number;
  emotion?: string;
  format?: string;
  sampleRate?: number;
  bitrate?: number;
  channel?: number;
  languageBoost?: string;
}

/** Build the /v1/t2a_v2 request body (pure — unit-tested). */
export function buildTtsRequestData(req: TtsRequest): Record<string, unknown> {
  const model = ensureValidModel(req.model);
  return removeUndefined({
    model,
    text: req.text,
    voice_setting: {
      voice_id: req.voiceId || DEFAULTS.voiceId,
      speed: req.speed ?? DEFAULTS.speed,
      vol: req.vol ?? DEFAULTS.vol,
      pitch: req.pitch ?? DEFAULTS.pitch,
      emotion: ensureValidEmotion(req.emotion, model),
    },
    audio_setting: {
      sample_rate: ensureValidSampleRate(req.sampleRate),
      bitrate: ensureValidBitrate(req.bitrate),
      format: ensureValidFormat(req.format),
      channel: ensureValidChannel(req.channel),
    },
    language_boost: req.languageBoost || DEFAULTS.languageBoost,
    stream: false,
  });
}

interface T2aResponse {
  data?: { audio?: string; subtitle_file?: string };
  extra_info?: unknown;
}

export interface TtsResult {
  filePath: string;
  format: string;
}

/** Call /v1/t2a_v2, decode the hex-encoded audio, and write it to disk. */
export async function generateSpeech(
  client: MiniMaxClient,
  req: TtsRequest,
  outputFile: string,
): Promise<TtsResult> {
  const data = buildTtsRequestData(req);
  const format = ensureValidFormat(req.format);
  const response = await client.post<T2aResponse>("/v1/t2a_v2", data);
  const audioHex = response?.data?.audio;
  if (!audioHex) {
    throw new Error("MiniMax T2A returned no audio data");
  }
  const audioBuffer = Buffer.from(audioHex, "hex");
  const filePath = resolve(outputFile);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, audioBuffer);
  return { filePath, format };
}
