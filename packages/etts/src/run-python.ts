/** 统一 python 子进程执行（lmedia 同款）：spawn venv python [driver, JSON] → stdout 末行 JSON。
 *  环境（含 ETTS_PROXY/HTTPS_PROXY）原样继承透传；驱动 stderr（进度/重试标记）转发到本进程 stderr。 */
import { spawn } from "node:child_process";

export interface SynthResult {
  ok: boolean;
  out: string;
  attempts: number;
  error?: string;
}

export interface SynthPayloadResult {
  results: SynthResult[];
}

export interface VoiceEntry {
  shortName: string;
  gender: string;
  locale: string;
}

export interface VoicesPayloadResult {
  voices: VoiceEntry[];
}

export function runPython<T = Record<string, unknown>>(
  python: string,
  script: string,
  payload: Record<string, unknown>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const child = spawn(python, [script, JSON.stringify(payload)]);
    let stdoutBuf = "";
    let stderrTail = "";
    child.stdout.on("data", (d: Buffer) => {
      stdoutBuf += d.toString(); // 聚合整个 stdout 后取末行解析，规避 chunk 边界截断
    });
    child.stderr.on("data", (d: Buffer) => {
      const text = d.toString();
      process.stderr.write(text);
      stderrTail = (stderrTail + text).slice(-2000);
    });
    child.on("error", (err) => {
      reject(new Error(`failed to spawn python (${python}): ${err.message}`));
    });
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`python exited with code ${code}\n${stderrTail}`));
        return;
      }
      const lines = stdoutBuf.trim().split("\n").filter(Boolean);
      const lastLine = lines[lines.length - 1] ?? "";
      try {
        resolve(JSON.parse(lastLine) as T);
      } catch {
        reject(new Error(`cannot parse python output: ${lastLine}\n${stderrTail}`));
      }
    });
  });
}
