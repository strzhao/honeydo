/**
 * 红队验收测试 · 场景 4 / 场景12.P7-P8（setup 幂等 + doctor 诊断 + legacy 栈识别 + 发布白名单）。
 *
 * 场景 4：setup 幂等 + doctor 诊断   → P1-P5
 * 场景12.P7：legacy 栈布局（venv+image+tower 同层）经 H3_RUNTIME 指认 → doctor 识别为就绪
 * 场景12.P8：npm pack 产物含出厂资产（assets/h3-styles/picturebook/ 锚页）
 *
 * doctor 用例说明：doctor 是全模态自检，[video]/[sfx] 等非 image 节按本机真实栈求值
 * （runDoctorCli 保留 LMEDIA_RUNTIME / HF_* 与真实 HOME）；[image] 节由桩 H3_RUNTIME +
 * 隔离 LMEDIA_IMAGE_STATE（不存在 = 默认启用，h3 检查才会真正执行）驱动。
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  makeFixture,
  npmPackDryRunFiles,
  readJson,
  REPO_ROOT,
  runDoctorCli,
  runH3Cli,
  stubRuntime,
} from './helpers/h3-utils';

describe('场景 4：setup 幂等 + doctor 诊断', () => {
  it('场景4.P1 [real-process] 空 runtime 首次 setup（mock 跳过 pip 安装）→ exit 0 且 venv python 可执行', { timeout: 60_000 }, async () => {
    const fx = makeFixture('h3-s4p1-');
    try {
      const r = await runH3Cli(['image', 'setup'], { env: fx.env() });
      expect(r.code).toBe(0);
      const py = path.join(fx.runtime, 'venv', 'bin', 'python');
      expect(fs.existsSync(py)).toBe(true);
      fs.accessSync(py, fs.constants.X_OK); // 不可执行会抛
    } finally {
      fx.dispose();
    }
  });

  it('场景4.P2 [real-process] 第二次 setup 幂等 → exit 0', { timeout: 60_000 }, async () => {
    const fx = makeFixture('h3-s4p2-');
    try {
      const r1 = await runH3Cli(['image', 'setup'], { env: fx.env() });
      expect(r1.code).toBe(0);
      const r2 = await runH3Cli(['image', 'setup'], { env: fx.env() });
      expect(r2.code).toBe(0);
    } finally {
      fx.dispose();
    }
  });

  it('场景4.P3 [det-machine] 新鲜度：venv 关键产物（bin/python、pyvenv.cfg）mtime ≥ setup 触发时刻', { timeout: 60_000 }, async () => {
    const fx = makeFixture('h3-s4p3-');
    try {
      const t0 = Date.now() - 1000; // 1s 松量吸收 fs mtime 粒度
      const r = await runH3Cli(['image', 'setup'], { env: fx.env() });
      expect(r.code).toBe(0);
      const py = path.join(fx.runtime, 'venv', 'bin', 'python');
      const cfg = path.join(fx.runtime, 'venv', 'pyvenv.cfg');
      expect(fs.existsSync(py)).toBe(true);
      expect(fs.existsSync(cfg)).toBe(true);
      expect(fs.statSync(py).mtimeMs).toBeGreaterThanOrEqual(t0);
      expect(fs.statSync(cfg).mtimeMs).toBeGreaterThanOrEqual(t0);
    } finally {
      fx.dispose();
    }
  });

  it('场景4.P4 [real-process] venv+桩权重在位 → doctor exit 0 且列出检查项（[image] 节）', { timeout: 60_000 }, async () => {
    const fx = makeFixture('h3-s4p4-');
    stubRuntime(fx.runtime, 'new');
    try {
      const r = await runDoctorCli(['doctor'], { env: fx.env() });
      expect(r.code).toBe(0);
      expect(r.stdout.includes('[image]')).toBe(true);
    } finally {
      fx.dispose();
    }
  });

  it('场景4.P5 [real-process] 权重缺失 → doctor exit 1 且 stderr 含缺失项与 setup 指引', { timeout: 60_000 }, async () => {
    const fx = makeFixture('h3-s4p5-');
    stubRuntime(fx.runtime, 'new', { weights: false });
    try {
      const r = await runDoctorCli(['doctor'], { env: fx.env() });
      expect(r.code).toBe(1);
      // 缺失项指名（权重/weights/缺失一类）+ fix 指引含 setup
      expect(/权重|weights|缺失|missing|transformer|text_encoder/i.test(r.stderr)).toBe(true);
      expect(/setup/i.test(r.stderr)).toBe(true);
    } finally {
      fx.dispose();
    }
  });
});

describe('场景 12（契约闭集：栈布局与发布面）', () => {
  it('场景12.P7 [det-machine] legacy 布局（venv+image+tower 同层）经 H3_RUNTIME 指认 → doctor 识别为就绪', { timeout: 60_000 }, async () => {
    const fx = makeFixture('h3-s12p7-');
    stubRuntime(fx.runtime, 'legacy');
    try {
      const r = await runDoctorCli(['doctor'], { env: fx.env() });
      expect(r.code).toBe(0);
      expect(r.stdout.includes('[image]')).toBe(true);
    } finally {
      fx.dispose();
    }
  });

  it('场景12.P8 [det-machine] npm pack 产物含出厂资产（picturebook 锚页）', { timeout: 60_000 }, async () => {
    // ① 包级：npm pack --dry-run 列表含 assets/h3-styles/picturebook/ 下的图像锚页
    const files = npmPackDryRunFiles();
    expect(
      files.some((f) => /^assets\/h3-styles\/picturebook\/.+\.(png|jpe?g|webp)$/i.test(f)),
    ).toBe(true);
    // 出厂资产双轴齐备：pipi 角色卡同样随包（设计：双轴出厂资产内置）
    expect(
      files.some((f) => /^assets\/h3-chars\/pipi\/.+\.(png|jpe?g|webp)$/i.test(f)),
    ).toBe(true);
    // ② 仓级：发布 = 根包 tarball（packages/* 布局），根 files 白名单必须放行 lmedia assets
    const rootPkg = readJson<{ files?: string[] }>(path.join(REPO_ROOT, 'package.json'));
    expect(
      (rootPkg.files ?? []).some((f) => f === 'packages/lmedia/assets' || f.startsWith('packages/lmedia/assets/')),
    ).toBe(true);
  });
});
