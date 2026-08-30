/** lmedia image serve — 常驻 daemon 生命周期管理（start/stop/status）。
 * gen/edit/upscale 命令会自动利用已运行的 daemon；daemon 不在时 gen/edit 自动拉起
 * （30min 空闲自退）。这里的手动三件套用于预加载、切换模式（--swap）和排障。
 */
import type { Command } from 'commander';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  DEFAULT_IDLE_TIMEOUT_SEC,
  logPath,
  otherMode,
  pingDaemon,
  readStatus,
  spawnDaemon,
  stopDaemon,
  type ServeMode,
} from '../lib/serve.js';

function parseMode(v: string): ServeMode {
  if (v !== 'gen' && v !== 'edit') {
    console.error('--mode 必须是 gen 或 edit');
    process.exit(2);
  }
  return v;
}

function registerStart(serve: Command): void {
  serve
    .command('start')
    .description('启动常驻推理 daemon（模型加载一次，后续任务免 ~2min 冷加载；空闲自动退出）')
    .requiredOption('--mode <m>', '管线：gen（Qwen-Image-2512）| edit（Qwen-Image-Edit-2511）')
    .option('--idle-timeout <sec>', '空闲自退秒数', String(DEFAULT_IDLE_TIMEOUT_SEC))
    .option('--wait', '阻塞等模型加载完成（默认立即返回，期间任务自动排队）')
    .option('--swap', '另一模式 daemon 在运行时先停它再启动（双驻 ~110GB 超本机内存）')
    .action(async (opts: { mode: string; idleTimeout: string; wait?: boolean; swap?: boolean }) => {
      const mode = parseMode(opts.mode);
      const idleTimeoutSec = parseInt(opts.idleTimeout, 10);
      if (!Number.isFinite(idleTimeoutSec) || idleTimeoutSec < 5) {
        console.error('--idle-timeout 需 ≥5 秒');
        process.exit(2);
      }
      const alive = await pingDaemon(mode);
      if (alive) {
        console.log(`${mode} daemon 已在运行（pid ${alive.pid}，${alive.state}，jobs ${alive.jobs}）`);
        return;
      }
      const other = await pingDaemon(otherMode(mode));
      if (other) {
        if (!opts.swap) {
          console.error(
            `✗ ${other.mode} daemon 正在运行（pid ${other.pid}）。双管线驻留 ~110GB 超出 128GB 机器；确认切换请加 --swap`
          );
          process.exit(1);
        }
        console.log(`--swap：先停 ${other.mode} daemon（pid ${other.pid}）…`);
        const r = await stopDaemon(other.mode);
        console.log(`  已${r === 'killed' ? '强制终止' : '停止'}`);
      }
      const r = await spawnDaemon(mode, { idleTimeoutSec });
      if (!r) {
        console.error(`✗ daemon 启动失败（20s 内未 bind socket）——现场日志：tail -50 ${logPath(mode)}`);
        process.exit(1);
      }
      console.log(`✓ ${mode} daemon 已启动（pid ${r.pid}）；模型加载中（~2 分钟），期间任务自动排队`);
      console.log(`  日志：tail -f ${logPath(mode)}`);
      if (!opts.wait) return;
      const deadline = Date.now() + 300_000;
      while (Date.now() < deadline) {
        const st = await pingDaemon(mode);
        if (st?.state === 'ready') {
          console.log(`✓ 就绪（pid ${st.pid}，jobs ${st.jobs}）`);
          return;
        }
        await sleep(2000);
      }
      console.error(`✗ 5 分钟未就绪——看日志：tail -50 ${logPath(mode)}`);
      process.exit(1);
    });
}

function registerStop(serve: Command): void {
  serve
    .command('stop')
    .description('停止 daemon（TERM → 15s → KILL；busy 时会中断当前任务）')
    .option('--mode <m>', 'gen | edit（缺省两模式都处理）')
    .action(async (opts: { mode?: string }) => {
      const modes: ServeMode[] = opts.mode ? [parseMode(opts.mode)] : ['gen', 'edit'];
      let any = false;
      for (const m of modes) {
        const st = await pingDaemon(m);
        if (st?.busy) console.error(`⚠️ ${m} daemon 正在跑任务，stop 将中断它（客户端会报错）`);
        const r = await stopDaemon(m);
        if (r === 'stopped') { console.log(`✓ ${m} daemon 已停止`); any = true; }
        else if (r === 'killed') { console.log(`✓ ${m} daemon 已 SIGKILL 强制终止（正常 TERM 未退）`); any = true; }
        else if (r === 'not-running-cleaned') console.log(`${m} daemon 未运行（已清理残留 socket/status）`);
        else console.log(`${m} daemon 未运行`);
      }
      if (!any && modes.length === 1) process.exit(1);
    });
}

function registerStatus(serve: Command): void {
  serve
    .command('status')
    .description('查看两模式 daemon 状态（运行中 / 残留 / 未运行）')
    .action(async () => {
      let anyRunning = false;
      for (const m of ['gen', 'edit'] as ServeMode[]) {
        const st = await pingDaemon(m);
        if (st) {
          anyRunning = true;
          const idle = st.lastJobAt ? Math.round((Date.now() / 1000 - st.lastJobAt) / 60) : '-';
          console.log(
            `✓ ${m}: pid ${st.pid}，${st.state}，queue ${st.queue}，jobs ${st.jobs}，上次任务 ${idle}min 前`
          );
          continue;
        }
        const saved = readStatus(m);
        if (saved) {
          console.log(`✗ ${m}: 残留状态（pid ${saved.pid} 已退出）—— lmedia image serve stop --mode ${m} 清理`);
        } else {
          console.log(`· ${m}: 未运行（可选加速；gen/edit 会自动拉起）`);
        }
      }
      process.exit(anyRunning ? 0 : 1);
    });
}

export function registerServe(image: Command): void {
  const serve = image
    .command('serve')
    .description('常驻推理 daemon（模型加载一次，任务免冷加载；空闲 30min 自动退出）');
  registerStart(serve);
  registerStop(serve);
  registerStatus(serve);
}
