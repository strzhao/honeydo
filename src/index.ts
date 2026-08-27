#!/usr/bin/env node
import { Command } from 'commander';
import { registerImage } from './commands/image.js';
import { registerVideo } from './commands/video.js';
import { registerLora } from './commands/lora.js';
import { registerDoctor } from './commands/doctor.js';
import { registerSfx } from './commands/sfx.js';

const program = new Command();

program
  .name('lmedia')
  .description('本地媒体生产 CLI — 图像/视频（本地推理，零 API 成本）+ LoRA 注册表。Apple Silicon')
  .version('0.1.0');

registerImage(program);
registerVideo(program);
registerLora(program);
registerDoctor(program);
registerSfx(program);

program.parse();
