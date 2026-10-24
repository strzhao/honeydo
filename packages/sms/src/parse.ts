/**
 * UI 树解析 — 从 uitest dumpLayout 产出的 json 里还原短信会话列表。
 * 纯函数、无 IO，方便单测。
 *
 * 原理（在 Pura X Max / HOP-AL00 信息 App 上实测成立，2026-10 验证 7 会话 3 验证码全对）：
 * 会话列表整页是单个大 RelativeContainer，所有会话字段平铺
 * （badge, sender, time, preview, badge, sender, ...）。
 * badge 不是 Text 节点、不参与平铺；以时间元素为锚点分组：sender 在锚点前、preview 在锚点后。
 */

/** uitest dump 的最小结构（只取解析所需字段） */
export interface DumpNode {
  attributes?: {
    type?: string;
    text?: string;
  };
  children?: DumpNode[];
}

export interface Session {
  sender: string;
  time: string;
  preview: string;
}

export interface CodeHit extends Session {
  code: string;
}

/** 时间元素形态：刚刚 / 今天 / 昨天 / 前天 / 星期X / N分钟前 / N小时前 / YYYY-M-D（或 / 分隔） */
export const TIME_RE =
  /^(刚刚|昨天|前天|今天|星期.|\d{1,2}分钟前|\d{1,2}小时前|\d{4}[-/]\d{1,2}[-/]\d{1,2})$/;

/** 验证码形态，按命中率排序，逐会话取首个命中的模式（语义与 martin 原型一致） */
export const CODE_PATTERNS = [
  /验证码[^\d]{0,6}(\d{4,8})/,
  /码[：:]\s*(\d{4,8})/,
  /code[^\d]{0,6}(\d{4,8})/,
];

/** 深度优先收集所有非空 Text 节点，保持文档序 */
export function collectTexts(node: DumpNode, out: string[] = []): string[] {
  const a = node.attributes ?? {};
  const text = a.text?.trim();
  if (a.type === "Text" && text) out.push(text);
  for (const c of node.children ?? []) collectTexts(c, out);
  return out;
}

/** UI 树 → 会话列表（文档序，即信息 App 的最近优先排序） */
export function parseSessions(dump: DumpNode): Session[] {
  const texts = collectTexts(dump);
  const sessions: Session[] = [];
  for (let i = 0; i < texts.length; i++) {
    if (TIME_RE.test(texts[i]) && i >= 1 && i + 1 < texts.length) {
      sessions.push({
        sender: texts[i - 1],
        time: texts[i],
        preview: texts[i + 1],
      });
    }
  }
  return sessions;
}

/** 会话 → 验证码命中（每条会话最多一个码，取首个命中的模式） */
export function extractCodes(sessions: Session[]): CodeHit[] {
  const hits: CodeHit[] = [];
  for (const s of sessions) {
    for (const pat of CODE_PATTERNS) {
      const m = pat.exec(s.preview);
      if (m) {
        hits.push({ ...s, code: m[1] });
        break;
      }
    }
  }
  return hits;
}
