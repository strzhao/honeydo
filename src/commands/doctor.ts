/** lmedia doctor — 环境自检（按模态列出） */
import type { Command } from 'commander';
import * as fs from 'node:fs';
import { resolveRuntime } from '../lib/runtime.js';
import { loadRegistry } from '../lib/registry.js';

export function registerDoctor(program: Command): void {
  program
    .command('doctor')
    .description('环境自检：运行时/模型快照/LoRA 文件完整性')
    .action(() => {
      try {
        const rt = resolveRuntime();
        const checks: [string, boolean][] = [
          ['runtime root', fs.existsSync(rt.root)],
          ['pythonGen (.venv-train)', fs.existsSync(rt.pythonGen)],
          ['pythonFast (.venv)', fs.existsSync(rt.pythonFast)],
          ['[image] Qwen-Image-2512 快照', fs.existsSync(rt.snapshot)],
          ['[image] Qwen-Image-Edit-2509 快照', fs.existsSync(rt.snapshotEdit)],
          ['[image] Real-ESRGAN 权重', fs.existsSync('/tmp/RealESRGAN_x2.pth')],
        ];
        for (const [name, ok] of checks) console.log(`${ok ? '✓' : '✗'} ${name}`);
        for (const l of loadRegistry()) {
          console.log(`${fs.existsSync(l.path) ? '✓' : '✗'} LoRA: ${l.name}`);
        }
        if (checks.every(([, ok]) => ok)) console.log('\n图像模态就绪。视频模态：规划中（lmedia video --help）');
      } catch (e) {
        console.error((e as Error).message);
        process.exit(1);
      }
    });
}
