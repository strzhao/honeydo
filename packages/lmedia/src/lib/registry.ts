/** LoRA 注册表：~/.config/limg/loras.json
 * 每个 LoRA：name / path / trigger / defaultWeight / kind（style|character|speed）
 * 首次运行播种为空表——用 `lmedia lora add <name> <path> --kind ...` 自行登记。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface LoraEntry {
  name: string;
  path: string;
  trigger: string;
  defaultWeight: number;
  kind: 'style' | 'character' | 'speed';
  note?: string;
}

const REGISTRY_DIR = path.join(os.homedir(), '.config', 'limg');
const REGISTRY_PATH = path.join(REGISTRY_DIR, 'loras.json');

function seed(): LoraEntry[] {
  return [];
}

export function loadRegistry(): LoraEntry[] {
  if (!fs.existsSync(REGISTRY_PATH)) {
    fs.mkdirSync(REGISTRY_DIR, { recursive: true });
    fs.writeFileSync(REGISTRY_PATH, JSON.stringify(seed(), null, 2));
  }
  return JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf-8')) as LoraEntry[];
}

export function findLora(name: string): LoraEntry | undefined {
  return loadRegistry().find((l) => l.name === name);
}

export function addLora(entry: LoraEntry): void {
  const list = loadRegistry().filter((l) => l.name !== entry.name);
  list.push(entry);
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(list, null, 2));
}
