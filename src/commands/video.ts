/** lmedia video — 视频模态子树（预留，能力接入指南） */
import type { Command } from 'commander';

export function registerVideo(program: Command): void {
  const video = program.command('video').description('视频生产能力（规划中）');
  video
    .command('gen <prompt>')
    .description('【预留】图生视频/文生视频')
    .action(() => {
      console.error(`video 子树规划中，接入指南：
1. 本地候选（M4 Max 128GB 可跑）：LTX-Video / Mochi / Wan2.x（MLX 或 torch MPS）
2. 在 python/ 下新增 video-gen.py 驱动（参考 gen.py 的 JSON 入参/出参协议）
3. 在本文件注册 action 并接 runPython()
4. runtime.ts 的 Runtime 接口加视频模型快照字段
调研结论见 little-bee 绘本管线调研：微动循环场景（2-3s 首尾帧闭环）是绘本增强的甜点`);
      process.exit(1);
    });
}
