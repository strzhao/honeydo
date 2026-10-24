/**
 * hdc 设备访问 — 启动信息 App → 拍平 UI 树 → 拉回本地。
 *
 * 硬边界：手机锁屏时 `aa start` 报 10106102 被拒（鸿蒙禁止 hdc 自动解锁），
 * dumpLayout 产出空树 json（几十字节）——按内容量守卫（<1KB 判空）。
 *
 * 设备选择：SMS_HDC_TARGET env > ~/.smsctl/config.json（{"target":"..."}）
 *   > 恰有一台在线设备时自动选用；多台则报错列出设备。
 * hdc 可执行：SMS_HDC_PATH env > PATH 上的 hdc。
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

const BUNDLE = "com.ohos.mms";
const ABILITY = "com.ohos.mms.MainAbility";
const REMOTE = "/data/local/tmp/.smsctl_dump.json";
/** 锁屏时 dumpLayout 产出空树 json（几十字节），以内容量判有效性 */
const MIN_DUMP_BYTES = 1024;

function hdcBin(): string {
  return process.env.SMS_HDC_PATH || "hdc";
}

async function hdc(args: string[]): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileP(hdcBin(), args, {
      timeout: 60_000,
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        "找不到 hdc（HarmonyOS 命令行工具）。请确认已安装并在 PATH 上，或用 SMS_HDC_PATH 指定 hdc 可执行文件路径",
      );
    }
    throw e;
  }
}

function configTarget(): string | undefined {
  const file = path.join(os.homedir(), ".smsctl", "config.json");
  try {
    const cfg = JSON.parse(fs.readFileSync(file, "utf-8")) as { target?: string };
    if (cfg.target) return cfg.target;
  } catch {
    // 配置不存在/损坏都静默跳过，走自动探测
  }
  return undefined;
}

async function listTargets(): Promise<string[]> {
  const { stdout } = await hdc(["list", "targets"]);
  return stdout
    .split("\n")
    .map((l) => l.trim().split(/\s+/)[0])
    .filter((t): t is string => !!t);
}

/** 设备 key：env > 配置文件 > 单设备自动探测 */
export async function resolveTarget(): Promise<string> {
  const env = process.env.SMS_HDC_TARGET;
  if (env) return env;
  const cfg = configTarget();
  if (cfg) return cfg;
  const targets = await listTargets();
  if (targets.length === 1) return targets[0];
  if (targets.length === 0) {
    throw new Error(
      "无在线设备：hdc list targets 为空。请连接手机（USB/无线）后重试；或用 SMS_HDC_TARGET / ~/.smsctl/config.json（{\"target\":\"...\"}）指定设备 key",
    );
  }
  throw new Error(
    `多台设备在线，须指定 target（SMS_HDC_TARGET 或 ~/.smsctl/config.json）：\n  ${targets.join("\n  ")}`,
  );
}

/**
 * 拉取信息 App 的 UI dump 到本地临时文件，返回路径。
 * list/code 用完即删；dump 子命令保留文件交调试者处置。
 */
export async function dumpLayout(target: string): Promise<string> {
  // aa start 失败不阻断（锁屏时 dumpLayout 仍会产出空树，由内容量守卫兜底——
  // 与原型一致：远端 stderr 已丢弃，锁屏与否以 dump 内容量为准）
  try {
    await hdc([
      "-t",
      target,
      "shell",
      `aa start -b ${BUNDLE} -a ${ABILITY} >/dev/null 2>&1; sleep 2; ` +
        `uitest dumpLayout -b ${BUNDLE} -p ${REMOTE} >/dev/null 2>&1; test -s ${REMOTE}`,
    ]);
  } catch (e) {
    const err = e as { message?: string };
    throw new Error(
      `拉取 UI dump 失败：信息 App 未能启动或 dump 未生成。请确认手机亮屏已解锁、hdc 在线（hdc list targets）后重试${err.message ? `\n（${err.message}）` : ""}`,
    );
  }

  const tmp = path.join(os.tmpdir(), `smsctl.${process.pid}.${Date.now()}.json`);
  await hdc(["-t", target, "file", "recv", REMOTE, tmp]);
  // 远端临时文件即用即删（失败不阻断，下次 dump 会覆盖）
  await hdc(["-t", target, "shell", `rm -f ${REMOTE}`]).catch(() => {});

  if (fs.statSync(tmp).size < MIN_DUMP_BYTES) {
    fs.rmSync(tmp, { force: true });
    throw new Error(
      "dump 为空树：手机须亮屏且已解锁（鸿蒙禁止 hdc 自动解锁），解锁后重试",
    );
  }
  return tmp;
}
