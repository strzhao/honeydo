/** lmedia doctor — 环境自检（按模态列出） */
import type { Command } from 'commander';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveVideoRuntime } from '../lib/runtime.js';
import { loadRegistry } from '../lib/registry.js';
import { imagePreflight, readImageGate } from '../lib/image-state.js';
import { hasCommand } from '../lib/which.js';
import { pingDaemon, type ServeMode } from '../lib/serve.js';
import { sfxDoctorChecks } from './sfx.js';

export function registerDoctor(program: Command): void {
  program
    .command('doctor')
    .description('环境自检：运行时/模型快照/LoRA 文件完整性（能力开关见 lmedia image status）')
    .action(async () => {
      // —— [video] 检查独立于图像栈（云端/本地模态互不阻断）——
      const vrt = resolveVideoRuntime();
      const videoChecks: [string, boolean][] = [
        ['[video] .venv-video（mmh3turbo）', fs.existsSync(vrt.mmh3turbo)],
        ['[video] ffmpeg', hasCommand('ffmpeg')],
        ['[video] H3 权重（~/.cache/mmh3turbo，未就绪时首次生成自动下载或 setup --mirror）', fs.existsSync(path.join(vrt.weightsDir, 'dit.bin'))],
        ['[video] 加速档 bundle dit-turbo（--fast 用；缺失跑 lmedia video turbo-merge）', fs.existsSync(path.join(vrt.weightsDir, 'dit-turbo.bin'))],
      ];
      // —— 图像栈三态：故意放在 try 之外，状态文件损坏不能被通用 catch 吞成通用错误 ——
      // 「跳过」只发生在显式且合法的禁用态；损坏与「未禁用但资产缺失」一样按故障处理（不掩盖、不猜）
      const gate = readImageGate();
      let imageOk = true;
      if (gate.state === 'corrupt') {
        console.log(`✗ [image] 能力状态文件损坏（无法解析）→ ${gate.file}`);
        console.log(`  原因: ${gate.error}`);
        console.log(`  修复: lmedia image enable（用启用状态覆盖重写），或 rm ${gate.file}（删除后回到默认启用）`);
        imageOk = false;
      } else if (gate.state === 'disabled') {
        console.log(
          `· [image] 图像能力已禁用（${gate.file}${gate.disabledAt ? `，${gate.disabledAt}` : ''}${gate.reason ? `，原因: ${gate.reason}` : ''}）`,
        );
        console.log(`· runtime/venv/模型快照/LoRA 检查已跳过；恢复: lmedia image enable`);
      } else {
        const items = imagePreflight();
        for (const it of items) console.log(`${it.ok ? '✓' : '✗'} ${it.name}${it.ok ? '' : ` → ${it.fix}`}`);
        for (const l of loadRegistry()) {
          console.log(`${fs.existsSync(l.path) ? '✓' : '✗'} LoRA: ${l.name}`);
        }
        imageOk = items.every((i) => i.ok);
      }
      // daemon 是可选加速项，不计入就绪判定（未运行打 · 而非 ✗）——但「已禁用却仍在跑」是
      // 真故障：进程攥着已删权重的文件句柄，会让 rm 释放不出空间，且违背用户意图
      for (const m of ['gen', 'edit'] as ServeMode[]) {
        const st = await pingDaemon(m);
        if (st && gate.state === 'disabled') {
          console.log(`✗ [image] daemon ${m} 仍在运行（pid ${st.pid}）——图像能力已禁用；停止: lmedia image serve stop --mode ${m}`);
          imageOk = false;
          continue;
        }
        console.log(
          `${st ? '✓' : '·'} [image] daemon ${m}${st
            ? `: ${st.state}（pid ${st.pid}，jobs ${st.jobs}）`
            : gate.state === 'disabled'
              ? ': 未运行（能力已禁用，start 被拦截）'
              : ': 未运行（可选，lmedia image serve start --mode ' + m + '）'}`
        );
      }
      for (const [name, ok] of videoChecks) console.log(`${ok ? '✓' : '✗'} ${name}`);
      const videoOk = videoChecks[0][1] && videoChecks[1][1];
      // —— [sfx] 检查仅展示（同 video 待遇；sfx 权威自检走 lmedia sfx doctor，独立退出码）——
      const sfxChecks = sfxDoctorChecks();
      for (const [name, ok] of sfxChecks) console.log(`${ok ? '✓' : '✗'} ${name}`);
      const sfxOk = sfxChecks.every(([, ok]) => ok);
      const imageText =
        gate.state === 'corrupt' ? '能力状态损坏（修复指引见上）'
          : gate.state === 'disabled' ? `已禁用${imageOk ? '' : '（但 daemon 仍在运行，见上）'}`
            : imageOk ? '就绪' : '未就绪';
      console.log(
        `\n图像模态${imageText}。视频模态（本地 MiniMax-H3 / mmh3turbo）：${videoOk ? '就绪' : '未就绪（lmedia video setup）'}。` +
        `音效模态：${sfxOk ? '就绪' : '未就绪（lmedia sfx doctor 看修复指引）'}`
      );
      if (!imageOk) process.exit(1);
    });
}
