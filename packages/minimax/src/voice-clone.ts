import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type { MiniMaxClient } from "./client.js";
import { DEFAULTS } from "./validate.js";

export interface VoiceCloneRequest {
  voiceId: string;
  audioFile: string;
  text?: string;
}

/** Build the /v1/voice_clone payload from an uploaded file_id (pure). */
export function buildClonePayload(
  fileId: string,
  req: VoiceCloneRequest,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    file_id: fileId,
    voice_id: req.voiceId,
  };
  if (req.text) {
    payload.text = req.text;
    payload.model = DEFAULTS.model;
  }
  return payload;
}

interface UploadResponse {
  file?: { file_id?: string };
}

interface CloneResponse {
  demo_audio?: string;
  voice_id?: string;
}

export interface VoiceCloneResult {
  voiceId: string;
  demoPath?: string;
}

/**
 * Upload the audio (multipart, purpose=voice_clone), clone it, then download
 * the demo audio if one is returned.
 */
export async function cloneVoice(
  client: MiniMaxClient,
  req: VoiceCloneRequest,
  outputDir: string,
): Promise<VoiceCloneResult> {
  const absAudio = resolve(req.audioFile);
  const buffer = await readFile(absAudio);

  const form = new FormData();
  form.append("file", new Blob([buffer]), basename(absAudio));
  form.append("purpose", "voice_clone");

  const upload = await client.postMultipart<UploadResponse>(
    "/v1/files/upload",
    form,
  );
  const fileId = upload?.file?.file_id;
  if (!fileId) {
    throw new Error("MiniMax upload returned no file_id");
  }

  const cloneResp = await client.post<CloneResponse>(
    "/v1/voice_clone",
    buildClonePayload(fileId, req),
  );

  const demoAudio = cloneResp?.demo_audio;
  if (!demoAudio) {
    return { voiceId: req.voiceId };
  }

  const demoResp = await fetch(demoAudio);
  if (!demoResp.ok) {
    return { voiceId: req.voiceId };
  }
  const demoBuffer = Buffer.from(await demoResp.arrayBuffer());
  const outDir = resolve(outputDir);
  await mkdir(outDir, { recursive: true });
  const demoPath = resolve(outDir, `${req.voiceId}-demo.wav`);
  await writeFile(demoPath, demoBuffer);
  return { voiceId: req.voiceId, demoPath };
}
