/** 运行时解析：Python venv + 模型快照路径。
 * 优先级：LMEDIA_RUNTIME env > ~/.lmedia/runtime（symlink）> ~/ml/lb-local-gen（默认）
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export interface Runtime {
  root: string;
  pythonGen: string;    // 推理 venv（diffusers bf16 + LoRA）
  pythonFast: string;   // mflux venv（Q8 / Lightning）
  snapshot: string;     // Qwen-Image-2512 快照
  snapshotEdit: string; // Qwen-Image-Edit-2511 快照
  pythonDir: string;    // CLI 自带 python 驱动目录
}

/** 视频模态运行时（独立于图像栈：不触碰模型快照解析，快照缺失不阻断视频命令） */
export interface VideoRuntime {
  root: string;
  venvVideo: string;   // mmh3turbo venv（MLX int8 Metal kernel）
  pythonVideo: string; // <root>/.venv-video/bin/python
  mmh3turbo: string;   // mmh3turbo 可执行文件
  weightsDir: string;  // H3 权重本地目录 ~/.cache/mmh3turbo（dit.bin 等就绪即免下载）
}

/** 音效模态运行时（Dasheng-AudioGen，transformers<5 + MPS） */
export interface AudioRuntime {
  root: string;
  pythonAudio: string; // <root>/.venv-audio/bin/python
  pythonDir: string;   // CLI 自带 python 驱动目录（与 Runtime.pythonDir 同源）
}

/** 栈目录候选路径（不校验存在性；setup 可据此创建） */
function rootCandidate(): string {
  const home = os.homedir();
  let root = process.env.LMEDIA_RUNTIME ?? '';
  if (!root) {
    const link = path.join(home, '.lmedia', 'runtime');
    if (fs.existsSync(link)) root = fs.realpathSync(link);
  }
  if (!root) root = path.join(home, 'ml', 'lb-local-gen');
  return root;
}

/** CLI 自带 python 驱动目录（<root>/python）。dist 与 tsx 源码两种运行形态都兼容 */
function pythonDriverDir(): string {
  const candidates = [
    path.resolve(HERE, '..', 'python'),      // dist/index.js → <pkg>/python
    path.resolve(HERE, '..', '..', 'python'), // src/lib/runtime.ts（tsx dev）→ <pkg>/python
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'sfx.py'))) return c;
  }
  return candidates[0];
}

export function resolveVideoRuntime(): VideoRuntime {
  const root = rootCandidate();
  return {
    root,
    venvVideo: path.join(root, '.venv-video'),
    pythonVideo: path.join(root, '.venv-video', 'bin', 'python'),
    mmh3turbo: path.join(root, '.venv-video', 'bin', 'mmh3turbo'),
    weightsDir: path.join(os.homedir(), '.cache', 'mmh3turbo'),
  };
}

export function resolveAudioRuntime(): AudioRuntime {
  const root = rootCandidate();
  return {
    root,
    pythonAudio: path.join(root, '.venv-audio', 'bin', 'python'),
    pythonDir: pythonDriverDir(),
  };
}

/** HF 缓存根：HF_HUB_CACHE > $HF_HOME/hub > ~/.cache/huggingface/hub */
export function hfHubCache(): string {
  if (process.env.HF_HUB_CACHE) return process.env.HF_HUB_CACHE;
  if (process.env.HF_HOME) return path.join(process.env.HF_HOME, 'hub');
  return path.join(os.homedir(), '.cache', 'huggingface', 'hub');
}

/** repo 在 HF 缓存中的快照目录；未下载/快照为空返回 null（doctor 自检用） */
export function hfSnapshot(repo: string): string | null {
  const dir = path.join(hfHubCache(), `models--${repo.replace('/', '--')}`, 'snapshots');
  if (!fs.existsSync(dir)) return null;
  const snaps = fs.readdirSync(dir).filter((s) => !s.startsWith('.'));
  return snaps.length ? path.join(dir, snaps[0]) : null;
}

export function resolveRuntime(): Runtime {
  const root = rootCandidate();
  if (!fs.existsSync(root)) {
    throw new Error(
      `运行时未找到: ${root}\n` +
      `请设置 LMEDIA_RUNTIME 指向本地生成栈目录（含 .venv/.venv-train），或创建软链: mkdir -p ~/.lmedia && ln -s <栈目录> ~/.lmedia/runtime`
    );
  }
  const hf = path.join(os.homedir(), '.cache', 'huggingface', 'hub');
  const snapOf = (repo: string) => {
    const modelDir = path.join(hf, `models--${repo.replace('/', '--')}`);
    const dir = path.join(modelDir, 'snapshots');
    if (!fs.existsSync(dir)) throw new Error(`模型未下载: ${repo}（先运行 lmedia doctor 安装指引）`);
    const snaps = fs.readdirSync(dir);
    if (snaps.length === 0) throw new Error(`模型快照为空: ${repo}`);
    // 优先 refs/main 指向的快照（同一 repo 可能有多个快照目录，断点续传后更甚）
    const refFile = path.join(modelDir, 'refs', 'main');
    if (fs.existsSync(refFile)) {
      const ref = fs.readFileSync(refFile, 'utf-8').trim();
      if (snaps.includes(ref)) return path.join(dir, ref);
    }
    return path.join(dir, snaps[0]);
  };
  return {
    root,
    pythonGen: path.join(root, '.venv-train', 'bin', 'python'),
    pythonFast: path.join(root, '.venv', 'bin', 'python'),
    snapshot: snapOf('Qwen/Qwen-Image-2512'),
    snapshotEdit: snapOf('Qwen/Qwen-Image-Edit-2511'),
    pythonDir: pythonDriverDir(),
  };
}
