import { Command } from 'commander';
import { healthCheck } from '../lib/api.js';
import { config } from '../lib/config.js';

export function registerStatus(program: Command) {
  const cmd = new Command('status')
    .description('服务健康检查 + 模型信息')
    .action(async () => {
      console.log(`Qwen 服务: ${config.apiUrl}`);
      console.log(`默认模型: ${config.model}`);
      console.log('');

      // 健康检查
      const { health, models } = await healthCheck();

      // Health
      if (health.ok) {
        console.log('健康检查:  通过');
        if (health.health) {
          for (const [k, v] of Object.entries(health.health)) {
            console.log(`  ${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
          }
        }
      } else {
        console.log(`健康检查:  失败 (${health.error})`);
      }
      console.log('');

      // Models
      if (models.ok && models.models) {
        console.log(`可用模型:  ${models.models.length} 个`);
        for (const m of models.models) {
          const marker = m.id === config.model ? ' ← 默认' : '';
          console.log(`  - ${m.id}${marker}`);
        }
      } else {
        console.log(`模型列表:  获取失败 (${models.error})`);
      }
    });

  program.addCommand(cmd);
}
