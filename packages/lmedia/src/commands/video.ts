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
  '256p', '352p', '480p', '576p', '704p', '720p', '768p', '1080p',
  'square', 'portrait', 'vertical', // 竖版/方版（绘本竖页用 portrait）
];

// Lightning 加速档（--fast）：few-step 蒸馏 LoRA（RH-RunningHub/MiniMax-H3-
// MultiGPU-Lightning 方案的社区开源蒸馏权重，官方蒸馏权重未公开）离线合并进
// int8 bundle；v1.x 768p 系按 video shift 6 蒸馏（基座 12）。默认装 8 步版
// （LightX2V Studio 同款，身份/音频更稳）；4 步更快但尾段身份漂移明显。
const TURBO_BUNDLE = 'dit-turbo';
const TURBO_LORA_FILE = 'lightx2v_fl2v_turbo_8step_v1.0_768p_bf16.safetensors';
const TURBO_LORA_URL = `https://hf-mirror.com/lightx2v/Minimax-h3-Turbo/resolve/main/${TURBO_LORA_FILE}`;
const FAST_STEPS = 8;
const FAST_SHIFT_VIDEO = 6.0;

interface GenOpts {
  out?: string;
  res?: string;
  seconds?: string;
  steps?: string;
  seed?: string;
  firstFrame?: string;
  lastFrame?: string;
  fast?: boolean;
}

// 人物场景质量护栏：蒸馏档（--fast）纹理油画化 + 时域身份漂移对人物最敏感，
// 这是实测踩坑最多的组合（2026-09 绘本/家庭视频生产实录，见 USAGE「人物微动的质量配方」）。
const PERSON_RE = new RegExp(
  '人像|人物|女孩|男孩|女人|男人|女生|男生|爸爸|妈妈|宝宝|孩子|小孩|儿子|女儿|姐姐|弟弟|妹妹|哥哥|爷爷|奶奶|叔叔|阿姨|家庭|portrait|person|child|baby|girl|boy|woman|man|people|face',
  'i'
);

/** 按场景给出质量提示（人读 stderr + 机读 hints，一起返回） */
const LOWRES_PRESETS = new Set(['256p', '352p', '480p', '576p']);
function qualityHints(prompt: string, o: { fast: boolean; seconds: number; res: string; firstFrame?: string; lastFrame?: string }): string[] {
  const hints: string[] = [];
  if (!PERSON_RE.test(prompt)) return hints;
  if (o.fast) {
    console.error('提示: 人物视频用 --fast（蒸馏档）会出现纹理油画感与身份漂移——质量优先请去掉 --fast 用基座 12 步，并把构图裁到人物特写（人脸占画面 1/4 以上）。配方: lmedia video recipes');
    hints.push('person+fast: 蒸馏档纹理软化且时域漂移大；人物质量优先用基座 12 步 + 主体特写构图（lmedia video recipes）');
  }
  if (LOWRES_PRESETS.has(o.res)) {
    console.error(`提示: 人物视频分辨率不足（${o.res} 短边 < 704，人脸像素太少必糊）——建议 -r 720p/square/portrait 并让人物占画面主体。配方: lmedia video recipes`);
    hints.push(`person+${o.res}: 人脸像素不足；用 720p/square/portrait + 主体特写构图`);
  }
  if (o.firstFrame && !o.lastFrame) {
    console.error('提示: 图生视频仅锚定首帧，人物动作大时结尾身份会漂移（实测结尾人脸相似度可跌到 0.3）——同一张图再加 --last-frame 双锚定可回环抑制（实测拉回 0.97）。配方: lmedia video recipes');
    hints.push('first-frame only: 结尾身份会漂移；同图 --last-frame 双锚定可将结尾人脸相似度 0.3→0.97');
  }
  if (o.seconds > 5) {
    console.error('提示: 人物视频漂移随时长累积，建议 ≤5s（要长镜头请分多段 + --last-frame 衔接）。');
    hints.push('person+long: 漂移随时长累积，建议 ≤5s 或分段');
  }
  return hints;
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
    .description('文生视频/首帧图生视频：MiniMax-H3 本地（默认 480p / 5s / 12 步，mp4 含立体声音轨；生产配方见 lmedia video recipes）')
    .option('-o, --out <path>', '输出 mp4 路径', `lmedia-video-${Date.now()}.mp4`)
    .option('-r, --res <preset>', `分辨率档：${RES_PRESETS.join('|')}（lmedia video list-res 看实际画布）`, '480p')
    .option('--seconds <s>', '片段时长秒（1-15）', '5')
    .option('--steps <n>', `去噪步数（基座 12 步≈20 步；--fast 默认取 bundle meta 的推荐步数，缺失按 ${FAST_STEPS}，4-8 为蒸馏有效区间）`)
    .option('--seed <n>', '随机种子', '42')
    .option('--first-frame <path>', '首帧图（图生视频；推荐衔接 lmedia image gen 产物）')
    .option('--last-frame <path>', '尾帧图（首尾锚定插值）')
    .option('--fast', `Lightning 蒸馏加速档（dit-turbo bundle + ${FAST_STEPS} 步 + shift ${FAST_SHIFT_VIDEO}；首次先 lmedia video turbo-merge）。风景/静物/绘本用；人物视频慎用（油画感+漂移，见 lmedia video recipes）`, false)
    .action(async (prompt: string, opts: GenOpts) => {
      // —— 加速档 bundle meta（决定默认步数；读不到用 FAST_STEPS 兜底）——
      const rt = resolveVideoRuntime();
      const turboPrefix = path.join(rt.weightsDir, TURBO_BUNDLE);
      const turboMeta = (() => {
        if (!opts.fast) return undefined;
        try {
          return JSON.parse(fs.readFileSync(`${turboPrefix}.idx`, 'utf8'))['__meta__'];
        } catch { return undefined; }
      })();
      // —— 参数校验（退出码 2，同 lora 约定）——
      const res = opts.res!;
      const seconds = parseFloat(opts.seconds!);
      const fast = !!opts.fast;
      const steps = opts.steps ? parseInt(opts.steps!, 10)
        : fast ? Number(turboMeta?.turbo_nfe) || FAST_STEPS : 12;
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
      if (fast && steps > 8) {
        console.error(`提示: --fast 蒸馏档步数 >8 无收益且可能过锐化（蒸馏配方推荐 ${FAST_STEPS}，4-8 有效）`);
      }
      if (!Number.isInteger(seed)) {
        console.error(`--seed 需为整数（当前 ${opts.seed}）`);
        process.exit(2);
      }
      for (const [label, p] of [['首帧图', opts.firstFrame], ['尾帧图', opts.lastFrame]] as const) {
        if (p && !fs.existsSync(p)) {
          console.error(`${label}不存在: ${p}`);
          process.exit(2);
        }
      }
      // —— 人物场景质量护栏（人读 stderr；机读 hints 进 stdout JSON；先于环境校验，任何环境都先给提示）——
      const hints = qualityHints(prompt, {
        fast,
        seconds,
        res,
        firstFrame: opts.firstFrame,
        lastFrame: opts.lastFrame,
      });
      // bundle meta 缺 turbo_nfe 时步数系兜底：若合并的是 4 步版 LoRA 却忘传 --nfe，
      // 就会静默按 FAST_STEPS 跑（超出该 LoRA 的蒸馏训练区间，出片过锐化且无任何报错）。
      const turboReady = fs.existsSync(`${turboPrefix}.bin`);
      if (fast && !opts.steps && turboReady && !turboMeta?.turbo_nfe) {
        console.error(`提示: 加速档 bundle 未记录推荐步数（turbo_nfe），本次按兜底 ${FAST_STEPS} 步跑——若合并的是 4 步版 LoRA，请显式 --steps 4（或 turbo-merge --nfe 4 重写 meta）`);
        hints.push(`turbo bundle 缺 turbo_nfe，步数按兜底 ${FAST_STEPS}；4 步版 LoRA 需显式 --steps 4`);
      }
      // 中文短 prompt 提醒：H3 全注意力下文本 token 占比过低会被 seed 主导
      if (/[一-鿿]/.test(prompt) && prompt.length < 20) {
        console.error(`提示: 中文 prompt 建议 30-50 字（当前 ${prompt.length} 字），太短易被 seed 主导（换 prompt 画面不变）`);
      }
      // —— 环境校验（退出码 1）——
      if (!fs.existsSync(rt.mmh3turbo)) {
        console.error(`mmh3turbo 未安装（${rt.venvVideo}）。先运行: lmedia video setup`);
        process.exit(1);
      }
      if (!hasCommand('ffmpeg')) {
        console.error('未找到 ffmpeg（mp4 封装必需）：brew install ffmpeg 后重试');
        process.exit(1);
      }
      if (fast && !fs.existsSync(`${turboPrefix}.bin`)) {
        console.error(`加速档 bundle 未就绪（${turboPrefix}.bin）。先运行: lmedia video turbo-merge`);
        process.exit(1);
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
      if (opts.lastFrame) args.push('--last-frame', path.resolve(opts.lastFrame));
      let engineCmd = rt.mmh3turbo;
      let engineArgs = args;
      if (fast) {
        // 蒸馏驱动：python/video_gen.py 打 shift 补丁后透传给 mmh3turbo.generate
        engineCmd = rt.pythonVideo;
        engineArgs = [
          path.join(rt.pythonDir, 'video_gen.py'),
          '--shift-video', String(FAST_SHIFT_VIDEO),
          '--weights', turboPrefix,
          ...args,
        ];
      }
      console.error(`mmh3turbo${fast ? '(turbo)' : ''} · ${res} · ${seconds}s · ${steps} 步${fast ? ` · shift ${FAST_SHIFT_VIDEO}` : ''} · seed ${seed} → ${runDir}`);
      const t0 = Date.now();
      // 不走 runPython()：它会注入 HF_HUB_OFFLINE=1，阻断首次权重下载
      const env = { ...process.env };
      const weightsReady = fs.existsSync(path.join(rt.weightsDir, 'dit.bin')) ||
        (fast && fs.existsSync(`${turboPrefix}.bin`));
      if (!weightsReady && env.HF_HUB_OFFLINE === '1') {
        console.error('提示: 检测到 HF_HUB_OFFLINE=1 且 H3 权重未就绪，本次临时关闭以拉取权重（国内推荐 lmedia video setup --mirror）');
        env.HF_HUB_OFFLINE = '0';
      }
      const code = await new Promise<number>((resolve) => {
        const child = spawn(engineCmd, engineArgs, { env });
        child.stdout.on('data', (d: Buffer) => process.stderr.write(d)); // 进度走 stderr，stdout 留给结果 JSON
        child.stderr.on('data', (d: Buffer) => process.stderr.write(d));
        child.on('error', (e) => {
          console.error(`启动引擎失败: ${e.message}`);
          process.exit(1);
        });
        child.on('close', (c) => resolve(c ?? -1));
      });
      if (code !== 0) {
        console.error(`引擎退出码 ${code}（运行目录保留供排查: ${runDir}；常见原因: 磁盘空间不足、权重下载中断——重跑即可续传）`);
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
            engine: fast ? 'mmh3turbo+turbo-lora' : 'mmh3turbo',
            res,
            duration: seconds,
            steps,
            seed,
            ...(fast ? { fast: true, shiftVideo: FAST_SHIFT_VIDEO, ...(turboMeta?.turbo_lora ? { lora: turboMeta.turbo_lora } : {}) } : {}),
            ...(hints.length ? { hints } : {}),
            ...(opts.firstFrame ? { firstFrame: path.resolve(opts.firstFrame) } : {}),
            ...(opts.lastFrame ? { lastFrame: path.resolve(opts.lastFrame) } : {}),
          },
          null,
          2
        )
      );
    });
}

function registerTurboMerge(video: Command): void {
  video
    .command('turbo-merge')
    .description('把 few-step 蒸馏 LoRA 合并进 int8 DiT bundle（--fast 加速档的一次性准备，~20GB 读写）')
    .option('--lora <path>', '蒸馏 LoRA safetensors（lightx2v 命名；缺失时自动从镜像下载）')
    .option('--bundle <prefix>', '源 int8 bundle 前缀（dit.bin/.idx）')
    .option('--out <prefix>', '输出 bundle 前缀')
    .option('--scale <n>', 'LoRA 强度（蒸馏配方固定 1.0，勿调）', '1.0')
    .option('--nfe <n>', '推荐去噪步数（写入 bundle meta，--fast 默认步数；8 步版=8）')
    .option('--no-download', 'LoRA 缺失时不自动下载，直接报错')
    .action((opts: { lora?: string; bundle?: string; out?: string; scale?: string; nfe?: string; download?: boolean }) => {
      const rt = resolveVideoRuntime();
      const bundle = opts.bundle ?? path.join(rt.weightsDir, 'dit');
      const out = opts.out ?? path.join(rt.weightsDir, TURBO_BUNDLE);
      const loraDir = path.join(rt.weightsDir, 'loras');
      const lora = opts.lora ?? path.join(loraDir, TURBO_LORA_FILE);
      if (!fs.existsSync(`${bundle}.bin`) || !fs.existsSync(`${bundle}.idx`)) {
        console.error(`源 int8 bundle 不存在: ${bundle}.bin/.idx。先运行: lmedia video setup --mirror`);
        process.exit(1);
      }
      if (!fs.existsSync(rt.pythonVideo)) {
        console.error(`视频 venv 不存在: ${rt.venvVideo}。先运行: lmedia video setup`);
        process.exit(1);
      }
      if (!fs.existsSync(lora)) {
        if (!opts.download) {
          console.error(`LoRA 不存在且已禁用自动下载: ${lora}`);
          process.exit(1);
        }
        fs.mkdirSync(loraDir, { recursive: true });
        console.error(`下载蒸馏 LoRA（~1.4GB）→ ${lora}`);
        const r = spawnSync('curl', ['-L', '-C', '-', '--retry', '8', '--retry-delay', '5', '-o', `${lora}.part`, TURBO_LORA_URL], { stdio: 'inherit' });
        if (r.status !== 0 || !fs.existsSync(`${lora}.part`) || fs.statSync(`${lora}.part`).size < 1e8) {
          console.error(`LoRA 下载失败（可手动下载后放至 ${lora}）: ${TURBO_LORA_URL}`);
          process.exit(1);
        }
        fs.renameSync(`${lora}.part`, lora);
      }
      console.error(`合并 ${path.basename(lora)} → ${out}.bin/.idx（fp32 精度加 delta 后按行重量化）`);
      const mergeArgs = [
        path.join(rt.pythonDir, 'turbo_merge.py'),
        '--lora', lora, '--bundle', bundle, '--out', out, '--scale', opts.scale!,
      ];
      if (opts.nfe) mergeArgs.push('--nfe', opts.nfe);
      const r = spawnSync(rt.pythonVideo, mergeArgs, { stdio: 'inherit' });
      if (r.status !== 0) {
        console.error(`turbo_merge 退出码 ${r.status}`);
        process.exit(r.status ?? 1);
      }
      console.log(`就绪: lmedia video gen --fast ... （bundle: ${out}）`);
    });
}

function registerRecipes(video: Command): void {
  video
    .command('recipes')
    .description('打印实测验收过的生产配方（人物微动/风景绘本/双锚定一致性），复制即用')
    .action(() => {
      console.log(`lmedia video 生产配方（M4 Max 实测验收，2026-09）

① 人物微动（质量优先——人物视频的默认选择）
   要点: 基座 12 步（不用 --fast，蒸馏档人脸会油画化）+ 主体特写构图
   （先裁剪：让人脸占画面 1/4 以上，脸越大像素越足）+ 动作收敛的 prompt
   + 时长 ≤5s（漂移随时长累积）

   # 从大图裁人物特写（示例：从 1808² 源图取主体方框）
   ffmpeg -i photo.jpg -vf "crop=1150:1150:X:Y" closeup.jpg
   lmedia video gen "人物+轻微动作描述，动作轻柔。Audio: ambience, no talking, no voices" \\
     -r square --seconds 4 --seed 11 --first-frame closeup.jpg -o clip.mp4
   # ~23min/条（M4 Max square 768² 4s）

② 风景/静物/绘本微动（快）
   要点: --fast 蒸馏档（8 步 shift 6，首次先 lmedia video turbo-merge）；
   蒸馏 768p 系分辨率纪律：短边 ≥700，352p/480p 仅链路验证

   lmedia video gen "水彩绘本风格：小蜜蜂男孩在花园里挥手，花瓣飘落，细节丰富" \\
     --fast -r square --seconds 4 --first-frame page.png -o clip.mp4
   # ~17min/条；人物慎用（油画感+漂移）

③ 人物一致性：双锚定（首尾同图回环）
   要点: 图生视频只锚首帧时结尾身份必漂（实测人脸相似度跌到 0.3）；
   同一张图同时喂 --first-frame 和 --last-frame，动作「荡出去再荡回来」，
   ArcFace 实测结尾相似度拉回 0.97。走路位移类构图不适用（会逼出回退动作）

   lmedia video gen "人物+轻微动作描述，动作轻柔几乎保持原姿。Audio: ..." \\
     -r square --seconds 4 --seed 11 \\
     --first-frame closeup.jpg --last-frame closeup.jpg -o clip.mp4

通用纪律：
- 文生视频中文 prompt 30-50 字，写清动作与镜头，Audio: 段写环境音并加 no talking
- 基座默认 12 步即 20 步观感；不要低于 8 步（掉质明显）
- 首帧照片优选：正脸、清晰、人脸占比大——首帧就是身份的基因
- 生成结果机读 hints 字段会带场景质量建议；环境自检 lmedia doctor`);
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
  const video = program.command('video').description('视频生产能力（本地 MiniMax-H3 / mmh3turbo，零 API 成本；--fast Lightning 蒸馏加速档；生产配方 lmedia video recipes）');
  registerSetup(video);
  registerGen(video);
  registerTurboMerge(video);
  registerRecipes(video);
  registerListRes(video);
}
