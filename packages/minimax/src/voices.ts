import type { MiniMaxClient } from "./client.js";

export type VoiceType = "all" | "system" | "voice_cloning";

interface VoiceEntry {
  voice_id?: string;
  voice_name?: string;
}

interface GetVoiceResponse {
  system_voice?: VoiceEntry[];
  voice_cloning?: VoiceEntry[];
}

export interface VoiceListResult {
  system: Array<{ voice_id: string; voice_name: string }>;
  cloned: Array<{ voice_id: string; voice_name: string }>;
}

function normalize(
  list: VoiceEntry[] | undefined,
): Array<{ voice_id: string; voice_name: string }> {
  return (list ?? []).map((v) => ({
    voice_id: v.voice_id ?? "",
    voice_name: v.voice_name ?? "",
  }));
}

/**
 * List available voices. Returns a structured { system, cloned } shape
 * (stable schema for scripting) rather than the raw API field names.
 */
export async function listVoices(
  client: MiniMaxClient,
  voiceType: VoiceType = "all",
): Promise<VoiceListResult> {
  const resp = await client.post<GetVoiceResponse>("/v1/get_voice", {
    voice_type: voiceType,
  });
  return {
    system: normalize(resp?.system_voice),
    cloned: normalize(resp?.voice_cloning),
  };
}
