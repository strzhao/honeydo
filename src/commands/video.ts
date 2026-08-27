/** lmedia video — 视频模态子树：MiniMax-H3 本地生成（mmh3turbo，MLX int8 Metal kernel，零 API 成本）
 * 权重 ~33GB 首次生成自动下载（HF 缓存）；当前为 FL2VA（文生 + 首帧图生视频），Ref2VA 参考生暂未支持。
 */
import type { Command } from 'commander';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveVideoRuntime } from '../lib/runtime.js';
import { hasCommand } from '../lib/which.js';

const RES_PRESETS = [
  '256p', '352p', '480p', '576p', '704p', '720p', '768p',
  'square', 'portrait', 'vertical', // 竖版/方版（绘本竖页用 portrait）
];

interface GenOpts {
  out?: string;
  res?: string;
  seconds?: string;
  steps?: string;
  seed?: string;
  firstFrame?: string;
}

/** 前台跑一条安装步骤，失败即退出（setup 用） */
function runStep(cmd: string, args: string[]): void {
  const r = spawnSync(cmd, args, { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`步骤失败: ${cmd} ${args.join(' ')}（退出码 ${r.status}）`);
    process.exit(1);
  }
}

/** mmh3turbo 0.1.0 已知漂移：上游 GGUF 文件已改名，装完自动补丁（幂等） */
function patchGgufFilename(venvVideo: string): void {
  const libDir = path.join(venvVideo, 'lib');
  if (!fs.existsSync(libDir)) return;
  const pyDir = fs.readdirSync(libDir).find((d) => d.startsWith('python'));
  if (!pyDir) return;
  const w = path.join(libDir, pyDir, 'site-packages', 'mmh3turbo', 'weights.py');
  if (!fs.existsSync(w)) return;
  const src = fs.readFileSync(w, 'utf8');
  const OLD = 'MiniMax-H3-Qwen3VL-32B-TextEncoder-Q2_K.gguf';
  const NEW = 'qwen3vl-32B-MiniMax-H3-Q2_K.gguf';
  if (src.includes(OLD)) {
    fs.writeFileSync(w, src.replaceAll(OLD, NEW));
    console.error(`已修补 mmh3turbo 上游 GGUF 文件名漂移（${OLD} → ${NEW}）`);
  }
}

/** 镜像预置：huggingface_hub 客户端与 hf-mirror 重定向不兼容时，用 curl 直接落盘（断点续传） */
const MIRROR = 'https://hf-mirror.com';
const MIRROR_FILES: { repo: string; dest: string; bytes?: number }[] = [
  { repo: 'yunfengwang/mmh3turbo-bundles', dest: '~/.cache/mmh3turbo/dit.bin', bytes: 20967495552 },
  { repo: 'yunfengwang/mmh3turbo-bundles', dest: '~/.cache/mmh3turbo/dit.idx' }, // 尺寸运行时探测
  { repo: 'yunfengwang/mmh3turbo-bundles', dest: '~/.cache/mmh3turbo/qwen3vl_4bit.safetensors', bytes: 15239339391 },
  { repo: 'realrebelai/MiniMax-H3_GGUFs', dest: '~/.cache/huggingface/hub/models--realrebelai--MiniMax-H3_GGUFs/blobs/qwen3vl-32B-MiniMax-H3-Q2_K.gguf', bytes: 8487968160 },
  { repo: 'Comfy-Org/MiniMax-H3', dest: '~/.cache/huggingface/hub/models--Comfy-Org--MiniMax-H3/blobs/minimax_h3_video_vae_fp16.safetensors', bytes: 5207808496 },
  { repo: 'Comfy-Org/MiniMax-H3', dest: '~/.cache/huggingface/hub/models--Comfy-Org--MiniMax-H3/blobs/minimax_h3_audio_vae_fp32.safetensors', bytes: 605254808 },
];

function remoteSize(url: string): number {
  const r = spawnSync('curl', ['-sIL', '--max-time', '20', url], { encoding: 'utf8' });
  const m = (r.stdout ?? '').match(/content-length:\s*(\d+)/i);
  return m ? parseInt(m[1], 10) : 0;
}

function mirrorProvision(): void {
  for (const f of MIRROR_FILES) {
    const dest = f.dest.replace(/^~/, os.homedir());
    const url = f.repo === 'Comfy-Org/MiniMax-H3'
      ? `${MIRROR}/${f.repo}/resolve/main/vae/${path.basename(dest)}` // VAE 在 vae/ 子目录
      : `${MIRROR}/${f.repo}/resolve/main/${path.basename(dest)}`;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (fs.existsSync(dest) && fs.statSync(dest).size === f.bytes) {
      console.error(`已就位: ${dest}`);
      continue;
    }
    const expect = f.bytes ?? remoteSize(url);
    console.error(`下载 ${path.basename(dest)}（${(expect / 1e9).toFixed(1)} GB）→ ${dest}`);
    for (let attempt = 1; ; attempt++) {
      const r = spawnSync(
        'curl', ['-L', '-C', '-', '--retry', '8', '--retry-delay', '3', '--connect-timeout', '20', '-o', `${dest}.part`, url],
        { stdio: 'inherit' }
      );
      if (r.status === 0) break;
      if (attempt >= 5) {
        console.error(`下载失败（已试 ${attempt} 轮）: ${url}`);
        process.exit(1);
      }
      console.error(`下载中断，5 秒后续传（第 ${attempt} 轮）…`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000); // sleep 5s
    }
    fs.renameSync(`${dest}.part`, dest);
    const got = fs.statSync(dest).size;
    if (expect && got !== expect) {
      console.error(`大小校验失败: ${dest} got=${got} expect=${expect}`);
      process.exit(1);
    }
  }
  console.log('H3 权重镜像预置完成（~/.cache/mmh3turbo + HF blobs，mmh3turbo 全部本地命中，不再走网络）');
}

function registerSetup(video: Command): void {
  video
    .command('setup')
    .description('创建 .venv-video 并安装 mmh3turbo（MiniMax-H3 MLX 引擎，Apple Silicon）')
    .option('--mirror', '用 hf-mirror.com + curl 预置 H3 权重（~50GB，国内推荐；huggingface_hub 客户端与镜像重定向不兼容时的正解）')
    .action((opts: { mirror?: boolean }) => {
      const rt = resolveVideoRuntime();
      fs.mkdirSync(rt.root, { recursive: true });
      if (!hasCommand('ffmpeg')) {
        console.error('⚠️  未找到 ffmpeg（mp4 封装必需）：brew install ffmpeg');
      }
      if (!fs.existsSync(rt.pythonVideo)) {
        console.error(`创建 venv: ${rt.venvVideo}`);
        if (hasCommand('uv')) runStep('uv', ['venv', '--python', '3.12', rt.venvVideo]);
        else runStep('python3', ['-m', 'venv', rt.venvVideo]);
      }
      console.error('安装/升级 mmh3turbo …');
      if (hasCommand('uv')) {
        runStep('uv', ['pip', 'install', '--python', rt.pythonVideo, '--upgrade', 'mmh3turbo']);
      } else {
        runStep(rt.pythonVideo, ['-m', 'pip', 'install', '--upgrade', 'mmh3turbo']);
      }
      patchGgufFilename(rt.venvVideo);
      if (opts.mirror) {
        mirrorProvision();
      } else {
        console.log(`视频运行时就绪: ${rt.mmh3turbo}`);
        console.log('首次 lmedia video gen 会自动下载 H3 权重（~33GB，需能直连 huggingface.co）；国内推荐改用: lmedia video setup --mirror');
      }
    });
}

function registerGen(video: Command): void {
  video
    .command('gen <prompt>')
    .description('文生视频/首帧图生视频：MiniMax-H3 本地（默认 480p / 5s / 12 步，mp4 含立体声音轨）')
    .option('-o, --out <path>', '输出 mp4 路径', `lmedia-video-${Date.now()}.mp4`)
    .option('-r, --res <preset>', `分辨率档：${RES_PRESETS.join('|')}（lmedia video list-res 看实际画布）`, '480p')
    .option('--seconds <s>', '片段时长秒（1-15）', '5')
    .option('--steps <n>', '去噪步数（12 步与 20 步视觉不可区分，4/8 步明显掉质）', '12')
    .option('--seed <n>', '随机种子', '42')
    .option('--first-frame <path>', '首帧图（图生视频；推荐衔接 lmedia image gen 产物）')
    .action(async (prompt: string, opts: GenOpts) => {
      // —— 参数校验（退出码 2，同 lora 约定）——
      const res = opts.res!;
      const seconds = parseFloat(opts.seconds!);
      const steps = parseInt(opts.steps!, 10);
      const seed = parseInt(opts.seed!, 10);
      if (!RES_PRESETS.includes(res)) {
        console.error(`--res 仅支持 ${RES_PRESETS.join('|')}（当前 ${res}）`);
        process.exit(2);
      }
      if (!Number.isFinite(seconds) || seconds < 1 || seconds > 15) {
        console.error(`--seconds 需为 1-15 的数字（当前 ${opts.seconds}）`);
        process.exit(2);
      }
      if (!Number.isInteger(steps) || steps < 1 || steps > 50) {
        console.error(`--steps 需为 1-50 的整数（当前 ${opts.steps}）`);
        process.exit(2);
      }
      if (!Number.isInteger(seed)) {
        console.error(`--seed 需为整数（当前 ${opts.seed}）`);
        process.exit(2);
      }
      if (opts.firstFrame && !fs.existsSync(opts.firstFrame)) {
        console.error(`首帧图不存在: ${opts.firstFrame}`);
        process.exit(2);
      }
      // —— 环境校验（退出码 1）——
      const rt = resolveVideoRuntime();
      if (!fs.existsSync(rt.mmh3turbo)) {
        console.error(`mmh3turbo 未安装（${rt.venvVideo}）。先运行: lmedia video setup`);
        process.exit(1);
      }
      if (!hasCommand('ffmpeg')) {
        console.error('未找到 ffmpeg（mp4 封装必需）：brew install ffmpeg 后重试');
        process.exit(1);
      }
      // 中文短 prompt 提醒：H3 全注意力下文本 token 占比过低会被 seed 主导
      if (/[一-鿿]/.test(prompt) && prompt.length < 20) {
        console.error(`提示: 中文 prompt 建议 30-50 字（当前 ${prompt.length} 字），太短易被 seed 主导（换 prompt 画面不变）`);
      }
      const runDir = path.join(os.homedir(), '.lmedia', 'video-runs', `${Date.now()}`);
      fs.mkdirSync(runDir, { recursive: true });
      const args = [
        prompt,
        '-r', res,
        '--seconds', String(seconds),
        '--steps', String(steps),
        '--seed', String(seed),
        '-o', runDir,
      ];
      if (opts.firstFrame) args.push('--first-frame', path.resolve(opts.firstFrame));
      console.error(`mmh3turbo · ${res} · ${seconds}s · ${steps} 步 · seed ${seed} → ${runDir}`);
      const t0 = Date.now();
      // 不走 runPython()：它会注入 HF_HUB_OFFLINE=1，阻断首次权重下载
      const env = { ...process.env };
      const weightsReady = fs.existsSync(path.join(rt.weightsDir, 'dit.bin'));
      if (!weightsReady && env.HF_HUB_OFFLINE === '1') {
        console.error('提示: 检测到 HF_HUB_OFFLINE=1 且 H3 权重未就绪，本次临时关闭以拉取权重（国内推荐 lmedia video setup --mirror）');
        env.HF_HUB_OFFLINE = '0';
      }
      const code = await new Promise<number>((resolve) => {
        const child = spawn(rt.mmh3turbo, args, { env });
        child.stdout.on('data', (d: Buffer) => process.stderr.write(d)); // 进度走 stderr，stdout 留给结果 JSON
        child.stderr.on('data', (d: Buffer) => process.stderr.write(d));
        child.on('error', (e) => {
          console.error(`启动 mmh3turbo 失败: ${e.message}`);
          process.exit(1);
        });
        child.on('close', (c) => resolve(c ?? -1));
      });
      if (code !== 0) {
        console.error(`mmh3turbo 退出码 ${code}（运行目录保留供排查: ${runDir}；常见原因: 磁盘空间不足、权重下载中断——重跑即可续传）`);
        process.exit(1);
      }
      const produced = path.join(runDir, 'video.mp4');
      if (!fs.existsSync(produced)) {
        console.error(`未找到产物 ${produced}（运行目录内容保留供排查: ${runDir}）`);
        process.exit(1);
      }
      const out = path.resolve(opts.out!);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      try {
        fs.renameSync(produced, out);
      } catch {
        fs.copyFileSync(produced, out); // 跨卷回退
        fs.unlinkSync(produced);
      }
      console.log(
        JSON.stringify(
          {
            out,
            seconds: Number(((Date.now() - t0) / 1000).toFixed(1)),
            runDir,
            engine: 'mmh3turbo',
            res,
            duration: seconds,
            steps,
            seed,
            ...(opts.firstFrame ? { firstFrame: path.resolve(opts.firstFrame) } : {}),
          },
          null,
          2
        )
      );
    });
}

function registerListRes(video: Command): void {
  video
    .command('list-res')
    .description('列出 mmh3turbo 支持的分辨率档位（透传）')
    .action(() => {
      const rt = resolveVideoRuntime();
      if (!fs.existsSync(rt.mmh3turbo)) {
        console.error('mmh3turbo 未安装。先运行: lmedia video setup');
        process.exit(1);
      }
      const r = spawnSync(rt.mmh3turbo, ['--list-res'], { encoding: 'utf8' });
      if (r.status !== 0) {
        console.error(`mmh3turbo --list-res 退出码 ${r.status}`);
        process.exit(1);
      }
      console.log((r.stdout ?? '').trim());
    });
}

export function registerVideo(program: Command): void {
  const video = program.command('video').description('视频生产能力（本地 MiniMax-H3 / mmh3turbo，零 API 成本）');
  registerSetup(video);
  registerGen(video);
  registerListRes(video);
}
