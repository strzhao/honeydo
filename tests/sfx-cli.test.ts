/** sfx CLI 集成单测：spawn tsx 子命令，断言退出码分域 / 副作用 / 剪裁归一回归 / ab / lib */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TSX = path.join(ROOT, 'node_modules', '.bin', 'tsx');
const CLI = path.join(ROOT, 'src', 'index.ts');
const FFMPEG = 'ffmpeg';
let dir = '';
let lib = '';

function run(args: string[], env: Record<string, string> = {}): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(TSX, [CLI, 'sfx', ...args], {
    encoding: 'utf-8',
    cwd: dir,
    env: { ...process.env, ...env, LMEDIA_SFX_LIB: lib },
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function tone(out: string, db: number, dur = 0.5): void {
  spawnSync(FFMPEG, ['-y', '-v', 'error', '-f', 'lavfi', '-i', `sine=f=440:d=${dur}:r=44100`,
    '-af', `volume=${db}dB`, '-ac', '1', '-ar', '44100', out]);
}

/** 首尾 1s 真静音 + 中间 0.5s 发声（段内峰值 ≈ db dBFS） */
function withEdgeSilence(out: string, db: number): void {
  spawnSync(FFMPEG, ['-y', '-v', 'error', '-f', 'lavfi', '-i', `sine=f=440:d=0.5:r=44100`,
    '-af', `volume=${db}dB,adelay=1000,apad=whole_dur=2.5`, '-ac', '1', '-ar', '44100', out]);
}

/** 首尾 1s 噪底（-40dB，介于 -35/-55 两档阈值之间）+ 中间 0.5s 发声 */
function withNoiseFloor(out: string): void {
  spawnSync(FFMPEG, ['-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'anoisesrc=c=pink:d=1:a=0.01:r=44100',
    '-f', 'lavfi', '-i', 'sine=f=440:d=0.5:r=44100',
    '-f', 'lavfi', '-i', 'anoisesrc=c=pink:d=1:a=0.01:r=44100',
    '-filter_complex',
    '[0:a]aformat=channel_layouts=mono[a];[1:a]volume=-2dB,aformat=channel_layouts=mono[b];[2:a]aformat=channel_layouts=mono[c];[a][b][c]concat=n=3:v=0:a=1[o]',
    '-map', '[o]', '-ac', '1', '-ar', '44100', out]);
}

/** 静簇 -20dBFS 在前 + 响簇 -6dBFS 在后（杀「整掷峰值归一」no-op 变异） */
function quietFirstCluster(out: string): void {
  spawnSync(FFMPEG, ['-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'sine=f=330:d=0.5:r=44100',
    '-f', 'lavfi', '-i', 'sine=f=550:d=0.5:r=44100',
    '-filter_complex',
    '[0:a]volume=-2dB,apad=pad_dur=1.0[a];[1:a]volume=12dB,apad=pad_dur=0.5[b];[a][b]concat=n=2:v=0:a=1[o]',
    '-map', '[o]', '-ac', '1', '-ar', '44100', out]);
}

/** 纯 JS 解析 wav：fmt 采样率 + data 峰值 dBFS（不依赖 ffprobe，独立复核） */
function scanWav(file: string): { sampleRate: number; peakDbfs: number; magic: string } {
  const buf = fs.readFileSync(file);
  const magic = buf.subarray(0, 4).toString('ascii');
  let off = 12;
  let sampleRate = 0;
  let bits = 16;
  let data: Buffer | null = null;
  while (off + 8 <= buf.length) {
    const id = buf.subarray(off, off + 4).toString('ascii');
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') {
      sampleRate = buf.readUInt32LE(off + 12);
      bits = buf.readUInt16LE(off + 22);
    } else if (id === 'data') {
      data = buf.subarray(off + 8, off + 8 + size);
    }
    off += 8 + size + (size % 2);
  }
  if (!data) throw new Error(`no data chunk: ${file}`);
  const bytes = bits / 8;
  let peak = 0;
  for (let i = 0; i + bytes <= data.length; i += bytes) {
    const v = bits === 16 ? Math.abs(data.readInt16LE(i)) : Math.abs(data.readInt32LE(i));
    if (v > peak) peak = v;
  }
  const full = 2 ** (bits - 1);
  return { sampleRate, peakDbfs: 20 * Math.log10(peak / full + 1e-12), magic };
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lmedia-sfx-cli-'));
  lib = path.join(dir, 'lib');
  withEdgeSilence(path.join(dir, 'edges.wav'), -2);       // 段内峰值 ≈ -20dBFS
  withNoiseFloor(path.join(dir, 'noisefloor.wav'));        // 阈值区分 fixture
  tone(path.join(dir, 'ok.wav'), 12, 1.0);                 // 峰值 ≈ -6dBFS（accept 全过用）
  quietFirstCluster(path.join(dir, 'quiet-first.wav'));    // 静簇在前
  spawnSync(FFMPEG, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono',
    '-t', '1', '-ac', '1', '-ar', '44100', path.join(dir, 'silent.wav')]);
  spawnSync(FFMPEG, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=f=440:d=1:r=44100',
    '-af', 'volume=20dB', '-ac', '1', '-ar', '44100', path.join(dir, 'clip.wav')]);
  fs.writeFileSync(path.join(dir, 'empty.json'), '', 'utf-8');
  fs.writeFileSync(path.join(dir, 'bad.json'), '{ broken', 'utf-8');
  fs.writeFileSync(path.join(dir, 'badkey.json'), '[{"key":"Bear!","prompt":"x"}]', 'utf-8');
  fs.writeFileSync(path.join(dir, 'dupkey.json'), '[{"key":"bear","prompt":"x"},{"key":"bear","prompt":"y"}]', 'utf-8');
  fs.writeFileSync(path.join(dir, 'good.json'),
    JSON.stringify([{ key: 'bear', prompt: 'A clean cartoon bear grunt' }]), 'utf-8');
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('退出码分域（2=参数/文件不存在，1=清单损坏）', () => {
  it('batch：-m 不存在=2；空文件=1；非法 JSON=1（不覆写）', () => {
    const before = fs.readFileSync(path.join(dir, 'bad.json'), 'utf-8');
    expect(run(['batch', '-m', '/tmp/definitely-missing.json', '-o', 'out']).status).toBe(2);
    expect(run(['batch', '-m', 'empty.json', '-o', 'out']).status).toBe(1);
    const bad = run(['batch', '-m', 'bad.json', '-o', 'out']);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/解析|损坏/);
    expect(fs.readFileSync(path.join(dir, 'bad.json'), 'utf-8')).toBe(before); // 不重建
    expect(fs.existsSync(path.join(dir, 'out'))).toBe(false); // 零副作用
  });

  it('batch：key 非法/重复=2；rolls 0/11/abc=2', () => {
    expect(run(['batch', '-m', 'badkey.json', '-o', 'out']).status).toBe(2);
    expect(run(['batch', '-m', 'dupkey.json', '-o', 'out']).status).toBe(2);
    for (const rolls of ['0', '11', 'abc']) {
      expect(run(['batch', '-m', 'good.json', '-o', 'out', '--rolls', rolls]).status).toBe(2);
    }
  });

  it('trim：文件不存在=2；--thresh 格式错=2', () => {
    expect(run(['trim', 'nope.wav']).status).toBe(2);
    expect(run(['trim', 'edges.wav', '--thresh', '35dB']).status).toBe(2);
    expect(run(['trim', 'edges.wav', '--thresh', '-35']).status).toBe(2);
  });

  it('normalize：--target/--loudness 互斥=2；越界=2', () => {
    const f = 'edges.wav';
    expect(run(['normalize', f, '--target', '-12', '--loudness', '-23']).status).toBe(2);
    expect(run(['normalize', f, '--target', '-70']).status).toBe(2);
    expect(run(['normalize', f, '--target', '-0.1']).status).toBe(2);
    expect(run(['normalize', f, '--loudness', '-3']).status).toBe(2);
  });

  it('recut --cap 越界=2；accept 时长参数非法=2', () => {
    expect(run(['recut', 'edges.wav', '--cap', '0.1']).status).toBe(2);
    expect(run(['recut', 'edges.wav', '--cap', '20']).status).toBe(2);
    expect(run(['accept', 'edges.wav', '--min-dur', '5']).status).toBe(2);
  });

  it('lib remove 不存在=1（记录域，非参数域）', () => {
    expect(run(['lib', 'remove', 'no-such-key']).status).toBe(1);
  });
});

describe('剪裁/归一回归（段内两遍归一修复）', () => {
  it('trim：时长变短 / 采样率不变 / RIFF / 段内峰值 -6±0.5 / 源文件不变', () => {
    const src = path.join(dir, 'regress.wav');
    withEdgeSilence(src, -2); // 段内峰值 ≈ -20dBFS
    const srcBefore = fs.readFileSync(src);
    const r = run(['trim', 'regress.wav']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/✓ .+ → .+ \(dur .+→.+, peak .+→.+\)/);
    const out = path.join(dir, 'regress.trim.wav');
    expect(fs.existsSync(out)).toBe(true);
    const inInfo = scanWav(src);
    const outInfo = scanWav(out);
    expect(outInfo.magic).toBe('RIFF');
    expect(outInfo.sampleRate).toBe(inInfo.sampleRate);
    expect(fs.statSync(out).size).toBeLessThan(fs.statSync(src).size);
    expect(Math.abs(outInfo.peakDbfs - -6.0)).toBeLessThanOrEqual(0.5); // 场景 10.P1
    expect(fs.readFileSync(src).equals(srcBefore)).toBe(true);          // 场景 5.P3
    // 侧车记录
    const ops = JSON.parse(fs.readFileSync(path.join(dir, 'regress.ops.json'), 'utf-8'));
    expect(ops.op).toBe('trim');
    expect(ops.argv.thresh).toBe('-35dB');
  });

  it('trim 段内静簇 fixture：short 取第一簇并归一到 -6（整掷归一会得 -20）', () => {
    const r = run(['trim', 'quiet-first.wav']);
    expect(r.status).toBe(0);
    const peak = scanWav(path.join(dir, 'quiet-first.short.wav')).peakDbfs;
    expect(Math.abs(peak - -6.0)).toBeLessThanOrEqual(0.5);
  });

  it('不同 --thresh 剪出不同时长，且阈值写入侧车（场景 5.P2）', () => {
    fs.copyFileSync(path.join(dir, 'noisefloor.wav'), path.join(dir, 'thr.wav'));
    expect(run(['trim', 'thr.wav', '--thresh', '-35dB']).status).toBe(0);
    const size1 = fs.statSync(path.join(dir, 'thr.trim.wav')).size;
    expect(run(['trim', 'thr.wav', '--thresh', '-55dB']).status).toBe(0);
    const size2 = fs.statSync(path.join(dir, 'thr.trim.wav')).size;
    expect(size1).not.toBe(size2); // 噪底 fixture：两档阈值剪出不同时长产物
    const ops = JSON.parse(fs.readFileSync(path.join(dir, 'thr.ops.json'), 'utf-8'));
    expect(ops.argv.thresh).toBe('-55dB');
  });

  it('normalize：静音输入透传副本 exit 0；正常输入峰值命中目标', () => {
    const r = run(['normalize', 'silent.wav', '--out-dir', 'norm']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^· /m);
    expect(scanWav(path.join(dir, 'norm', 'silent.wav')).peakDbfs).toBeLessThan(-60);
    expect(run(['normalize', 'edges.wav', '--out-dir', 'norm', '--target', '-12']).status).toBe(0);
    expect(Math.abs(scanWav(path.join(dir, 'norm', 'edges.wav')).peakDbfs - -12)).toBeLessThanOrEqual(0.5);
  });

  it('accept：削波 fixture 判 fail（exit 1）+ status=fail token', () => {
    const r = run(['accept', 'clip.wav']);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/status=fail/);
    expect(r.stdout).toMatch(/0\/1 通过/);
    expect(run(['accept', 'ok.wav', '--max-dur', '3.0']).status).toBe(0);
  });
});

describe('ab / lib', () => {
  it('ab：html 含全部候选相对引用与名称，无绝对路径', () => {
    fs.writeFileSync(path.join(dir, 'groups.json'), JSON.stringify([
      { name: '签名音', candidates: [path.join(dir, 'edges.wav'), path.join(dir, 'quiet-first.wav')] },
    ]), 'utf-8');
    const r = run(['ab', '-m', 'groups.json', '-o', 'page.html']);
    expect(r.status).toBe(0);
    const html = fs.readFileSync(path.join(dir, 'page.html'), 'utf-8');
    expect((html.match(/<audio/g) ?? []).length).toBe(2);
    expect(html).toContain('签名音');
    expect(html).toContain('ab_files/');
    expect(html).not.toMatch(/src="(\/|file:)/);
    expect(fs.existsSync(path.join(dir, 'ab_files'))).toBe(true);
    expect(run(['ab', '-m', 'missing-groups.json', '-o', 'page.html']).status).toBe(2);
  });

  it('lib init：建目录 + 空清单（幂等）', () => {
    const r = run(['lib', 'init']);
    expect(r.status).toBe(0);
    expect(fs.existsSync(path.join(lib, 'sfx'))).toBe(true);
    expect(fs.existsSync(path.join(lib, 'ambient'))).toBe(true);
    const m = JSON.parse(fs.readFileSync(path.join(lib, 'index.json'), 'utf-8'));
    expect(m.version).toBe(1);
    expect(m.items).toHaveLength(0);
    expect(run(['lib', 'init']).status).toBe(0);
  });

  it('lib add/list/remove/verify 全链', () => {
    fs.copyFileSync(path.join(dir, 'ok.wav'), path.join(dir, 'libsrc.wav'));
    expect(run(['lib', 'add', 'libsrc.wav', '--key', 'bear', '--library', 'storybook',
      '--tags', 'animal,forest']).status).toBe(0);
    const m = JSON.parse(fs.readFileSync(path.join(lib, 'index.json'), 'utf-8'));
    expect(m.items).toHaveLength(1);
    const item = m.items[0];
    for (const field of ['path', 'duration', 'sample_rate', 'tags', 'created_at', 'library', 'content_hash', 'status']) {
      expect(item).toHaveProperty(field);
    }
    expect(item.library).toBe('storybook');
    expect(item.tags).toEqual(['animal', 'forest']);
    expect(fs.existsSync(item.path)).toBe(true);

    const list = run(['lib', 'list']);
    expect(list.status).toBe(0);
    expect(list.stdout.trim().split('\n')).toHaveLength(1); // 行数 == 清单条数

    // 幂等：同 hash 重复登记条目数保持 1
    const second = run(['lib', 'add', 'libsrc.wav', '--key', 'bear2']);
    expect(second.status).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(lib, 'index.json'), 'utf-8')).items).toHaveLength(1);

    expect(run(['lib', 'verify']).status).toBe(0);
    fs.rmSync(item.path);
    const drift = run(['lib', 'verify']);
    expect(drift.status).toBe(1);
    expect(drift.stdout).toMatch(/✗ bear/);

    // remove 只删记录不删文件
    fs.copyFileSync(path.join(dir, 'quiet-first.wav'), path.join(dir, 'source.wav'));
    expect(run(['lib', 'add', 'source.wav', '--key', 'source']).status).toBe(0);
    const audio = path.join(lib, 'sfx', 'source.mp3');
    expect(fs.existsSync(audio)).toBe(true);
    expect(run(['lib', 'remove', 'source']).status).toBe(0);
    expect(fs.existsSync(audio)).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(lib, 'index.json'), 'utf-8')).items.map((i: { key: string }) => i.key)).not.toContain('source');
  });
});
