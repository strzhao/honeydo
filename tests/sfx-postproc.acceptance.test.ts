/**
 * 红队验收 — 场景 5（剪裁/重剪）+ 场景 6（归一化）+ 场景 10（归一错位 bug 回归）
 *
 * 场景5.P1 [det-machine] trim 产物 RIFF 有效、duration 严格小于源、sample_rate 不变
 * 场景5.P2 [det-machine] 不同 --thresh 重剪同一 fixture 产生不同时长结果，
 *                        且 <out>.ops.json 侧车记录本次参数（argv.thresh == 命令行传入值）
 * 场景5.P3 [det-machine] 剪裁不修改源文件（sha256 前后一致，negate）
 * 场景6.P1 [det-machine] --loudness <target> 归一后：abs(lufs_out − target) ≤ 1.0
 *                        且时长偏差 ≤0.05s 且采样率不变
 * 场景6.P2 [det-machine] 全静音输入：输出存在且 peak_dbfs ≤ -0.1 且非有限样本数 == 0（exit 0）
 * 场景10.P1 [det-machine] 段内峰值已知(-20.0dBFS、首尾静音) fixture 跑 trim：
 *                        abs(peak_out_dbfs − (−6.0)) ≤ 0.5
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  countNonFinite,
  decodeMonoF32,
  Fixtures,
  measureLufs,
  peakDbfs,
  probeDuration,
  readJson,
  collectValues,
  runCli,
  sha256File,
  synthFixtures,
  tmpDir,
  wavInfo,
} from './helpers/sfx-utils';

let dir = '';
let fx: Fixtures;

beforeAll(() => {
  dir = tmpDir('rb-postproc-');
  fx = synthFixtures(dir);
});

afterAll(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

/** `<name>.wav` → `<name>.trim.wav` 等派生命名 */
const derived = (src: string, suffix: string): string => src.replace(/\.wav$/i, `${suffix}.wav`);

/** 侧车路径：契约表写 `<name>.ops.json`，谓词写 `<out>.ops.json`（CONTRACT_AMBIGUOUS），两者都认 */
function opsCandidates(src: string, outSuffix: string): string[] {
  return [derived(src, outSuffix) + '.ops.json', src.replace(/\.wav$/i, '.ops.json')];
}

function firstExisting(paths: string[]): string | undefined {
  return paths.find((p) => fs.existsSync(p));
}

describe('场景5 剪裁/重剪', () => {
  test('场景5.P1 trim 产物 RIFF 有效、时长严格小于源、采样率不变', { timeout: 180_000 }, async () => {
    const res = await runCli(['sfx', 'trim', fx.headTail], { timeoutMs: 170_000 });
    expect(res.code).toBe(0);

    const out = derived(fx.headTail, '.trim');
    expect(fs.existsSync(out)).toBe(true);

    const info = wavInfo(out);
    expect(info.isRiff).toBe(true);
    expect(info.isWave).toBe(true);
    expect(info.sampleRate).toBe(wavInfo(fx.headTail).sampleRate);
    expect(info.sampleRate).toBe(44100);

    const srcDur = probeDuration(fx.headTail);
    const outDur = probeDuration(out);
    expect(outDur).toBeLessThan(srcDur);
    expect(outDur).toBeGreaterThan(0);
  });

  test('场景5.P2 不同 --thresh 重剪同一 fixture 得到不同时长，侧车记录本次参数', { timeout: 240_000 }, async () => {
    const dirA = tmpDir('rb-trim-t35-');
    const dirB = tmpDir('rb-trim-t50-');
    try {
      const srcA = path.join(dirA, 'noisefloor.wav');
      const srcB = path.join(dirB, 'noisefloor.wav');
      fs.copyFileSync(fx.noiseFloor, srcA);
      fs.copyFileSync(fx.noiseFloor, srcB);

      const runA = await runCli(['sfx', 'trim', srcA, '--thresh', '-35dB'], { timeoutMs: 170_000 });
      const runB = await runCli(['sfx', 'trim', srcB, '--thresh', '-50dB'], { timeoutMs: 170_000 });
      expect(runA.code).toBe(0);
      expect(runB.code).toBe(0);

      const outA = derived(srcA, '.trim');
      const outB = derived(srcB, '.trim');
      expect(fs.existsSync(outA)).toBe(true);
      expect(fs.existsSync(outB)).toBe(true);

      // -40dB 本底在 -35dB 阈值下属静音、在 -50dB 阈值下属信号 → 两种阈值时长必然不同
      const durA = probeDuration(outA);
      const durB = probeDuration(outB);
      expect(durA).not.toBe(durB);
      expect(Math.abs(durA - durB)).toBeGreaterThan(0.2);

      // 侧车必须记录本次参数：元数据.argv.thresh == 命令行传入值
      // CONTRACT_AMBIGUOUS: 侧车 JSON 的具体键路径未定（元数据/argv/thresh 的命名层级），
      //   故在整棵 JSON 树上检索 argv.thresh；值容许 "-50dB" 字符串或 -50 数值两种形态
      for (const [src, argValue, numValue] of [
        [srcA, '-35dB', -35],
        [srcB, '-50dB', -50],
      ] as Array<[string, string, number]>) {
        const ops = firstExisting(opsCandidates(src, '.trim'));
        expect(ops).toBeDefined();
        const parsed = readJson(ops as string);
        const argvNodes = collectValues(parsed, 'argv').filter(
          (v) => v !== null && typeof v === 'object',
        );
        const threshValues = argvNodes.flatMap((n) => collectValues(n, 'thresh'));
        expect(threshValues.length).toBeGreaterThanOrEqual(1);
        const matched = threshValues.some((v) => {
          if (v === argValue) return true;
          const n = Number(v);
          return Number.isFinite(n) && Math.abs(n - numValue) < 1e-9;
        });
        expect(matched).toBe(true);
      }
    } finally {
      fs.rmSync(dirA, { recursive: true, force: true });
      fs.rmSync(dirB, { recursive: true, force: true });
    }
  });

  test('场景5.P3 剪裁不修改源文件（sha256 前后一致）', { timeout: 180_000 }, async () => {
    const work = tmpDir('rb-trim-ro-');
    try {
      const src = path.join(work, 'peakknown.wav');
      fs.copyFileSync(fx.peakKnown, src);
      const before = sha256File(src);
      const mtimeBefore = fs.statSync(src).mtimeMs;

      const res = await runCli(['sfx', 'trim', src], { timeoutMs: 170_000 });
      expect(res.code).toBe(0);
      // 产物确实生成（避免"什么都没做所以源没变"的假通过）
      expect(fs.existsSync(derived(src, '.trim'))).toBe(true);

      expect(sha256File(src)).toBe(before);
      expect(fs.statSync(src).mtimeMs).toBe(mtimeBefore);
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  });
});

describe('场景6 归一化', () => {
  test('场景6.P1 --loudness 归一后响度偏差 ≤1.0 LU、时长偏差 ≤0.05s、采样率不变', { timeout: 240_000 }, async () => {
    const outDir = path.join(dir, 'norm-loud');
    fs.mkdirSync(outDir, { recursive: true });
    const target = -16;

    const res = await runCli(
      ['sfx', 'normalize', fx.knownLoud, '--loudness', String(target), '--out-dir', outDir],
      { timeoutMs: 230_000 },
    );
    expect(res.code).toBe(0);

    const wavs = fs
      .readdirSync(outDir)
      .filter((f) => f.toLowerCase().endsWith('.wav'))
      .map((f) => path.join(outDir, f));
    expect(wavs.length).toBeGreaterThanOrEqual(1);
    const out = wavs[0];

    // 独立响度测量（ffmpeg loudnorm print_format=json），不采信实现自报值
    const lufs = measureLufs(out);
    expect(Math.abs(lufs - target)).toBeLessThanOrEqual(1.0);

    const srcDur = probeDuration(fx.knownLoud);
    const outDur = probeDuration(out);
    expect(Math.abs(outDur - srcDur)).toBeLessThanOrEqual(0.05);

    const info = wavInfo(out);
    expect(info.sampleRate).toBe(wavInfo(fx.knownLoud).sampleRate);
    expect(info.sampleRate).toBe(44100);
  });

  test('场景6.P2 全静音输入：跳过增益但写透传副本（exit 0），输出峰值 -inf 且无坏样本', { timeout: 240_000 }, async () => {
    const outDir = path.join(dir, 'norm-silent');
    fs.mkdirSync(outDir, { recursive: true });

    const res = await runCli(['sfx', 'normalize', fx.allSilence, '--target', '-6', '--out-dir', outDir], {
      timeoutMs: 230_000,
    });
    // 设计文档：全静音 peak<-60dBFS 跳过增益但写透传副本（exit 0）
    expect(res.code).toBe(0);

    const wavs = fs
      .readdirSync(outDir)
      .filter((f) => f.toLowerCase().endsWith('.wav'))
      .map((f) => path.join(outDir, f));
    expect(wavs.length).toBeGreaterThanOrEqual(1);

    const samples = decodeMonoF32(wavs[0]);
    expect(samples.length).toBeGreaterThan(1000); // 确认真的解码到了透传副本内容
    expect(peakDbfs(samples)).toBeLessThanOrEqual(-0.1);
    expect(countNonFinite(samples)).toBe(0);
  });
});

describe('场景10 归一错位 bug 回归', () => {
  test('场景10.P1 trim 产物峰值必须落在段内归一目标 -6.0dBFS（±0.5dB）', { timeout: 180_000 }, async () => {
    const res = await runCli(['sfx', 'trim', fx.peakKnown], { timeoutMs: 170_000 });
    expect(res.code).toBe(0);

    const out = derived(fx.peakKnown, '.trim');
    expect(fs.existsSync(out)).toBe(true);

    // 样本级峰值扫描（独立测量）：段内峰值 -20.0dBFS → 输出必须 ≈ -6.0dBFS
    const peak = peakDbfs(decodeMonoF32(out));
    expect(Math.abs(peak - -6.0)).toBeLessThanOrEqual(0.5);
  });
});
