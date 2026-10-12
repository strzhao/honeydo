/** 策展默认音色表（15 locale × 女/男默认，两轮试听定稿，契约规约 1:1）。
 *  键 = BCP47 locale，值 = {f: 女声默认, m: 男声默认}，完整 edge-tts shortName。 */

export type Gender = "m" | "f";

export const DEFAULT_VOICES: Record<string, { f: string; m: string }> = {
  "ja-JP": { f: "ja-JP-NanamiNeural", m: "ja-JP-KeitaNeural" },
  "ko-KR": { f: "ko-KR-SunHiNeural", m: "ko-KR-HyunsuMultilingualNeural" },
  "zh-HK": { f: "zh-HK-HiuMaanNeural", m: "zh-HK-WanLungNeural" },
  "zh-CN": { f: "zh-CN-XiaoxiaoNeural", m: "zh-CN-YunyangNeural" },
  "en-US": { f: "en-US-AvaMultilingualNeural", m: "en-US-AndrewMultilingualNeural" },
  "en-GB": { f: "en-GB-SoniaNeural", m: "en-GB-RyanNeural" },
  "fr-FR": { f: "fr-FR-DeniseNeural", m: "fr-FR-RemyMultilingualNeural" },
  "de-DE": { f: "de-DE-KatjaNeural", m: "de-DE-FlorianMultilingualNeural" },
  "es-ES": { f: "es-ES-ElviraNeural", m: "es-ES-AlvaroNeural" },
  "it-IT": { f: "it-IT-ElsaNeural", m: "it-IT-GiuseppeMultilingualNeural" },
  "ru-RU": { f: "ru-RU-SvetlanaNeural", m: "ru-RU-DmitryNeural" },
  "pt-BR": { f: "pt-BR-FranciscaNeural", m: "pt-BR-AntonioNeural" },
  "th-TH": { f: "th-TH-PremwadeeNeural", m: "th-TH-NiwatNeural" },
  "vi-VN": { f: "vi-VN-HoaiMyNeural", m: "vi-VN-NamMinhNeural" },
  "id-ID": { f: "id-ID-GadisNeural", m: "id-ID-ArdiNeural" },
};

export interface VoiceHit {
  voice: string;
  /** 经默认表解析（--lang 查表命中）时回显：locale=表内精确 locale；显式 --voice 时缺省 */
  via?: { lang: string; gender: Gender };
}

export type VoiceResolution = VoiceHit | { error: string };

/** 音色解析：`--voice` 优先 → `--lang` 查 DEFAULT_VOICES（locale 精确 → 主子标签唯一）
 *  → 都没有则报错。lang 匹配只对表内 15 个 locale，BCP47 大小写不敏感。 */
export function resolveVoice(
  voice: string | undefined,
  lang: string | undefined,
  gender: Gender = "f",
): VoiceResolution {
  if (voice) return { voice };
  if (!lang) {
    return { error: 'no voice: pass --voice <name> or --lang <bcp47> (e.g. --lang ja-JP)' };
  }
  const q = lang.toLowerCase();
  const locales = Object.keys(DEFAULT_VOICES);
  const exact = locales.find((k) => k.toLowerCase() === q);
  if (exact) return { voice: DEFAULT_VOICES[exact][gender], via: { lang: exact, gender } };
  const partial = locales.filter((k) => k.toLowerCase().startsWith(`${q}-`));
  if (partial.length === 1) {
    return { voice: DEFAULT_VOICES[partial[0]][gender], via: { lang: partial[0], gender } };
  }
  if (partial.length === 0) {
    return {
      error: `lang "${lang}" is not in the default voices table; run \`etts voices --lang ${lang}\` to browse, or pass --voice`,
    };
  }
  return {
    error: `lang "${lang}" is ambiguous (matches ${partial.join(", ")}); use a full locale`,
  };
}
