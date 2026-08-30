/** LoRA 注册表：~/.config/limg/loras.json
 * 每个 LoRA：name / path / trigger / defaultWeight / kind（style|character|speed）
 * 首次运行自动播种内置三项（指向 ~/ml/lb-local-gen 已训练产物）。
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
  const home = os.homedir();
  const lb = path.join(home, 'ml', 'lb-local-gen');
  return [
    {
      name: 'lbwatercolor',
      path: path.join(lb, 'lora-out/style-house-v1/pytorch_lora_weights.safetensors'),
      trigger: 'lbwatercolor 水彩绘本插画',
      defaultWeight: 0.9,
      kind: 'style',
      note: 'Little Bee 房子风（30 页生产绘本训练）',
    },
    {
      name: 'pipi',
      path: path.join(lb, 'lora-out/pipi-v2/pytorch_lora_weights.safetensors'),
      trigger: 'pipi_bee 小蜜蜂男孩',
      defaultWeight: 1.0,
      kind: 'character',
      note: 'IP 角色·皮皮（蜜蜂男孩）',
    },
    {
      name: 'lightning2512',
      path: path.join(lb, 'loras/Qwen-Image-2512-Lightning-8steps-V1.0-bf16.safetensors'),
      trigger: '',
      defaultWeight: 1.0,
      kind: 'speed',
      note: 'LightX2V 8 步蒸馏加速（bf16 配 bf16 base 防 MPS dtype 提升降速；--fast 自动注入；4 步极速版同目录）',
    },
    {
      name: 'lightningedit2511',
      path: path.join(lb, 'loras/Qwen-Image-Edit-2511-Lightning-8steps-V1.0-bf16.safetensors'),
      trigger: '',
      defaultWeight: 1.0,
      kind: 'speed',
      note: 'LightX2V Edit-2511 8 步蒸馏加速（image edit --fast 自动注入，配套蒸馏调度器）',
    },
    {
      name: 'lightningedit2511x4',
      path: path.join(lb, 'loras/Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors'),
      trigger: '',
      defaultWeight: 1.0,
      kind: 'speed',
      note: 'LightX2V Edit-2511 4 步极速档（image edit --fast 4 优先匹配）',
    },
  ];
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
