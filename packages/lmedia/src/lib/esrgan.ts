/** Real-ESRGAN 权重路径解析：env > 标准缓存位 > 历史 /tmp 位（向后兼容） */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const ESRGAN_CACHE_PATH = path.join(os.homedir(), '.cache', 'lmedia', 'RealESRGAN_x2.pth');
const LEGACY_TMP_PATH = '/tmp/RealESRGAN_x2.pth';

export function resolveEsrganPath(): string {
  const env = process.env.LMEDIA_REALESRGAN_PATH;
  if (env && fs.existsSync(env)) return env;
  if (fs.existsSync(ESRGAN_CACHE_PATH)) return ESRGAN_CACHE_PATH;
  if (fs.existsSync(LEGACY_TMP_PATH)) return LEGACY_TMP_PATH;
  return process.env.LMEDIA_REALESRGAN_PATH ?? ESRGAN_CACHE_PATH;
}
