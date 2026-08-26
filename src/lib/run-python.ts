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
    let lastLine = '';
    let stderrTail = '';
    child.stdout.on('data', (d: Buffer) => {
      const text = d.toString();
      if (!opts.quiet) process.stderr.write(text);
      const lines = text.trim().split('\n').filter(Boolean);
      if (lines.length > 0) lastLine = lines[lines.length - 1];
    });
    child.stderr.on('data', (d: Buffer) => {
      const text = d.toString();
      if (!opts.quiet) process.stderr.write(text);
      stderrTail = (stderrTail + text).slice(-2000);
    });
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`python 退出码 ${code}\n${stderrTail}`));
      try {
        resolve(JSON.parse(lastLine));
      } catch {
        reject(new Error(`无法解析 python 输出: ${lastLine}\n${stderrTail}`));
      }
    });
  });
}
