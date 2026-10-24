#!/usr/bin/env node
/**
 * smsctl — 从 Pura X Max（鸿蒙）拉取短信会话/验证码，供 agent 自助登录/绑定。
 *
 * 前提：hdc 在线 + 手机亮屏已解锁（鸿蒙禁止 hdc 自动解锁锁屏设备）。
 * 退出码：0 成功 / 1 运行错误（锁屏、无设备等）/ 2 参数错误。
 */
import * as fs from "node:fs";
import { Command } from "commander";
import { dumpLayout, resolveTarget } from "./device.js";
import {
  parseSessions,
  extractCodes,
  type DumpNode,
  type Session,
} from "./parse.js";

const program = new Command();

program
  .name("smsctl")
  .description(
    "从鸿蒙手机拉取短信会话/验证码。前提：hdc 在线 + 手机亮屏已解锁（鸿蒙禁止 hdc 自动解锁锁屏设备）；" +
      "设备 key 用 SMS_HDC_TARGET 或 ~/.smsctl/config.json（{\"target\":\"...\"}）指定，缺省单设备自动探测",
  )
  .version("0.1.0");

/** dump → 解析 → 临时文件即用即删（不落敏感内容） */
async function loadSessions(): Promise<Session[]> {
  const target = await resolveTarget();
  const file = await dumpLayout(target);
  try {
    const dump = JSON.parse(fs.readFileSync(file, "utf-8")) as DumpNode;
    return parseSessions(dump);
  } finally {
    fs.rmSync(file, { force: true });
  }
}

program
  .command("list")
  .description("列最近 N 条会话（默认 10）：发送者 | 时间 | 正文预览")
  .argument("[n]", "条数", "10")
  .action(async (n: string) => {
    const count = Number(n);
    if (!Number.isInteger(count) || count <= 0) {
      process.stderr.write(`smsctl: 条数须为正整数，收到「${n}」\n`);
      process.exit(2);
    }
    const sessions = await loadSessions();
    for (const s of sessions.slice(0, count)) {
      process.stdout.write(
        `${s.sender.padEnd(18)} ${s.time.padEnd(10)} ${s.preview}\n`,
      );
    }
  });

program
  .command("code")
  .description("提取验证码（默认扫最近会话；--from 按发送者/正文关键词过滤，大小写不敏感）")
  .option("--from <关键词>", "按发送者/正文关键词过滤")
  .action(async (opts: { from?: string }) => {
    let sessions = await loadSessions();
    if (opts.from) {
      const kw = opts.from.toLowerCase();
      sessions = sessions.filter((s) =>
        `${s.sender}\t${s.time}\t${s.preview}`.toLowerCase().includes(kw),
      );
      if (sessions.length === 0) {
        process.stderr.write(`无匹配「${opts.from}」的会话\n`);
        process.exit(1);
      }
    }
    const hits = extractCodes(sessions).slice(0, 5);
    if (hits.length === 0) {
      process.stdout.write("最近会话中未发现验证码\n");
      return;
    }
    for (const h of hits) {
      process.stdout.write(`[${h.sender} · ${h.time}] 验证码 ${h.code}\n    ${h.preview}\n`);
    }
  });

program
  .command("dump")
  .description("拉取原始 UI dump JSON 到本地临时文件并打印路径（调试用，文件保留）")
  .action(async () => {
    const target = await resolveTarget();
    process.stdout.write(`${await dumpLayout(target)}\n`);
  });

program.parseAsync().catch((e: unknown) => {
  process.stderr.write(`smsctl: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
