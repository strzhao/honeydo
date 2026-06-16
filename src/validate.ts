/**
 * Pure validation helpers for MiniMax API parameters.
 *
 * Each `ensureValid*` returns the value if it is in the API's allow-list,
 * otherwise falls back to the default (invalid input never throws — the API's
 * own enum validation is the final authority, but we avoid obvious rejections).
 */

const VALID_MODELS = [
  "speech-02-hd",
  "speech-02-turbo",
  "speech-01-hd",
  "speech-01-turbo",
  "speech-01-240228",
  "speech-01-turbo-240228",
];

const VALID_FORMATS = ["mp3", "pcm", "flac", "wav"];

const VALID_EMOTIONS = [
  "happy",
  "sad",
  "angry",
  "fearful",
  "disgusted",
  "surprised",
  "neutral",
];

// Models that accept the `emotion` parameter at all.
const EMOTION_SUPPORTED_MODELS = [
  "speech-02-hd",
  "speech-02-turbo",
  "speech-01-turbo",
  "speech-01-hd",
];

const VALID_SAMPLE_RATES = [8000, 16000, 22050, 24000, 32000, 44100];
const VALID_BITRATES = [
  64000,
  96000,
  128000,
  160000,
  192000,
  224000,
  256000,
  320000,
];
const VALID_CHANNELS = [1, 2];

export const DEFAULTS = {
  model: "speech-02-hd",
  format: "mp3",
  emotion: "happy",
  sampleRate: 32000,
  bitrate: 128000,
  channel: 1,
  voiceId: "male-qn-qingse",
  speed: 1.0,
  vol: 1.0,
  pitch: 0,
  languageBoost: "auto",
} as const;

function closest(value: number, valid: readonly number[]): number {
  return valid.reduce((prev, curr) =>
    Math.abs(curr - value) < Math.abs(prev - value) ? curr : prev,
  );
}

export function ensureValidModel(model?: string): string {
  if (!model) return DEFAULTS.model;
  return VALID_MODELS.includes(model) ? model : DEFAULTS.model;
}

export function ensureValidFormat(format?: string): string {
  if (!format) return DEFAULTS.format;
  return VALID_FORMATS.includes(format) ? format : DEFAULTS.format;
}

/** Returns undefined when the model does not support emotion (caller omits it). */
export function ensureValidEmotion(
  emotion?: string,
  model?: string,
): string | undefined {
  if (model && !EMOTION_SUPPORTED_MODELS.includes(model)) return undefined;
  if (!emotion) return DEFAULTS.emotion;
  return VALID_EMOTIONS.includes(emotion) ? emotion : DEFAULTS.emotion;
}

export function ensureValidSampleRate(sampleRate?: number): number {
  if (sampleRate === undefined) return DEFAULTS.sampleRate;
  return VALID_SAMPLE_RATES.includes(sampleRate)
    ? sampleRate
    : closest(sampleRate, VALID_SAMPLE_RATES);
}

export function ensureValidBitrate(bitrate?: number): number {
  if (bitrate === undefined) return DEFAULTS.bitrate;
  return VALID_BITRATES.includes(bitrate) ? bitrate : closest(bitrate, VALID_BITRATES);
}

export function ensureValidChannel(channel?: number): number {
  if (channel === undefined) return DEFAULTS.channel;
  return VALID_CHANNELS.includes(channel) ? channel : closest(channel, VALID_CHANNELS);
}

/** Recursively drop undefined fields and empty objects (MiniMax rejects them). */
export function removeUndefined<T>(obj: T): T {
  if (typeof obj !== "object" || obj === null) return obj;
  if (Array.isArray(obj)) {
    return obj.map((item) => removeUndefined(item)).filter(
      (item) => item !== undefined,
    ) as unknown as T;
  }
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (value === undefined) continue;
    if (typeof value === "object" && value !== null) {
      const filtered = removeUndefined(value);
      if (
        typeof filtered === "object" &&
        !Array.isArray(filtered) &&
        Object.keys(filtered as object).length === 0
      ) {
        continue;
      }
      result[key] = filtered;
    } else {
      result[key] = value;
    }
  }
  return result as T;
}
