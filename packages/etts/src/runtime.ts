/** venv 解析：ETTS_RUNTIME env > ~/.etts/venv（仓外轻量 venv，无重型栈）。
 *  python 驱动目录按 dist/tsx 双形态候选（lmedia 同款）。 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function venvRoot(): string {
  return process.env.ETTS_RUNTIME || path.join(os.homedir(), ".etts", "venv");
}

export function venvPython(): string {
  return path.join(venvRoot(), "bin", "python");
}

/** venv 可用时返回 null；缺失时返回契约错误文案（stderr + exit 1 由调用方执行） */
export function venvError(): string | null {
  const py = venvPython();
  if (fs.existsSync(py)) return null;
  return `etts: venv not found at ${venvRoot()}; run: etts setup`;
}

/** CLI 自带 python 驱动目录（<pkg>/python）。dist/cli.js 与 src/cli.ts（tsx dev）两种运行形态同解 */
export function pythonDriverDir(): string {
  const candidates = [
    path.resolve(HERE, "..", "python"), // dist/cli.js → <pkg>/python
    path.resolve(HERE, "..", "..", "python"), // 防御性：嵌套一层的产物形态
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, "etts.py"))) return c;
  }
  return candidates[0];
}

export function driverScript(): string {
  return path.join(pythonDriverDir(), "etts.py");
}
