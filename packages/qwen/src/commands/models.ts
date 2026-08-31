import { Command } from 'commander';
import { healthCheck } from '../lib/api.js';
import { config } from '../lib/config.js';

export function registerModels(program: Command) {
  const cmd = new Command('models')
    .description('列出可用模型')
    .action(async () => {
      try {
        const { models } = await healthCheck();

        if (models.ok && models.models && models.models.length > 0) {
          console.log(`可用模型 (${models.models.length} 个):`);
          console.log('');
          for (const m of models.models) {
            const marker = m.id === config.model ? ' ★ 默认' : '';
            console.log(`  ${m.id}${marker}`);
          }
        } else {
          console.log(`获取模型列表失败: ${models.error || '未知错误'}`);
          process.exit(1);
        }
      } catch (err) {
        console.error(`请求失败: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  program.addCommand(cmd);
}
