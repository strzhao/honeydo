import { describe, expect, it } from "vitest";
import {
  collectTexts,
  extractCodes,
  parseSessions,
  type DumpNode,
  type Session,
} from "../src/parse.js";

/** 按文档序给一串 (type, text) 搭一棵最小 UI 树 */
function tree(entries: [type: string, text?: string][]): DumpNode {
  return {
    attributes: { type: "RelativeContainer" },
    children: entries.map(([type, text]) => ({
      attributes: { type, ...(text !== undefined ? { text } : {}) },
    })),
  };
}

function session(s: [string, string, string]): Session {
  return { sender: s[0], time: s[1], preview: s[2] };
}

describe("collectTexts", () => {
  it("只收集非空 Text 节点，保持文档序", () => {
    const texts = collectTexts(
      tree([
        ["Image"],
        ["Text", "张三"],
        ["Text", "  "],
        ["Text", "刚刚"],
        ["Button", "发送"],
      ]),
    );
    expect(texts).toEqual(["张三", "刚刚"]);
  });
});

describe("parseSessions", () => {
  it("按时间锚点分组：sender 在前、preview 在后", () => {
    const sessions = parseSessions(
      tree([
        ["Text", "信息"],
        ["Text", "张三"],
        ["Text", "刚刚"],
        ["Text", "你的验证码是 123456，5 分钟内有效"],
        ["Text", "银行客服"],
        ["Text", "5分钟前"],
        ["Text", "【XX银行】验证码 998877，请勿泄露"],
        ["Text", "李四"],
        ["Text", "昨天"],
        ["Text", "明天聚餐吗"],
      ]),
    );
    expect(sessions).toEqual([
      session(["张三", "刚刚", "你的验证码是 123456，5 分钟内有效"]),
      session(["银行客服", "5分钟前", "【XX银行】验证码 998877，请勿泄露"]),
      session(["李四", "昨天", "明天聚餐吗"]),
    ]);
  });

  it("尾部孤立时间锚点（无 preview）不产出会话", () => {
    const sessions = parseSessions(
      tree([
        ["Text", "张三"],
        ["Text", "刚刚"],
        ["Text", "在吗"],
        ["Text", "昨天"],
      ]),
    );
    expect(sessions).toEqual([session(["张三", "刚刚", "在吗"])]);
  });

  it("时间形态：星期X / 日期 / 小时前 / 前天", () => {
    const sessions = parseSessions(
      tree([
        ["Text", "a"],
        ["Text", "星期三"],
        ["Text", "p1"],
        ["Text", "b"],
        ["Text", "2026-10-25"],
        ["Text", "p2"],
        ["Text", "c"],
        ["Text", "3小时前"],
        ["Text", "p3"],
        ["Text", "d"],
        ["Text", "前天"],
        ["Text", "p4"],
      ]),
    );
    expect(sessions.map((s) => s.time)).toEqual(["星期三", "2026-10-25", "3小时前", "前天"]);
  });

  it("非时间文本不作锚点（如纯数字、普通句子）", () => {
    const sessions = parseSessions(
      tree([
        ["Text", "123456"],
        ["Text", "收到"],
        ["Text", "张三"],
        ["Text", "刚刚"],
        ["Text", "ok"],
      ]),
    );
    expect(sessions).toEqual([session(["张三", "刚刚", "ok"])]);
  });
});

describe("extractCodes", () => {
  it("命中「验证码」形态（含间隔字）", () => {
    const hits = extractCodes([
      session(["张三", "刚刚", "你的验证码是 123456，5 分钟内有效"]),
    ]);
    expect(hits.map((h) => h.code)).toEqual(["123456"]);
  });

  it("命中「码：」与「code」形态", () => {
    const hits = extractCodes([
      session(["a", "刚刚", "【银行】登录码：998877 请勿泄露"]),
      session(["b", "昨天", "Your code: 4321"]),
    ]);
    expect(hits.map((h) => h.code)).toEqual(["998877", "4321"]);
  });

  it("逐会话只取首个命中的模式；无码会话跳过", () => {
    const hits = extractCodes([
      session(["无码", "昨天", "吃饭了吗"]),
      session(["双形态", "刚刚", "验证码 11112222，code 33334444"]),
    ]);
    expect(hits).toHaveLength(1);
    expect(hits[0].code).toBe("11112222");
  });

  it("码长边界：4 与 8 位命中，3 位不命中；9 位贪心取前 8 位（原型同行为）", () => {
    const hits = extractCodes([
      session(["a", "刚刚", "验证码 1234"]),
      session(["b", "刚刚", "验证码 12345678"]),
      session(["c", "刚刚", "验证码 123"]),
      session(["d", "刚刚", "验证码 123456789"]),
    ]);
    expect(hits.map((h) => h.code)).toEqual(["1234", "12345678", "12345678"]);
  });
});
