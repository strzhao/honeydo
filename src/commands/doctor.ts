/** lmedia doctor — 环境自检（按模态列出） */
import type { Command } from 'commander';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveRuntime, resolveVideoRuntime } from '../lib/runtime.js';
import { loadRegistry } from '../lib/registry.js';
import { hasCommand } from '../lib/which.js';

export function registerDoctor(program: Command): void {
  program
    .command('doctor')
    .description('环境自检：运行时/模型快照/LoRA 文件完整性')
    .action(() => {
      // —— [video] 检查独立于图像栈（云端/本地模态互不阻断）——
      const vrt = resolveVideoRuntime();
      const videoChecks: [string, boolean][] = [
        ['[video] .venv-video（mmh3turbo）', fs.existsSync(vrt.mmh3turbo)],
        ['[video] ffmpeg', hasCommand('ffmpeg')],
        ['[video] H3 权重（~/.cache/mmh3turbo，未就绪时首次生成自动下载或 setup --mirror）', fs.existsSync(path.join(vrt.weightsDir, 'dit.bin'))],
      ];
      // —— 图像栈（缺失时打印错误但继续输出 [video] 部分）——
      let imageOk = true;
      try {
        const rt = resolveRuntime();
        const checks: [string, boolean][] = [
          ['runtime root', fs.existsSync(rt.root)],
          ['pythonGen (.venv-train)', fs.existsSync(rt.pythonGen)],
          ['pythonFast (.venv)', fs.existsSync(rt.pythonFast)],
          ['[image] Qwen-Image-2512 快照', fs.existsSync(rt.snapshot)],
          ['[image] Qwen-Image-Edit-2511 快照', fs.existsSync(rt.snapshotEdit)],
          ['[image] Real-ESRGAN 权重', fs.existsSync('/tmp/RealESRGAN_x2.pth')],
        ];
        for (const [name, ok] of checks) console.log(`${ok ? '✓' : '✗'} ${name}`);
        for (const l of loadRegistry()) {
          console.log(`${fs.existsSync(l.path) ? '✓' : '✗'} LoRA: ${l.name}`);
        }
        imageOk = checks.every(([, ok]) => ok);
      } catch (e) {
        imageOk = false;
        console.error((e as Error).message);
      }
      for (const [name, ok] of videoChecks) console.log(`${ok ? '✓' : '✗'} ${name}`);
      const videoOk = videoChecks[0][1] && videoChecks[1][1];
      console.log(
        `\n图像模态${imageOk ? '就绪' : '未就绪'}。视频模态（本地 MiniMax-H3 / mmh3turbo）：${videoOk ? '就绪' : '未就绪（lmedia video setup）'}`
      );
      if (!imageOk) process.exit(1);
    });
}
