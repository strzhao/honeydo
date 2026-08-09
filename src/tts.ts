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
  /**
   * 字幕开关（R1 karaoke 字级时间戳用）。
   * 开启后 MiniMax 在响应中返回 `data.subtitle_file`（OSS 临时 URL，~24h 有效），
   * `generateSpeech` 会即时下载并写盘 `{output}.timings.json`。
   */
  subtitleEnable?: boolean;
  /** 字幕粒度：'word'（字级，T9 实测中文每条 1 字）| 'sentence'（句级） */
  subtitleType?: "word" | "sentence";
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
    // R1 karaoke: 顶层 subtitle_enable/subtitle_type（T9 实测顶层路径生效）
    subtitle_enable: req.subtitleEnable ? true : undefined,
    subtitle_type: req.subtitleEnable ? (req.subtitleType ?? "word") : undefined,
  });
}

interface T2aResponse {
  data?: { audio?: string; subtitle_file?: string };
  extra_info?: unknown;
}

export interface TtsResult {
  filePath: string;
  format: string;
  /** 字幕时间戳 JSON 落盘路径（仅 subtitleEnable=true 且响应含 subtitle_file 时存在） */
  timingsPath?: string;
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

  // R1 karaoke: subtitle_file 即时下载落盘（OSS URL ~24h 时效，必须现在取）
  let timingsPath: string | undefined;
  if (req.subtitleEnable && response?.data?.subtitle_file) {
    try {
      const subtitleResp = await fetch(response.data.subtitle_file);
      if (subtitleResp.ok) {
        const subtitleText = await subtitleResp.text();
        timingsPath = resolve(`${outputFile}.timings.json`);
        await writeFile(timingsPath, subtitleText, "utf8");
      } else {
        // 下载失败不阻断音频生成（音频已写盘），仅 warn
        process.stderr.write(
          `minimax: subtitle_file download failed: ${subtitleResp.status} ${subtitleResp.statusText}\n`,
        );
      }
    } catch (err) {
      process.stderr.write(
        `minimax: subtitle_file download error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  return { filePath, format, timingsPath };
}
