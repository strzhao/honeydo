/** lmedia lora — LoRA 注册表管理 */
import type { Command } from 'commander';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { addLora, loadRegistry } from '../lib/registry.js';

export function registerLora(program: Command): void {
  const lora = program.command('lora').description('LoRA 注册表管理');
  lora
    .command('list')
    .description('列出已注册 LoRA')
    .action(() => {
      for (const l of loadRegistry()) {
        const exists = fs.existsSync(l.path) ? '✓' : '✗ 文件缺失';
        console.log(
          `${l.name}\t[${l.kind}]\tweight=${l.defaultWeight}\ttrigger="${l.trigger}"\t${exists}\n  ${l.path}${l.note ? `\n  ${l.note}` : ''}`
        );
      }
    });
  lora
    .command('add <name> <path>')
    .description('注册新 LoRA')
    .requiredOption('--kind <kind>', 'style|character|speed')
    .option('--trigger <text>', '触发词', '')
    .option('--weight <n>', '默认权重', '1.0')
    .option('--note <text>', '备注')
    .action(
      (
        name: string,
        p: string,
        opts: { kind: 'style' | 'character' | 'speed'; trigger: string; weight: string; note?: string }
      ) => {
        addLora({
          name,
          path: path.resolve(p),
          trigger: opts.trigger,
          defaultWeight: parseFloat(opts.weight),
          kind: opts.kind,
          note: opts.note,
        });
        console.log(`已注册 ${name}`);
      }
    );
}
