import { execSync } from 'node:child_process';
import { Command } from 'commander';
import { healthCheck } from '../lib/api.js';
import { config } from '../lib/config.js';
import type { ModelItem } from '../lib/api.js';

async function tryPm2Status(): Promise<string | null> {
  try {
    const raw = execSync('pm2 jlist', { encoding: 'utf-8', timeout: 5_000 });
    const processes = JSON.parse(raw) as Array<Record<string, unknown>>;
    const qwenProcs = processes.filter(
      (p) =>
        (p.name as string)?.toLowerCase().includes('qwen') ||
        (p.pm2_env as Record<string, unknown>)?.status === 'online',
    );

    if (qwenProcs.length === 0) return null;

    const lines: string[] = [];
    for (const p of qwenProcs) {
      const monit = p.monit as Record<string, number> | undefined;
      const mem = monit ? `${(monit.memory / 1024 / 1024).toFixed(1)} MB` : 'N/A';
      const cpu = monit ? `${monit.cpu}%` : 'N/A';
      lines.push(
        `  ${p.name}  pid=${p.pid}  status=${p.pm2_env ? (p.pm2_env as Record<string, unknown>).status : 'N/A'}  mem=${mem}  cpu=${cpu}`,
      );
    }
    return lines.join('\n');
  } catch {
    return null;
  }
}

export function registerStatus(program: Command) {
  const cmd = new Command('status')
    .description('服务健康检查 + 模型信息 + PM2 进程状态')
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
      console.log('');

      // PM2 status
      const pm2Status = await tryPm2Status();
      if (pm2Status) {
        console.log('PM2 进程:');
        console.log(pm2Status);
      } else {
        console.log('PM2 进程:  不可用（未安装 pm2 或无 qwen 进程）');
      }
    });

  program.addCommand(cmd);
}
