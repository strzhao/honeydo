/** lmedia sfx — 音效模态：Dasheng-AudioGen 本地生成（Apache 2.0，MPS，零 API 成本）
 * 管线内置：质量门（峰值≥-25dBFS+SNR≥20dB，全废自动加掷≤2）→ 自动剪裁（10s→1-3s 签名音）→ 峰值归一 -6dBFS
 * 铁律：prompt 必须纯英文场景描述（"A friendly cartoon bear making soft grunting sounds"），中文会被英文文本编码器读成人声废片
 */
import type { Command } from 'commander';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveAudioRuntime } from '../lib/runtime.js';
import { runPython } from '../lib/run-python.js';

interface GenOpts {
  out?: string;
  rolls?: string;
  keepRolls?: boolean;
  full?: boolean; // 跳过剪裁保留 10s 原始
}

export function registerSfx(program: Command): void {
  const sfx = program.command('sfx').description('音效模态：Dasheng 本地生成（动物叫/事件音，10s→自动剪裁）');

  sfx
    .command('gen <prompt>')
    .description('文生音效。prompt 用英文描述声音场景（非拟声词）')
    .option('-o, --out <file>', '输出 wav 路径', 'sfx.wav')
    .option('--rolls <n>', '基础生成次数（全废自动加掷≤2）', '3')
    .option('--keep-rolls', '保留全部掷次到 <out>.rolls/ 目录')
    .option('--full', '跳过剪裁，保留 10s 原始生成')
    .action(async (prompt: string, opts: GenOpts) => {
      const rt = resolveAudioRuntime();
      if (!fs.existsSync(rt.pythonAudio)) {
        console.error(`音效 venv 未找到: ${rt.pythonAudio}\n` +
          `安装: cd ${rt.root} && uv venv .venv-audio --python 3.11 && ` +
          `uv pip install -p .venv-audio/bin/python torch torchaudio "transformers<5" einops soundfile`);
        process.exit(1);
      }
      const out = path.resolve(opts.out ?? 'sfx.wav');
      fs.mkdirSync(path.dirname(out), { recursive: true });
      console.error(`🎬 sfx gen（${opts.rolls} 掷 + 质量门 + 剪裁）…`);
      const r = await runPython(rt.pythonAudio, path.join(rt.pythonDir, 'sfx.py'), {
        prompt, out, rolls: opts.rolls, keepRolls: !!opts.keepRolls, trim: !opts.full,
      });
      const res = r as unknown as { out?: string; bestRoll?: number; peak?: number; snr?: number; dur?: number; gatePassed?: boolean };
      if (res.out) {
        console.error(`${res.gatePassed ? '✓' : '⚠️ 无合格掷（取峰值最高，建议重跑）'} best=r${res.bestRoll} peak=${res.peak}dB snr=${res.snr}dB → ${res.out} (${res.dur}s)`);
      }
    });
}
