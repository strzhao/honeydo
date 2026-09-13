/**
 * 图像能力开关测试：状态机 / gate 分域 / 退出码 / 损坏语义。
 *
 * 隔离杠杆是 **HOME=<mkdtemp>**：仓内所有默认路径都由 os.homedir() 派生
 * （~/.config/limg、~/.cache/huggingface/hub、~/.lmedia/serve、~/ml/lb-local-gen），
 * 一次替换即可全部隔离——尤其是 SERVE_DIR 这个模块级常量，保证测试绝不会误连/误杀
 * 用户真实在跑的 daemon。
 */
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

/** 从开发机环境里抹掉的干扰变量（保证 hermetic；显式传入 env 的除外） */
const NOISE = [
  'LMEDIA_RUNTIME', 'LMEDIA_NO_DAEMON', 'LMEDIA_NO_IMAGE_GATE', 'LMEDIA_IMAGE_STATE',
  'LMEDIA_NO_GPU_WAIT', 'HF_HOME', 'HF_HUB_CACHE', 'HF_HUB_OFFLINE',
];

/** 每个用例一个全新 HOME：用例之间零共享状态，且不依赖执行顺序 */
function freshHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lmedia-cap-'));
}

function run(args: string[], home: string, env: Record<string, string> = {}) {
  const e: NodeJS.ProcessEnv = { ...process.env, HOME: home, ...env };
  for (const k of NOISE) if (!(k in env)) delete e[k];
  const r = spawnSync(TSX, [CLI, ...args], { encoding: 'utf-8', cwd: home, env: e });
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

const stateFile = (home: string) => path.join(home, '.config', 'limg', 'image-state.json');
const readState = (home: string) => JSON.parse(fs.readFileSync(stateFile(home), 'utf-8'));

describe('开关闭环（退出码 0=可跑图像命令）', () => {
  it('无状态文件 = 默认启用；资产不齐故 status 退出 1', () => {
    const home = freshHome();
    const r = run(['image', 'status'], home);
    expect(r.stdout).toContain('图像能力: 已启用');
    expect(r.stdout).toContain('不存在=默认启用');
    expect(r.status).toBe(1);
  });

  it('disable 原子落盘（enabled=false + disabledAt + reason）', () => {
    const home = freshHome();
    const r = run(['image', 'disable', '--reason', '磁盘不足'], home);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('图像能力已禁用');
    const s = readState(home);
    expect(s.enabled).toBe(false);
    expect(s.reason).toBe('磁盘不足');
    expect(Number.isNaN(Date.parse(s.disabledAt))).toBe(false);
  });

  it('disable 幂等：已是禁用态时不改写状态文件', () => {
    const home = freshHome();
    run(['image', 'disable', '--reason', '第一次'], home);
    const before = fs.readFileSync(stateFile(home), 'utf-8');
    const r = run(['image', 'disable', '--reason', '第二次'], home);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('已是禁用态');
    expect(fs.readFileSync(stateFile(home), 'utf-8')).toBe(before);
    expect(readState(home).reason).toBe('第一次');
  });

  it('禁用后 status 报已禁用 + 恢复指引，退出 1', () => {
    const home = freshHome();
    run(['image', 'disable'], home);
    const r = run(['image', 'status'], home);
    expect(r.stdout).toContain('图像能力: 已禁用');
    expect(r.stdout).toContain('lmedia image enable');
    expect(r.status).toBe(1);
  });

  it('enable 写回 enabled=true，但资产缺失时列出缺口并退出 1', () => {
    const home = freshHome();
    run(['image', 'disable'], home);
    const r = run(['image', 'enable'], home);
    expect(readState(home).enabled).toBe(true);
    expect(r.stdout).toContain('图像能力已启用');
    // 缺口清单随 exit 1 走 stderr（与仓内「结果 stdout / 异常 stderr」惯例一致）
    expect(r.stderr).toContain('Qwen-Image-2512 快照');
    expect(r.stderr).toContain('hf download');
    expect(r.status).toBe(1);
  });
});

describe('gate 分域（禁用态）', () => {
  const disabledHome = () => {
    const home = freshHome();
    run(['image', 'disable'], home);
    return home;
  };

  it('gen 被拦：给恢复指引而非「运行时未找到」', () => {
    const home = disabledHome();
    const r = run(['image', 'gen', '测试'], home);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('图像能力已禁用');
    expect(r.stderr).toContain('lmedia image enable');
    expect(r.stderr).toContain('--engine doubao');
    expect(r.stderr).not.toContain('运行时未找到'); // gate 必须早于 resolveRuntime
  });

  it('edit 被拦（先于参考图存在性校验）', () => {
    const home = disabledHome();
    const r = run(['image', 'edit', '测试', '--ref', '/nope/missing.png'], home);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('图像能力已禁用');
    expect(r.stderr).not.toContain('运行时未找到');
  });

  it('upscale 被拦', () => {
    const home = disabledHome();
    const r = run(['image', 'upscale', 'a.png', 'b.png'], home);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('图像能力已禁用');
  });

  it('serve start 被拦，且不落任何 socket/日志（未探测、未拉起）', () => {
    const home = disabledHome();
    const r = run(['image', 'serve', 'start', '--mode', 'gen'], home);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('图像能力已禁用');
    const serveDir = path.join(home, '.lmedia', 'serve');
    const files = fs.existsSync(serveDir) ? fs.readdirSync(serveDir) : [];
    expect(files.filter((f) => /\.(sock|log|json)$/.test(f))).toEqual([]);
  });

  it('serve stop / serve status 不被拦（自救路径）', () => {
    const home = disabledHome();
    for (const sub of ['stop', 'status']) {
      const r = run(['image', 'serve', sub], home);
      expect(r.stderr).not.toContain('图像能力已禁用');
    }
  });

  it('image --help 列出开关三命令且不被拦', () => {
    const home = disabledHome();
    const r = run(['image', '--help'], home);
    expect(r.status).toBe(0);
    for (const c of ['disable', 'enable', 'status']) expect(r.stdout).toContain(c);
  });
});

describe('状态文件损坏：fail-closed（不猜）', () => {
  const corrupt = (content: string) => {
    const home = freshHome();
    fs.mkdirSync(path.dirname(stateFile(home)), { recursive: true });
    fs.writeFileSync(stateFile(home), content);
    return home;
  };

  it.each([['{ broken', '非法 JSON'], ['{}', '缺 enabled'], ['[]', '根不是对象']])(
    '内容 %s → gen 拒绝执行并给出两条修复路径',
    (content) => {
      const r = run(['image', 'gen', '测试'], corrupt(content));
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('损坏');
      expect(r.stderr).toContain('lmedia image enable');
      expect(r.stderr).toContain('rm ');
    },
  );

  it('损坏态 doctor 退出 1（不掩盖真实故障）', () => {
    const r = run(['doctor'], corrupt('{ broken'));
    expect(r.stdout).toContain('能力状态文件损坏');
    expect(r.status).toBe(1);
  });

  it('损坏态 enable 可用新状态覆盖重写修复', () => {
    const home = corrupt('{ broken');
    const r = run(['image', 'enable'], home);
    expect(r.stderr).toContain('已用新状态覆盖');
    expect(readState(home).enabled).toBe(true);
  });
});

describe('逃生口与路径覆盖', () => {
  it('LMEDIA_NO_IMAGE_GATE=1 绕过 gate 并告警', () => {
    const home = freshHome();
    run(['image', 'disable'], home);
    const r = run(['image', 'gen', '测试'], home, { LMEDIA_NO_IMAGE_GATE: '1' });
    expect(r.stderr).toContain('已绕过图像能力 gate');
    expect(r.stderr).not.toContain('被拦截的命令');
  });

  it('LMEDIA_IMAGE_STATE 覆盖默认状态文件路径', () => {
    const home = freshHome();
    const custom = path.join(freshHome(), 'cap.json');
    const r = run(['image', 'disable'], home, { LMEDIA_IMAGE_STATE: custom });
    expect(r.status).toBe(0);
    expect(fs.existsSync(custom)).toBe(true);
    expect(fs.existsSync(stateFile(home))).toBe(false);
  });
});

describe('doctor 与开关的联动', () => {
  it('禁用态：图像段跳过、daemon 不判定为故障，且不再恒 exit 1', () => {
    const home = freshHome();
    run(['image', 'disable', '--reason', '磁盘不足'], home);
    const r = run(['doctor'], home);
    expect(r.stdout).toContain('图像能力已禁用');
    expect(r.stdout).toContain('检查已跳过');
    expect(r.stdout).toContain('图像模态已禁用');
    expect(r.stdout).not.toContain('✗ [image] Qwen-Image-2512 快照');
    expect(r.status).toBe(0);
  });

  it('未禁用但资产缺失：doctor 仍 exit 1（豁免只在禁用态）', () => {
    const r = run(['doctor'], freshHome());
    expect(r.stdout).toContain('✗ [image] Qwen-Image-2512 快照');
    expect(r.status).toBe(1);
  });
});
