#!/usr/bin/env node

/**
 * doubao — CLI for generating images via the Doubao (Volces Ark) API.
 *
 * Sends a prompt to the Ark image-generation endpoint, walks a model fallback
 * chain (5-0 → lite → 4-5) when a model is not activated for the account,
 * downloads the result, and saves it to a file. Last stdout line is always
 * "Saved to: <absolute path>" so scripts can grep it.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const DEFAULT_MODEL = "doubao-seedream-5-0-260128";
const FALLBACK_MODELS = [
  "doubao-seedream-5-0-lite-260128",
  "doubao-seedream-4-5-251128",
];
const MODEL_CANDIDATES = [DEFAULT_MODEL, ...FALLBACK_MODELS];
export const DEFAULT_SIZE = "2K";
const PRESET_SIZES = new Set(["2K", "3K"]);
const PIXEL_SIZE_PATTERN = /^(\d{2,5})x(\d{2,5})$/i;
const API_URL = "https://ark.cn-beijing.volces.com/api/v3/images/generations";

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

export function normalizeSize(sizeInput: string): string {
  const trimmedSize = sizeInput.trim();
  const upperSize = trimmedSize.toUpperCase();
  if (PRESET_SIZES.has(upperSize)) return upperSize;
  const sizeMatch = PIXEL_SIZE_PATTERN.exec(trimmedSize);
  if (sizeMatch) return `${sizeMatch[1]}x${sizeMatch[2]}`;
  throw new Error(
    'Invalid size. Supported values: "2K", "3K", or "<width>x<height>" (for example "3072x2048").',
  );
}

export function isModelNotOpenError(status: number, errorText: string): boolean {
  return status === 404 && errorText.includes("ModelNotOpen");
}

export function resolveSizeForModel(size: string, model: string): string {
  // 3K shorthand is available in 5.0 models; map it to explicit pixels for older fallbacks.
  if (size === "3K" && !model.startsWith("doubao-seedream-5-0")) {
    return "3072x3072";
  }
  return size;
}

// ---------------------------------------------------------------------------
// argv
// ---------------------------------------------------------------------------

export interface ParsedArgs {
  prompt?: string;
  size?: string;
  output?: string;
  help: boolean;
}

export type ParseResult = ParsedArgs | { error: string };

export function parseCliArgs(argv: string[]): ParseResult {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      options: {
        size: { type: "string" },
        output: { type: "string" },
        help: { type: "boolean" },
      },
      allowPositionals: true,
    });
    return {
      prompt: positionals[0],
      size: values.size,
      output: values.output,
      help: values.help ?? false,
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

interface ArkResponse {
  data?: Array<{ url?: string; size?: unknown }>;
  model?: unknown;
}

export interface GenInput {
  prompt: string;
  size?: string;
  output?: string;
  apiKey: string;
}

export interface GenResult {
  filePath: string;
  model: string;
  requestedSize: string;
  appliedSize: string;
  returnedSize: string;
}

function sanitizePrompt(prompt: string): string {
  return prompt
    .substring(0, 50)
    .replace(/[^a-z0-9]/gi, "_")
    .toLowerCase();
}

export async function generateImage(input: GenInput): Promise<GenResult> {
  const normalizedSize = input.size ? normalizeSize(input.size) : DEFAULT_SIZE;

  let result: ArkResponse | null = null;
  let modelUsed = DEFAULT_MODEL;
  let sizeUsed = normalizedSize;
  let lastModelNotOpenError = "";

  for (const candidateModel of MODEL_CANDIDATES) {
    const candidateSize = resolveSizeForModel(normalizedSize, candidateModel);
    const requestBody = {
      model: candidateModel,
      prompt: input.prompt,
      sequential_image_generation: "disabled",
      response_format: "url",
      size: candidateSize,
      stream: false,
      watermark: false,
    };

    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${input.apiKey}`,
      },
      body: JSON.stringify(requestBody),
    });

    if (response.ok) {
      result = (await response.json()) as ArkResponse;
      modelUsed = candidateModel;
      sizeUsed = candidateSize;
      break;
    }

    const errorText = await response.text();
    if (isModelNotOpenError(response.status, errorText)) {
      lastModelNotOpenError = `Doubao API error: ${response.status} ${response.statusText} - ${errorText}`;
      continue;
    }
    throw new Error(
      `Doubao API error: ${response.status} ${response.statusText} - ${errorText}`,
    );
  }

  if (!result) {
    throw new Error(
      `No available model for this account. Tried: ${MODEL_CANDIDATES.join(", ")}. Last error: ${lastModelNotOpenError}`,
    );
  }

  const imageUrl = result.data?.[0]?.url;
  if (!imageUrl) {
    throw new Error("No image URL in response from Doubao API");
  }

  const imageResponse = await fetch(imageUrl);
  if (!imageResponse.ok) {
    throw new Error(
      `Failed to download image from ${imageUrl}: ${imageResponse.status} ${imageResponse.statusText}`,
    );
  }
  const imageBuffer = await imageResponse.arrayBuffer();

  const filePath = input.output
    ? resolve(input.output)
    : join(
        process.cwd(),
        "generated_images",
        `${Date.now()}_${sanitizePrompt(input.prompt)}.png`,
      );
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, Buffer.from(imageBuffer));

  const returnedSize =
    typeof result.data?.[0]?.size === "string"
      ? (result.data[0].size as string)
      : "unknown";

  return {
    filePath,
    model: typeof result.model === "string" ? result.model : modelUsed,
    requestedSize: normalizedSize,
    appliedSize: sizeUsed,
    returnedSize,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const HELP = `Usage: doubao "<prompt>" [options]

Generate an image via the Doubao (Volces Ark) API and save it to a file.

Options:
  "<prompt>"            (required) Text description of the image to generate
      --size <s>        "2K" (default), "3K", or "<width>x<height>" (e.g. 3072x2048)
      --output <path>   Output file path (default: ./generated_images/<ts>_<prompt>.png)
      --help            Show this help

Exit codes: 0 success | 1 API error / missing DOUBAO_API_KEY | 2 bad args
On success the last stdout line is "Saved to: <absolute path>".`;

async function main(): Promise<void> {
  const parsed = parseCliArgs(process.argv.slice(2));
  if ("error" in parsed) {
    process.stderr.write(`doubao: ${parsed.error}\n`);
    process.exit(2);
  }
  if (parsed.help) {
    process.stdout.write(`${HELP}\n`);
    process.exit(0);
  }
  if (!parsed.prompt) {
    process.stderr.write(
      "doubao: prompt is required (pass it as the first argument)\n",
    );
    process.exit(2);
  }

  const apiKey = process.env.DOUBAO_API_KEY;
  if (!apiKey) {
    process.stderr.write(
      "doubao: DOUBAO_API_KEY environment variable is not set\n",
    );
    process.exit(1);
  }

  try {
    const r = await generateImage({
      prompt: parsed.prompt,
      size: parsed.size,
      output: parsed.output,
      apiKey,
    });
    process.stdout.write(
      [
        "Image generated successfully!",
        `Model: ${r.model}`,
        `Requested size: ${r.requestedSize}`,
        `Applied size: ${r.appliedSize}`,
        `Returned size: ${r.returnedSize}`,
        `Saved to: ${r.filePath}`,
      ].join("\n") + "\n",
    );
    process.exit(0);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`doubao: Error generating image: ${msg}\n`);
    process.exit(1);
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((err: unknown) => {
    process.stderr.write(
      `doubao: fatal ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
}
