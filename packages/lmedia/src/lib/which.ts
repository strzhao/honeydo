/** 检查命令是否在 PATH 上（macOS 自带 /usr/bin/which）。 */
import { spawnSync } from 'node:child_process';

export function hasCommand(cmd: string): boolean {
  return spawnSync('which', [cmd], { stdio: 'ignore' }).status === 0;
}
