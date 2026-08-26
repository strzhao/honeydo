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

export function resolveRuntime(): Runtime {
  const home = os.homedir();
  let root = process.env.LMEDIA_RUNTIME ?? '';
  if (!root) {
    const link = path.join(home, '.lmedia', 'runtime');
    if (fs.existsSync(link)) root = fs.realpathSync(link);
  }
  if (!root) root = path.join(home, 'ml', 'lb-local-gen');
  if (!fs.existsSync(root)) {
    throw new Error(
      `运行时未找到: ${root}\n` +
      `请设置 LMEDIA_RUNTIME 指向本地生成栈目录（含 .venv/.venv-train），或创建软链: mkdir -p ~/.lmedia && ln -s <栈目录> ~/.lmedia/runtime`
    );
  }
  const hf = path.join(home, '.cache', 'huggingface', 'hub');
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
    pythonDir: path.resolve(HERE, '..', 'python'),
  };
}
