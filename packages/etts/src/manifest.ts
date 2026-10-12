/** manifest JSONL 解析（纯函数）：空行/#注释行跳过，坏行记入失败清单不中断其余行。
 *  index = 0 起的物理行号（含注释/空行在内）。 */

export interface ManifestItem {
  index: number;
  text: string;
  out: string;
  voice?: string;
  lang?: string;
  gender?: "m" | "f";
}

export interface ManifestItemError {
  index: number;
  text: string;
  out: string;
  voice?: string;
  error: string;
}

export interface ParsedManifest {
  items: ManifestItem[];
  itemErrors: ManifestItemError[];
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

export function parseManifest(text: string): ParsedManifest {
  const items: ManifestItem[] = [];
  const itemErrors: ManifestItemError[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      itemErrors.push({
        index,
        text: line,
        out: "",
        error: `invalid JSON: ${line.slice(0, 80)}`,
      });
      return;
    }
    if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
      itemErrors.push({ index, text: line, out: "", error: "manifest line must be a JSON object" });
      return;
    }
    const rec = obj as Record<string, unknown>;
    const base = {
      index,
      text: nonEmptyString(rec.text) ? rec.text : "",
      out: nonEmptyString(rec.out) ? rec.out : "",
      voice: nonEmptyString(rec.voice) ? rec.voice : undefined,
    };
    if (!nonEmptyString(rec.text)) {
      itemErrors.push({ ...base, error: 'missing or empty "text"' });
      return;
    }
    if (!nonEmptyString(rec.out)) {
      itemErrors.push({ ...base, error: 'missing or empty "out"' });
      return;
    }
    if (rec.gender !== undefined && rec.gender !== "m" && rec.gender !== "f") {
      itemErrors.push({ ...base, error: `invalid gender "${String(rec.gender)}" (must be m|f)` });
      return;
    }
    const lang = nonEmptyString(rec.lang) ? rec.lang : undefined;
    if (!base.voice && !lang) {
      itemErrors.push({ ...base, error: 'line needs "voice" or "lang" (at least one)' });
      return;
    }
    items.push({
      index,
      text: base.text,
      out: base.out,
      voice: base.voice,
      lang,
      gender: rec.gender as "m" | "f" | undefined,
    });
  });
  return { items, itemErrors };
}
