/**
 * 图像能力开关（`~/.config/limg/image-state.json`）。
 *
 * 存在意义：图像模型/venv 被清理出磁盘后，命令应以「已禁用 + 恢复指引」失败，而不是
 * 抛 `模型未下载: Qwen/Qwen-Image-2512`（runtime.ts:119）这类只有读代码才懂的错；
 * `lmedia doctor` 也不该因为图像段恒 ✗ 而永远 exit 1。
 *
 * 语义（与 sfx-library 的账本取向一致，但**允许被覆盖重写**）：
 * - 文件缺失 = 默认启用（绝大多数用户从未创建过它）
 * - 合法且 enabled=false = 禁用
 * - **损坏 = fail-closed，按禁用处理并报错**——开关若会被自己的状态文件损坏所击败就不叫开关；
 *   写入是 tmp+rename 原子写，损坏必来自外部干预，此时停下来问人比猜更尊重用户。
 *   但 `image enable/disable` 可用新状态**覆盖重写**修复它（开关没有可丢的数据，这点与
 *   sfx-library「绝不重建清单以免丢账」不同）。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { builtinAssetsRoot } from './h3-assets.js';
import { h3StackChecks, resolveH3Runtime } from './h3-runtime.js';

/** 状态文件路径覆盖（测试隔离 / 多栈并存用） */
export const IMAGE_STATE_ENV = 'LMEDIA_IMAGE_STATE';
/** 逃生口：置 1 绕过 gate（权重已恢复但暂不想改状态、或排障时用） */
export const IMAGE_GATE_BYPASS_ENV = 'LMEDIA_NO_IMAGE_GATE';

export function imageStatePath(): string {
  const env = process.env[IMAGE_STATE_ENV];
  if (env && env.trim()) return path.resolve(env.trim());
  return path.join(os.homedir(), '.config', 'limg', 'image-state.json');
}

export interface ImageState {
  enabled: boolean;
  disabledAt?: string;
  reason?: string;
}

export type ImageGate =
  | { state: 'enabled'; file: string; present: boolean; reason?: string }
  | { state: 'disabled'; file: string; present: true; disabledAt: string; reason?: string }
  | { state: 'corrupt'; file: string; error: string };

/** 禁用 / 状态损坏时由 assertImageEnabled 抛出；调用方打印后 exit 1 */
export class ImageDisabledError extends Error {}

/** 读开关（永不抛）：三态判别联合，调用方按需分支 */
export function readImageGate(): ImageGate {
  const file = imageStatePath();
  if (!fs.existsSync(file)) return { state: 'enabled', file, present: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (e) {
    return { state: 'corrupt', file, error: `不是合法 JSON（${(e as Error).message}）` };
  }
  const s = parsed as Partial<ImageState> | null;
  if (!s || typeof s !== 'object' || Array.isArray(s)) {
    return { state: 'corrupt', file, error: '根不是对象' };
  }
  if (typeof s.enabled !== 'boolean') {
    return { state: 'corrupt', file, error: '缺少 enabled 布尔字段' };
  }
  return s.enabled === false
    ? { state: 'disabled', file, present: true, disabledAt: s.disabledAt ?? '', reason: s.reason }
    : { state: 'enabled', file, present: true, reason: s.reason };
}

/** 原子写：tmp + rename（同 sfx-library.writeManifest），防中断写坏开关 */
export function writeImageState(enabled: boolean, opts: { reason?: string } = {}): string {
  const file = imageStatePath();
  const state: ImageState = enabled
    ? { enabled: true }
    : { enabled: false, disabledAt: new Date().toISOString(), ...(opts.reason ? { reason: opts.reason } : {}) };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
  fs.renameSync(tmp, file);
  return file;
}

/** 开关关闭时给用户的统一话术（gate 与 status 共用，避免两处漂移） */
export function gateAdvice(g: Extract<ImageGate, { state: 'disabled' | 'corrupt' }>): string {
  const head = g.state === 'disabled'
    ? `图像能力已禁用${g.disabledAt ? `（${g.disabledAt}）` : ''}${g.reason ? ` 原因: ${g.reason}` : ''}`
    : `图像能力状态文件损坏，拒绝执行图像命令（不猜）: ${g.file}\n  原因: ${g.error}`;
  return (
    `${head}\n` +
    `  恢复: lmedia image enable${g.state === 'corrupt' ? `（用启用状态覆盖重写）\n     或 rm ${g.file}（删除后回到默认启用）` : ''}\n` +
    `  查看: lmedia image status\n` +
    `  云端替代: honeydo image gen "<prompt>" --engine doubao\n` +
    `  （临时绕过: ${IMAGE_GATE_BYPASS_ENV}=1）`
  );
}

/**
 * gate：未禁用直接返回；禁用/损坏 → 抛 ImageDisabledError（调用方 exit 1）。
 * 退出码取 1（环境/状态类）：参数没错，是能力被关了，修复动作是 `image enable`。
 */
export function assertImageEnabled(what: string): void {
  if (process.env[IMAGE_GATE_BYPASS_ENV] === '1') {
    const g = readImageGate();
    if (g.state !== 'enabled') {
      console.error(`⚠️ ${IMAGE_GATE_BYPASS_ENV}=1：已绕过图像能力 gate（当前为${g.state === 'disabled' ? '禁用' : '损坏'}态）`);
    }
    return;
  }
  const g = readImageGate();
  if (g.state === 'enabled') return;
  throw new ImageDisabledError(`${gateAdvice(g)}\n  （被拦截的命令: ${what}）`);
}

export interface PreflightItem {
  name: string;
  ok: boolean;
  fix: string;
}

/**
 * 图像栈就绪性检查（doctor 与 `image enable/status` 共用；**永不抛**）。
 * 2026-11 H3 迁移：检查项从 Qwen 快照/ESRGAN 换为 H3 栈（venv / 双权重分片 / 出厂资产）——
 * 细项与 fix 指引统一在 h3-runtime.h3StackChecks（doctor/setup/preflight 三处共用，避免漂移）。
 */
export function imagePreflight(): PreflightItem[] {
  return h3StackChecks(resolveH3Runtime(), builtinAssetsRoot());
}
