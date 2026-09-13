/** lmedia image disable|enable|status —— 图像能力一键开关。
 *
 * 退出码：0 可用/成功；1 能力被禁用·状态损坏·环境缺失·daemon 正忙（环境/状态类，非参数类）。
 * `status` 回答的是「现在能不能跑图像命令」——故 0 = 已启用**且**资产齐备，其余一律 1。
 */
import type { Command } from 'commander';
import { gateAdvice, imagePreflight, imageStatePath, readImageGate, writeImageState } from '../lib/image-state.js';
import { pingDaemon, stopDaemon, type ServeMode } from '../lib/serve.js';

const MODES: ServeMode[] = ['gen', 'edit'];

/** daemon 是否正忙（判据与 lib/serve.waitGpuIdle 一致） */
const isBusy = (st: { busy: boolean; queue: number }) => st.busy || st.queue > 0;

function registerDisable(image: Command): void {
  image
    .command('disable')
    .description('禁用图像能力：gen/edit/upscale/serve start 全部拦下（enable/status/serve stop 始终可用）')
    .option('--reason <text>', '记录禁用原因（写进状态文件）')
    .action(async (opts: { reason?: string }) => {
      const g = readImageGate();
      if (g.state === 'disabled') {
        console.log(`· 已是禁用态（未改写状态文件）`);
      }
      // —— daemon 处置：必须真停。进程攥着已删权重的 fd 时，rm 释放不出空间 ——
      let stopped = false;
      for (const m of MODES) {
        const st = await pingDaemon(m);
        if (!st) {
          console.log(`· ${m} daemon 未运行`);
          continue;
        }
        if (isBusy(st)) {
          console.error(
            `✗ ${m} daemon 正忙（pid ${st.pid}，jobs ${st.jobs}）——未写状态。\n` +
            `  等任务结束，或 lmedia image serve stop --mode ${m} 中断当前任务后重试。`,
          );
          process.exit(1);
        }
        const r = await stopDaemon(m);
        console.log(`✓ 已停止 ${m} daemon（pid ${st.pid}${r === 'killed' ? '，SIGKILL' : ''}）——释放常驻内存与文件句柄`);
        stopped = true;
      }
      if (g.state === 'corrupt') {
        console.error(`⚠️ 状态文件损坏，已用新状态覆盖: ${g.file}（${g.error}）`);
      }
      if (g.state !== 'disabled') {
        const file = writeImageState(false, { reason: opts.reason });
        console.log(`✓ 图像能力已禁用（${file}）`);
      }
      console.log(
        `  恢复: lmedia image enable\n` +
        `  云端替代: honeydo image gen "<prompt>" --engine doubao\n` +
        (stopped ? '' : `  提示: 删除权重前请确认 lmedia image serve status 无 daemon 在跑（持有文件句柄时 rm 不释放空间）\n`) +
        `  随后可手工清理（当前在位情况见 lmedia image status）`,
      );
    });
}

function registerEnable(image: Command): void {
  image
    .command('enable')
    .description('启用图像能力（本地权重/venv 若已清理会列出缺失项与重新下载指引）')
    .action(() => {
      const g = readImageGate();
      if (g.state === 'corrupt') {
        console.error(`⚠️ 状态文件损坏，已用新状态覆盖: ${g.file}（${g.error}）`);
      }
      const file = writeImageState(true);
      console.log(`✓ 图像能力已启用（${file}）`);
      const missing = imagePreflight().filter((i) => !i.ok);
      if (!missing.length) {
        console.log(`  本地图像资产齐备，可直接使用。`);
        return;
      }
      console.error(`⚠️ 但图像栈仍缺 ${missing.length} 项，暂不可用：`);
      for (const m of missing) console.error(`  ✗ ${m.name} → ${m.fix}`);
      console.error(`  磁盘需预留约 108GB（两个快照）；就绪后 lmedia doctor 复核`);
      process.exit(1);
    });
}

function registerStatus(image: Command): void {
  image
    .command('status')
    .description('查看图像能力开关状态与本地位在位情况（0=可跑图像命令；与 image serve status 看的是不同东西）')
    .action(async () => {
      const g = readImageGate();
      const label = g.state === 'disabled' ? '已禁用' : g.state === 'corrupt' ? '状态文件损坏' : '已启用';
      const when = g.state === 'disabled' && g.disabledAt ? `（${g.disabledAt}）` : '';
      const why = g.state !== 'corrupt' && g.reason ? ` · ${g.reason}` : '';
      console.log(`图像能力: ${label}${when}${why}`);
      console.log(`  状态文件: ${g.file}${g.state === 'enabled' && !g.present ? '（不存在=默认启用）' : ''}`);
      if (g.state !== 'enabled') console.log(gateAdvice(g).split('\n').map((l) => `  ${l}`).join('\n'));
      const items = imagePreflight();
      for (const i of items) {
        console.log(`  ${i.ok ? '✓' : '✗'} ${i.name}${i.ok ? '' : ` → ${i.fix}`}`);
      }
      for (const m of MODES) {
        const st = await pingDaemon(m);
        console.log(
          `  ${st ? (g.state === 'disabled' ? '✗' : '✓') : '·'} daemon ${m}` +
          (st ? `: ${st.state}（pid ${st.pid}，jobs ${st.jobs}）${g.state === 'disabled' ? '——能力已禁用却仍在跑，请 lmedia image serve stop' : ''}` : ': 未运行'),
        );
      }
      const usable = g.state === 'enabled' && items.every((i) => i.ok);
      process.exit(usable ? 0 : 1);
    });
}

export function registerImageCapability(image: Command): void {
  registerDisable(image);
  registerEnable(image);
  registerStatus(image);
}
