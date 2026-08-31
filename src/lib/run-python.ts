/** 统一 Python 子进程执行：spawn 流式透传 + 取最后一行 JSON 作为结果。 */
import { spawn } from 'node:child_process';

export interface PyResult {
  out?: string;
  seconds?: number;
  [k: string]: unknown;
}

export function runPython(
  python: string,
  script: string,
  payload: Record<string, unknown>,
  opts: { quiet?: boolean } = {}
): Promise<PyResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(python, [script, JSON.stringify(payload)], {
      env: { ...process.env, HF_HUB_OFFLINE: process.env.HF_HUB_OFFLINE ?? '1' },
    });
    let stdoutBuf = '';
    let stderrTail = '';
    child.stdout.on('data', (d: Buffer) => {
      const text = d.toString();
      if (!opts.quiet) process.stderr.write(text);
      stdoutBuf += text; // 聚合整个 stdout 后取末行解析，规避结果行被 chunk 边界截断
    });
    child.stderr.on('data', (d: Buffer) => {
      const text = d.toString();
      if (!opts.quiet) process.stderr.write(text);
      stderrTail = (stderrTail + text).slice(-2000);
    });
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`python 退出码 ${code}\n${stderrTail}`));
      const lines = stdoutBuf.trim().split('\n').filter(Boolean);
      const lastLine = lines[lines.length - 1] ?? '';
      try {
        resolve(JSON.parse(lastLine));
      } catch {
        reject(new Error(`无法解析 python 输出: ${lastLine}\n${stderrTail}`));
      }
    });
  });
}
