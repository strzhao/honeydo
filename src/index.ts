#!/usr/bin/env node
import { Command } from 'commander';
import { registerAsk } from './commands/ask.js';
import { registerVision } from './commands/vision.js';
import { registerStatus } from './commands/status.js';
import { registerModels } from './commands/models.js';

const program = new Command();

program
  .name('qwen')
  .description('Qwen API CLI — 封装 Qwen API 为独立命令行工具')
  .version('0.1.0');

registerAsk(program);
registerVision(program);
registerStatus(program);
registerModels(program);

program.parse();
