/** video 加速档测试：CLI 参数分域 + turbo_merge.py 合并数学（合成小 bundle 逐张量校验） */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TSX = [
  path.join(ROOT, 'node_modules', '.bin', 'tsx'),
  path.join(ROOT, '..', '..', 'node_modules', '.bin', 'tsx'),
].find((p) => fs.existsSync(p)) ?? 'tsx';
const CLI = path.join(ROOT, 'src', 'index.ts');
const SYNTH = path.join(ROOT, 'tests', 'helpers', 'turbo-synth.py');
const MERGER = path.join(ROOT, 'python', 'turbo_merge.py');

function run(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(TSX, [CLI, 'video', ...args], {
    encoding: 'utf-8',
    env: { ...process.env, ...env },
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** 找一个带 numpy 的 python：CI 的 .venv-audio（ci.yml 预装）> 系统 python3 */
function numpyPython(): string | null {
  const candidates = [
    process.env.LMEDIA_RUNTIME
      ? path.join(process.env.LMEDIA_RUNTIME, '.venv-audio', 'bin', 'python')
      : null,
    path.join(os.homedir(), 'ml', 'lb-local-gen', '.venv-audio', 'bin', 'python'),
    'python3',
  ].filter((p): p is string => !!p);
  for (const p of candidates) {
    const probe = spawnSync(p, ['-c', 'import numpy'], { encoding: 'utf-8' });
    if (probe.status === 0) return p;
  }
  return null;
}

describe('video gen 参数校验（退出码 2，无环境依赖）', () => {
  it('未知分辨率档 → 2', () => {
    const r = run(['gen', '测试', '--res', '999p']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--res');
  });

  it('--steps 非整数 → 2', () => {
    const r = run(['gen', '测试', '--steps', 'abc']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--steps');
  });

  it('首帧图不存在 → 2', () => {
    const r = run(['gen', '测试', '--first-frame', '/nope/missing.png']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('首帧图不存在');
  });

  it('尾帧图不存在 → 2', () => {
    const r = run(['gen', '测试', '--last-frame', '/nope/missing.png']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('尾帧图不存在');
  });
});

describe('video --fast / turbo-merge 环境分域（退出码 1）', () => {
  const emptyWeights = fs.mkdtempSync(path.join(os.tmpdir(), 'lmedia-w-'));
  const venvReady = fs.existsSync(
    path.join(process.env.LMEDIA_RUNTIME ?? path.join(os.homedir(), 'ml', 'lb-local-gen'),
      '.venv-video', 'bin', 'mmh3turbo'));

  it('turbo-merge 无源 bundle → 1 + setup 指引', () => {
    const r = run(['turbo-merge', '--no-download'], { LMEDIA_WEIGHTS_DIR: emptyWeights });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('lmedia video setup');
  });

  it.skipIf(!venvReady)('--fast 无 dit-turbo bundle → 1 + turbo-merge 指引', () => {
    const r = run(['gen', '测试', '--fast'], { LMEDIA_WEIGHTS_DIR: emptyWeights });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('turbo-merge');
  });
});

describe('video recipes / 质量护栏', () => {
  it('recipes 输出三条实测配方', () => {
    const r = run(['recipes']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('人物微动');
    expect(r.stdout).toContain('双锚定');
    expect(r.stdout).toContain('基座 12 步');
  });

  it('人物 prompt + --fast → stderr 给油画感/漂移警告（先于环境校验）', () => {
    // LMEDIA_WEIGHTS_DIR 指向空目录：警告先打，随后在 bundle 检查处 exit 1（本地）或 venv 检查处 exit 1（CI）
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'lmedia-w2-'));
    const r = run(['gen', '女孩在花园里追蝴蝶，动作轻柔', '--fast'], { LMEDIA_WEIGHTS_DIR: empty });
    expect(r.stderr).toContain('油画感');
    expect(r.stderr).toContain('lmedia video recipes');
    expect(r.status).toBe(1);
  });

  it('人物 prompt + 仅首帧 → stderr 给双锚定提示', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'lmedia-w3-'));
    const img = path.join(empty, 'fake.png');
    fs.writeFileSync(img, 'x');
    // --fast + 空 weights 目录：警告先打，随后在加速档 bundle 检查处确定性 exit 1（不会真启动引擎）
    const r = run(['gen', '宝宝伸手摸小草', '--fast', '--first-frame', img], { LMEDIA_WEIGHTS_DIR: empty });
    expect(r.stderr).toContain('双锚定');
    expect(r.status).toBe(1);
  });

  it('非人物 prompt + --fast → 不打人物警告', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'lmedia-w4-'));
    const r = run(['gen', '一杯咖啡放在木桌上，热气轻轻升起', '--fast'], { LMEDIA_WEIGHTS_DIR: empty });
    expect(r.stderr).not.toContain('油画感');
  });

  it('--fast 且 bundle meta 无 turbo_nfe → stderr 给兜底步数提示（防 4 步 LoRA 静默跑 8 步）', () => {
    const w = fs.mkdtempSync(path.join(os.tmpdir(), 'lmedia-w5-'));
    fs.writeFileSync(path.join(w, 'dit-turbo.bin'), '');
    fs.writeFileSync(path.join(w, 'dit-turbo.idx'),
      JSON.stringify({ __meta__: { n_blocks: 0, turbo_lora: 'x.safetensors' } }));
    // LMEDIA_RUNTIME 指向空目录：venv 检查确定性 exit 1（不真启动引擎），提示在此之前已打出
    const rt = fs.mkdtempSync(path.join(os.tmpdir(), 'lmedia-rt2-'));
    const r = run(['gen', '一杯咖啡放在木桌上，热气轻轻升起', '--fast'],
      { LMEDIA_WEIGHTS_DIR: w, LMEDIA_RUNTIME: rt });
    expect(r.stderr).toContain('turbo_nfe');
    expect(r.stderr).toContain('--steps 4');
    expect(r.status).toBe(1);
  });

  it('--fast 且 bundle meta 带 turbo_nfe → 不打兜底提示', () => {
    const w = fs.mkdtempSync(path.join(os.tmpdir(), 'lmedia-w6-'));
    fs.writeFileSync(path.join(w, 'dit-turbo.bin'), '');
    fs.writeFileSync(path.join(w, 'dit-turbo.idx'),
      JSON.stringify({ __meta__: { n_blocks: 0, turbo_nfe: 4 } }));
    const rt = fs.mkdtempSync(path.join(os.tmpdir(), 'lmedia-rt3-'));
    const r = run(['gen', '一杯咖啡放在木桌上，热气轻轻升起', '--fast'],
      { LMEDIA_WEIGHTS_DIR: w, LMEDIA_RUNTIME: rt });
    expect(r.stderr).not.toContain('turbo_nfe');
    expect(r.status).toBe(1);
  });

  it('人物 prompt + 低分辨率档（基座）→ stderr 给分辨率提示', () => {
    // LMEDIA_RUNTIME 指向空目录：venv 检查确定性 exit 1（不真启动引擎），提示在此之前已打出
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lmedia-rt-'));
    const r = run(['gen', '宝宝伸手摸小草', '-r', '480p'], { LMEDIA_RUNTIME: tmp });
    expect(r.stderr).toContain('分辨率不足');
    expect(r.stderr).toContain('720p/square/portrait');
    expect(r.stderr).not.toContain('油画感');
    expect(r.status).toBe(1);
  });
});

describe('turbo_merge.py 合并数学（合成 2-block bundle）', () => {
  const py = numpyPython();
  it.skipIf(!py)('delta 按 W+B@A 加、按行重量化、未动张量逐字节不变', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lmedia-synth-'));
    const build = spawnSync(py!, [SYNTH, 'build', dir], { encoding: 'utf-8' });
    expect(build.status).toBe(0);

    const merge = spawnSync(py!, [
      MERGER, '--lora', path.join(dir, 'turbo.safetensors'),
      '--bundle', path.join(dir, 'dit'), '--out', path.join(dir, 'dit-turbo'),
    ], { encoding: 'utf-8' });
    expect(merge.status, merge.stderr).toBe(0);
    expect(merge.stdout).toContain('8 GEMM 已合并');

    const verify = spawnSync(py!, [SYNTH, 'verify', dir], { encoding: 'utf-8' });
    expect(verify.status, verify.stderr + verify.stdout).toBe(0);
    expect(verify.stdout).toContain('VERIFY PASS');

    const idx = JSON.parse(fs.readFileSync(path.join(dir, 'dit-turbo.idx'), 'utf8'));
    expect(idx.__meta__.turbo_relL2.max).toBeLessThan(0.05);
  });
});
