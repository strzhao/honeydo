/**
 * 红队验收（E2E / 黑盒）—— honeydo `etts` 能力包
 *
 * SSOT：state.md `## 契约规约` + `## 验收场景`（编排器冻结谓词）。信息隔离声明：
 * 本文件仅依据设计文档三节（目标/设计文档/验收场景）与 context.md 编写，
 * 未读取任何实现代码（packages/etts/src、packages/etts/python 一律未读）。
 *
 * 运行前置（绑定约定，失败即红灯、绝不宽容跳过）：
 *  - 被测 bin = `node packages/etts/dist/cli.js`；dist 缺失时 beforeAll 执行 repo 根
 *    `npm run build` 置备，构建失败 = 契约 14.P1 未满足 = 红灯。
 *  - venv = ETTS_RUNTIME 专属临时目录（契约：ETTS_RUNTIME > ~/.etts/venv），由
 *    `etts setup` 置备（契约幂等）；setup 自带探测合成 → exit 0 即 PyPI/微软端点可达。
 *  - 网络依赖场景（1/2/3/4.P2/P3/5/6/7/8/9/10.P1/12/13/15.P1/P2/P4/P5/P6/P7/P8）
 *    依赖微软端点可达（绑定约定：2026-10-12 dry run 实测直连可用）。
 *
 * sha256 相等断言降级口径（绑定约定，场景 2.P2/10.P1）——[QA auto-fix 2026-10-13 已改判落码]：
 * QA 实证服务端编码非确定性（同音色同文本两轮 sha 异 / 时长全等 / MPEG 格式同 / stderr 回显
 * 同，artifact /tmp/etts-qa-evidence/）→「相等」断言已改为回显一致 + 时长差 <0.5s + 双非空
 * MPEG；「不等」断言（异音色）保持 sha 硬判。证据链见 state.md 变更日志。
 *
 * 防自递归哨兵：场景 14.P4 需真实执行 `npm test --workspace @stringzhao/etts`，
 * 其子进程会再次加载本文件。子进程 env 携带 ETTS_ACCEPTANCE_CHILD=1 时本文件整体
 * skipIf 跳过——该 skip 仅发生在「验收测试自嵌套执行」层，其断言职责由外层进程的
 * exit==0 硬断言替代；正常入口（CI / 手动 vitest run，无哨兵）下全量硬断言执行。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  collectFiles,
  countAttemptMarks,
  durationSec,
  ensureDist,
  ensureVenv,
  ETTS_BIN,
  ETTS_PKG_ROOT,
  exitCodes,
  extractVoiceRows,
  HONEYDO_BIN,
  lastLine,
  readJsonlFile,
  REPO_ROOT,
  runBin,
  runCmd,
  runHoneydo,
  runNpm,
  sha256File,
  tmpDir,
  venvPython,
  voiceLine,
  writeJsonl,
  type CliResult,
} from './helpers/etts-utils';

/** 防自递归哨兵（见文件头注释） */
const SELF_CHILD = process.env.ETTS_ACCEPTANCE_CHILD === '1';

/* 共享目录 / 状态 */
let venvDir = ''; // ETTS_RUNTIME 专属 venv（网络场景共用）
const cleanupDirs: string[] = [];
const GEN_TEXT = '你好，世界';

function netEnv(extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return { ...process.env, ETTS_RUNTIME: venvDir, ...extra };
}

function expectMp3(p: string, minSize = 1024): void {
  expect(fs.existsSync(p)).toBe(true);
  expect(fs.statSync(p).size).toBeGreaterThanOrEqual(minSize);
}

describe.skipIf(SELF_CHILD)('etts 红队验收（谓词 SSOT 全覆盖）', () => {
  beforeAll(async () => {
    venvDir = tmpDir('etts-acc-venv-');
    cleanupDirs.push(venvDir);
    // dist 前置：缺失即构建，构建失败 throw（= 14.P1 红灯），后续所有测试依赖它
    await ensureDist();
  }, 600_000);

  afterAll(() => {
    for (const d of cleanupDirs) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {
        /* 清理失败不影响判定 */
      }
    }
  });

  /* ================================================================
   * 场景 14：工程门禁四件套与构建产物（最先执行，置备 dist）
   * ================================================================ */
  describe('场景14 工程门禁', () => {
    test('14.P1 [real-process] npm run build exit==0 且 packages/etts dist 入口存在', { timeout: 600_000 }, async () => {
      const r = await runNpm(['run', 'build'], { cwd: REPO_ROOT, timeoutMs: 590_000 });
      expect(r.code).toBe(0);
      expect(fs.existsSync(ETTS_BIN)).toBe(true);
    });

    test('14.P2 [det-machine] etts dist 产物比 src 源文件更新（freshness_check == FRESH）', () => {
      expect(fs.existsSync(ETTS_BIN)).toBe(true);
      const srcFiles = collectFiles(path.join(ETTS_PKG_ROOT, 'src'), '.ts');
      expect(srcFiles.length).toBeGreaterThan(0);
      const maxSrcMtime = Math.max(...srcFiles.map((f) => fs.statSync(f).mtimeMs));
      const distMtime = fs.statSync(ETTS_BIN).mtimeMs;
      // 「dist 比 src 更新」：容忍同毫秒写入的理论边界，故取 >=（旧 dist < 新 src 必挂）
      expect(distMtime).toBeGreaterThanOrEqual(maxSrcMtime);
    });

    test('14.P3 [real-process] npm run typecheck exit==0', { timeout: 300_000 }, async () => {
      const r = await runNpm(['run', 'typecheck'], { cwd: REPO_ROOT, timeoutMs: 290_000 });
      expect(r.code).toBe(0);
    });

    test('14.P4 [real-process] npm test exit==0 且输出覆盖 etts', { timeout: 600_000 }, async () => {
      // 静态覆盖证明：根 workspaces 收录 packages/*（etts 位于其下）
      const rootPkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
        workspaces?: unknown;
      };
      const ws = rootPkg.workspaces;
      expect(Array.isArray(ws) && ws.some((w) => w === 'packages/etts' || w === 'packages/*')).toBe(true);
      // etts 包名（架构契约 @stringzhao/etts）+ test script 已声明
      const ettsPkg = JSON.parse(fs.readFileSync(path.join(ETTS_PKG_ROOT, 'package.json'), 'utf8')) as {
        name?: string;
        scripts?: Record<string, string>;
      };
      expect(ettsPkg.name).toBe('@stringzhao/etts');
      expect(typeof ettsPkg.scripts?.test).toBe('string');
      // 动态执行：真实跑 etts 包测试（哨兵 env 防本文件自递归，见文件头）
      const r = await runNpm(['test', '--workspace', '@stringzhao/etts'], {
        cwd: REPO_ROOT,
        timeoutMs: 590_000,
        env: { ETTS_ACCEPTANCE_CHILD: '1' },
      });
      expect(r.code).toBe(0);
    });

    test('14.P5 [real-process] npm run lint exit==0', { timeout: 300_000 }, async () => {
      const r = await runNpm(['run', 'lint'], { cwd: REPO_ROOT, timeoutMs: 290_000 });
      expect(r.code).toBe(0);
    });
  });

  /* ================================================================
   * 场景 11：参数校验与 0/1/2 契约（全部无网络依赖）
   * ================================================================ */
  describe('场景11 参数校验与 0/1/2 契约', () => {
    test('11.P1 [real-process] --gender x 非法 → exit==2', { timeout: 60_000 }, async () => {
      const out = path.join(tmpDir('etts-p11-'), 'o.mp3');
      const r = await runBin(['gen', GEN_TEXT, '--voice', 'zh-CN-XiaoxiaoNeural', '--out', out, '--gender', 'x'], {
        timeoutMs: 55_000,
      });
      expect(r.code).toBe(2);
    });

    test('11.P2 [real-process] gen 缺 --out → exit==2', { timeout: 60_000 }, async () => {
      const r = await runBin(['gen', GEN_TEXT, '--voice', 'zh-CN-XiaoxiaoNeural'], { timeoutMs: 55_000 });
      expect(r.code).toBe(2);
    });

    test('11.P3 [real-process] gen 无 voice 无 lang → exit==2', { timeout: 60_000 }, async () => {
      const r = await runBin(['gen', GEN_TEXT], { timeoutMs: 55_000 });
      expect(r.code).toBe(2);
    });

    test('11.P4 [real-process] batch manifest 不存在 → exit==2', { timeout: 60_000 }, async () => {
      const missing = path.join(tmpDir('etts-p11b-'), 'no-such.jsonl');
      const r = await runBin(['batch', missing], { timeoutMs: 55_000 });
      expect(r.code).toBe(2);
    });

    test('11.P5 [real-process] 未知子命令 → exit==2 且 stderr 非空', { timeout: 60_000 }, async () => {
      const r = await runBin(['frobnicate'], { timeoutMs: 55_000 });
      expect(r.code).toBe(2);
      expect(r.stderr.trim().length).toBeGreaterThan(0);
    });

    test('契约补充：parseArgs 未知 flag → exit==2（契约·错误契约逐字）', { timeout: 60_000 }, async () => {
      const out = path.join(tmpDir('etts-p11c-'), 'o.mp3');
      const r = await runBin(['gen', GEN_TEXT, '--voice', 'zh-CN-XiaoxiaoNeural', '--out', out, '--bogus', 'x'], {
        timeoutMs: 55_000,
      });
      expect(r.code).toBe(2);
    });

    test('15.P3 [real-process] --retry 非法值 → exit 2（gen --retry 0 / gen --retry abc / batch --retry 0）', { timeout: 90_000 }, async () => {
      const out = path.join(tmpDir('etts-p15c-'), 'o.mp3');
      const r1 = await runBin(['gen', GEN_TEXT, '--voice', 'zh-CN-XiaoxiaoNeural', '--out', out, '--retry', '0'], {
        timeoutMs: 55_000,
      });
      expect(r1.code).toBe(2);
      const r2 = await runBin(['gen', GEN_TEXT, '--voice', 'zh-CN-XiaoxiaoNeural', '--out', out, '--retry', 'abc'], {
        timeoutMs: 55_000,
      });
      expect(r2.code).toBe(2);
      // batch 侧：给合法 manifest，排除「manifest 缺失也 exit 2」的歧义，锁定 exit 2 由 --retry 引起
      const dir = tmpDir('etts-p15d-');
      cleanupDirs.push(dir);
      const okManifest = path.join(dir, 'ok.jsonl');
      writeJsonl(okManifest, [{ text: GEN_TEXT, out: path.join(dir, 'x.mp3'), voice: 'zh-CN-XiaoxiaoNeural' }]);
      const r3 = await runBin(['batch', okManifest, '--retry', '0'], { timeoutMs: 55_000 });
      expect(r3.code).toBe(2);
    });
  });

  /* ================================================================
   * 场景 4：setup 置备 + doctor 自检闭环（后续网络场景的前置）
   * ================================================================ */
  describe('场景4 setup/doctor', () => {
    beforeAll(async () => {
      await ensureVenv(venvDir);
    }, 600_000);

    test('4.P1 [real-process] venv 未置备时 etts doctor exit != 0', { timeout: 120_000 }, async () => {
      // 独立空目录作 ETTS_RUNTIME（契约：ETTS_RUNTIME > ~/.etts/venv）→ venv 缺失域
      const noVenv = path.join(tmpDir('etts-acc-novenv-'), 'no-such-venv');
      cleanupDirs.push(path.dirname(noVenv));
      const r = await runBin(['doctor'], { env: { ...process.env, ETTS_RUNTIME: noVenv }, timeoutMs: 110_000 });
      expect(r.code).not.toBe(0);
      // 契约·错误契约：venv 缺失 → exit 1 + stderr 带 setup 指引。doctor 的报告形态由契约
      // stdout 格式节单独规定（逐项检查行），`etts: venv not found at …` 逐字字面量属
      // gen/batch 运行时路径（蓝队 cli-exit 契约测试已覆盖），不适用于 doctor。
      // [QA auto-fix 2026-10-13] 原断言误用 gen 路径字面量，按契约修正为 doctor 检查行格式。
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/venv: FAIL \(not found at .+; run: etts setup\)/);
    });

    test('4.P2 [real-process] etts setup exit==0 且 venv python `import edge_tts` exit==0', { timeout: 600_000 }, async () => {
      // ensureVenv 已置备；此处重跑验证契约幂等（重复跑安全）
      const r = await runBin(['setup'], { env: netEnv(), timeoutMs: 590_000 });
      expect(r.code).toBe(0);
      const imp = await runCmd(venvPython(venvDir), ['-c', 'import edge_tts'], { timeoutMs: 55_000 });
      expect(imp.code).toBe(0);
    });

    test('4.P3 [real-process] 置备后 etts doctor exit==0', { timeout: 120_000 }, async () => {
      const r = await runBin(['doctor'], { env: netEnv(), timeoutMs: 110_000 });
      expect(r.code).toBe(0);
    });
  });

  /* ================================================================
   * 场景 1：gen 显式 --voice 合成 mp3（happy path）
   * ================================================================ */
  describe('场景1 gen happy path', () => {
    test('1.P1 [real-process] gen --voice 合成 → exit==0 && exists && size>=1024', { timeout: 120_000 }, async () => {
      const dir = tmpDir('etts-s1-');
      cleanupDirs.push(dir);
      const out = path.join(dir, 'hello.mp3');
      const r = await runBin(['gen', GEN_TEXT, '--voice', 'zh-CN-XiaoxiaoNeural', '--out', out], {
        env: netEnv(),
        timeoutMs: 110_000,
      });
      expect(r.code).toBe(0);
      expectMp3(out);
    });

    test('1.P2 [det-machine] gen 成功时 stdout 末行含输出文件路径', { timeout: 120_000 }, async () => {
      const dir = tmpDir('etts-s1b-');
      cleanupDirs.push(dir);
      const out = path.join(dir, 'hello.mp3');
      const r = await runBin(['gen', GEN_TEXT, '--voice', 'zh-CN-XiaoxiaoNeural', '--out', out], {
        env: netEnv(),
        timeoutMs: 110_000,
      });
      expect(r.code).toBe(0);
      // 契约·stdout 格式逐字：末行 `Saved to: <绝对路径>`
      const ll = lastLine(r.stdout);
      expect(ll.startsWith('Saved to: ')).toBe(true);
      expect(ll).toContain('hello.mp3');
      expect(path.isAbsolute(ll.slice('Saved to: '.length).trim())).toBe(true);
    });
  });

  /* ================================================================
   * 场景 2：gen --lang + --gender 查表解析
   * ================================================================ */
  describe('场景2 --lang/--gender 查表', () => {
    test('2.P1 [real-process] --lang zh-CN --gender f 与 --gender m 各产出一音频且内容不同', { timeout: 240_000 }, async () => {
      const dir = tmpDir('etts-s2-');
      cleanupDirs.push(dir);
      const fOut = path.join(dir, 'zh-f.mp3');
      const mOut = path.join(dir, 'zh-m.mp3');
      const rf = await runBin(['gen', GEN_TEXT, '--lang', 'zh-CN', '--gender', 'f', '--out', fOut], {
        env: netEnv(),
        timeoutMs: 110_000,
      });
      expect(rf.code).toBe(0);
      const rm = await runBin(['gen', GEN_TEXT, '--lang', 'zh-CN', '--gender', 'm', '--out', mOut], {
        env: netEnv(),
        timeoutMs: 110_000,
      });
      expect(rm.code).toBe(0);
      expectMp3(fOut);
      expectMp3(mOut);
      // QA 降级口径（绑定约定）仅适用于「相等」断言假红的复核；此处为「不等」断言，直接硬判
      expect(sha256File(fOut)).not.toBe(sha256File(mOut));
    });

    test('2.P2 [real-process] 仅 --lang zh-CN（省略 gender）与 --gender f 产出一致', { timeout: 240_000 }, async () => {
      const dir = tmpDir('etts-s2b-');
      cleanupDirs.push(dir);
      const dOut = path.join(dir, 'zh-default.mp3');
      const fOut = path.join(dir, 'zh-f.mp3');
      const rd = await runBin(['gen', GEN_TEXT, '--lang', 'zh-CN', '--out', dOut], {
        env: netEnv(),
        timeoutMs: 110_000,
      });
      expect(rd.code).toBe(0);
      const rf = await runBin(['gen', GEN_TEXT, '--lang', 'zh-CN', '--gender', 'f', '--out', fOut], {
        env: netEnv(),
        timeoutMs: 110_000,
      });
      expect(rf.code).toBe(0);
      // [QA auto-fix 2026-10-13] sha 相等断言按绑定约定降级口径改判：QA 实证服务端编码
      // 非确定性（同音色同文本两轮 sha 异 / 时长全等 3.216s / MPEG 格式同 / stderr 回显同，
      // artifact /tmp/etts-qa-evidence/）→ 相等改为「回显一致 + 时长差 <0.5s + 双非空 MPEG」。
      expect(voiceLine(rd.stderr)).toBe(voiceLine(rf.stderr));
      expectMp3(dOut);
      expectMp3(fOut);
      expect(Math.abs((await durationSec(dOut)) - (await durationSec(fOut)))).toBeLessThan(0.5);
    });
  });

  /* ================================================================
   * 场景 10：音色解析优先级与表外报错
   * ================================================================ */
  describe('场景10 音色解析优先级', () => {
    test('10.P1 [real-process] --voice+--lang 同时给定 → 与 voice-only 一致、与 lang-only 不同', { timeout: 300_000 }, async () => {
      const dir = tmpDir('etts-s10-');
      cleanupDirs.push(dir);
      const voiceOnly = path.join(dir, 'voice-only.mp3');
      const both = path.join(dir, 'both.mp3');
      const langOnly = path.join(dir, 'lang-only.mp3');
      const r1 = await runBin(['gen', GEN_TEXT, '--voice', 'zh-CN-XiaoxiaoNeural', '--out', voiceOnly], {
        env: netEnv(),
        timeoutMs: 110_000,
      });
      expect(r1.code).toBe(0);
      const r2 = await runBin(
        ['gen', GEN_TEXT, '--voice', 'zh-CN-XiaoxiaoNeural', '--lang', 'ko-KR', '--out', both],
        { env: netEnv(), timeoutMs: 110_000 },
      );
      expect(r2.code).toBe(0);
      const r3 = await runBin(['gen', GEN_TEXT, '--lang', 'ko-KR', '--out', langOnly], {
        env: netEnv(),
        timeoutMs: 110_000,
      });
      expect(r3.code).toBe(0);
      // [QA auto-fix 2026-10-13] 相等侧同 2.P2 降级口径（服务端编码非确定性实证，留痕见
      // state.md 变更日志）；不等侧（both=zh-CN-Xiaoxiao vs langOnly=ko-KR-SunHi，异音色
      // 必异音频）保持 sha 硬判。
      expect(voiceLine(r2.stderr)).toBe(voiceLine(r1.stderr));
      expectMp3(both);
      expectMp3(voiceOnly);
      expect(Math.abs((await durationSec(both)) - (await durationSec(voiceOnly)))).toBeLessThan(0.5);
      expect(sha256File(both)).not.toBe(sha256File(langOnly));
    });

    test('10.P2 [real-process] --lang zz-ZZ 表外 → exit!=0、无输出文件、stderr 非空', { timeout: 120_000 }, async () => {
      const dir = tmpDir('etts-s10b-');
      cleanupDirs.push(dir);
      const out = path.join(dir, 'zz.mp3');
      const r = await runBin(['gen', GEN_TEXT, '--lang', 'zz-ZZ', '--out', out], {
        env: netEnv(),
        timeoutMs: 110_000,
      });
      expect(r.code).not.toBe(0);
      // 契约·退出码：gen 音色无法解析 → exit 2
      expect(r.code).toBe(2);
      expect(fs.existsSync(out)).toBe(false);
      expect(r.stderr.trim().length).toBeGreaterThan(0);
    });
  });

  /* ================================================================
   * 场景 3：voices 列表与 --lang 过滤；场景 15.P4：voices --json
   * ================================================================ */
  describe('场景3 voices', () => {
    let fullRows: { shortName: string; gender: string; locale: string }[] = [];

    test('3.P1 [real-process] etts voices 输出非空且 distinct locale >= 15', { timeout: 120_000 }, async () => {
      const r = await runBin(['voices'], { env: netEnv(), timeoutMs: 110_000 });
      expect(r.code).toBe(0);
      expect(r.stdout.trim().length).toBeGreaterThan(0);
      // 契约·stdout 格式逐字：人读表格列 ShortName/Gender/Locale
      expect(r.stdout).toContain('ShortName');
      expect(r.stdout).toContain('Locale');
      fullRows = extractVoiceRows(r.stdout);
      expect(fullRows.length).toBeGreaterThan(0);
      const locales = new Set(fullRows.map((row) => row.locale));
      expect(locales.size).toBeGreaterThanOrEqual(15);
    });

    test('3.P2 [real-process] etts voices --lang zh-CN 每行含 zh-CN 且行数 < 全量', { timeout: 120_000 }, async () => {
      const r = await runBin(['voices', '--lang', 'zh-CN'], { env: netEnv(), timeoutMs: 110_000 });
      expect(r.code).toBe(0);
      const rows = extractVoiceRows(r.stdout);
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        // [QA auto-fix 2026-10-13] SSOT 谓词口径「每行含 zh-CN」：方言变体
        // （zh-CN-liaoning-XiaobeiNeural / zh-CN-shaanxi-XiaoniNeural，端点真实存在）
        // 合法命中前缀过滤，非精确 locale 相等——原断言比谓词更严，予以修正。
        expect(row.locale).toMatch(/^zh-CN/);
      }
      expect(fullRows.length).toBeGreaterThan(0); // 依赖 3.P1 先执行（同文件顺序执行）
      expect(rows.length).toBeLessThan(fullRows.length);
    });

    test('15.P4 [det-machine] voices --json 末行为合法 JSON 数组且元素含 shortName/locale 字段', { timeout: 120_000 }, async () => {
      const r = await runBin(['voices', '--json'], { env: netEnv(), timeoutMs: 110_000 });
      expect(r.code).toBe(0);
      const arr = JSON.parse(lastLine(r.stdout)) as unknown;
      expect(Array.isArray(arr)).toBe(true);
      const items = arr as Record<string, unknown>[];
      expect(items.length).toBeGreaterThan(0);
      // 契约·驱动协议 voices 输出逐字字段：shortName / gender(Male|Female) / locale
      for (const it of items) {
        expect(typeof it.shortName).toBe('string');
        expect(typeof it.locale).toBe('string');
        expect(['Male', 'Female']).toContain(it.gender);
      }
    });
  });

  /* ================================================================
   * 场景 5：batch 全部成功；场景 13：流纪律；场景 15.P6：summary JSON
   * ================================================================ */
  describe('场景5 batch 全成功 + 场景13 流纪律 + 15.P6 summary', () => {
    const dir = tmpDir('etts-s5-');
    cleanupDirs.push(dir);
    const manifest = path.join(dir, 'manifest-ok.jsonl');
    const failuresPath = path.join(dir, 'failures.jsonl');
    const outs = {
      voice: path.join(dir, 'ok-voice.mp3'),
      lang: path.join(dir, 'ok-lang.mp3'),
      langGender: path.join(dir, 'ok-lang-gender.mp3'),
    };
    let res: CliResult | null = null;

    async function batchOkOnce(): Promise<CliResult> {
      if (!res) {
        writeJsonl(manifest, [
          { text: '快速棕色狐狸', out: outs.voice, voice: 'zh-CN-XiaoxiaoNeural' },
          { text: 'jumps over the lazy dog', out: outs.lang, lang: 'en-US' },
          { text: 'bonjour le monde', out: outs.langGender, lang: 'fr-FR', gender: 'm' },
        ]);
        res = await runBin(['batch', manifest, '--failures', failuresPath], { env: netEnv(), timeoutMs: 240_000 });
      }
      return res;
    }

    test('5.P1 [real-process] 3 行全合法 → exit==0 且 3 个 out 文件 size>=1024', { timeout: 300_000 }, async () => {
      const r = await batchOkOnce();
      expect(r.code).toBe(0);
      expectMp3(outs.voice);
      expectMp3(outs.lang);
      expectMp3(outs.langGender);
    });

    test('5.P2 [det-machine] --failures 指定时失败清单为空（文件不存在视为 0 条）', { timeout: 10_000 }, async () => {
      await batchOkOnce();
      // 谓词明示的合法双形态：0 失败时不写文件，或写出空清单
      const empty = !fs.existsSync(failuresPath) || readJsonlFile(failuresPath).length === 0;
      expect(empty).toBe(true);
    });

    test('5.P3 [det-machine] stdout 含各成功条目输出文件名', { timeout: 10_000 }, async () => {
      const r = await batchOkOnce();
      expect(r.stdout).toContain('ok-voice.mp3');
      expect(r.stdout).toContain('ok-lang.mp3');
      expect(r.stdout).toContain('ok-lang-gender.mp3');
    });

    test('13.P1 [real-process] batch 成功条目路径出现在 stdout', { timeout: 10_000 }, async () => {
      const r = await batchOkOnce();
      expect(r.stdout).toContain(outs.voice);
      expect(r.stdout).toContain(outs.lang);
      expect(r.stdout).toContain(outs.langGender);
    });

    test('13.P2 [det-machine] 多条目 batch 的 stderr 非空（进度承载）', { timeout: 10_000 }, async () => {
      const r = await batchOkOnce();
      expect(r.stderr.trim().length).toBeGreaterThan(0);
    });

    test('15.P6 [det-machine] batch 末行 summary 为单行 JSON（total/ok/skipped/failed/seconds）', { timeout: 10_000 }, async () => {
      const r = await batchOkOnce();
      const summary = JSON.parse(lastLine(r.stdout)) as Record<string, unknown>;
      for (const k of ['total', 'ok', 'skipped', 'failed', 'seconds']) {
        expect(typeof summary[k]).toBe('number');
      }
      expect((summary.ok as number) + (summary.skipped as number) + (summary.failed as number)).toBe(
        summary.total as number,
      );
      // 本轮 3 行全成功：字段语义逐条对齐
      expect(summary.total).toBe(3);
      expect(summary.ok).toBe(3);
      expect(summary.skipped).toBe(0);
      expect(summary.failed).toBe(0);
    });
  });

  /* ================================================================
   * 场景 7：batch 部分失败 → 失败清单 + exit 1；场景 15.P1/P8 契约补测
   * ================================================================ */
  describe('场景7 batch 部分失败 + 15.P1/P8', () => {
    const dir = tmpDir('etts-s7-');
    cleanupDirs.push(dir);
    const outs = {
      a: path.join(dir, 'mix-a.mp3'),
      b: path.join(dir, 'mix-b.mp3'),
      c: path.join(dir, 'mix-c.mp3'),
      d: path.join(dir, 'mix-d.mp3'),
    };
    const failuresPath = path.join(dir, 'failures.jsonl');
    let mixed: CliResult | null = null;
    let mixedFailures: Record<string, unknown>[] = [];

    async function batchMixedOnce(): Promise<CliResult> {
      if (!mixed) {
        const manifest = path.join(dir, 'manifest-mixed.jsonl');
        writeJsonl(manifest, [
          { text: 'alpha', out: outs.a, voice: 'zh-CN-XiaoxiaoNeural' }, // A 合法 voice
          { text: 'beta', out: outs.b, lang: 'en-US' }, // B 合法 lang
          { text: 'gamma', out: outs.c, voice: 'zz-FakeNonexistentNeural' }, // C 不存在音色
          { text: 'delta', out: outs.d }, // D 无 voice 无 lang
        ]);
        mixed = await runBin(['batch', manifest, '--failures', failuresPath], { env: netEnv(), timeoutMs: 240_000 });
        mixedFailures = fs.existsSync(failuresPath) ? readJsonlFile(failuresPath) : [];
      }
      return mixed;
    }

    test('7.P1 [real-process] exit==1 && 失败清单恰 2 条 && 含 C、D 的 out 路径', { timeout: 300_000 }, async () => {
      const r = await batchMixedOnce();
      expect(r.code).toBe(1);
      expect(mixedFailures.length).toBe(2);
      const outsSorted = mixedFailures.map((f) => f.out).sort();
      expect(outsSorted).toEqual([outs.c, outs.d].sort());
      // 契约·失败清单结构逐字字段：index/text/out/voice?/error
      for (const f of mixedFailures) {
        expect(typeof f.index).toBe('number');
        expect(typeof f.text).toBe('string');
        expect(typeof f.out).toBe('string');
        expect(typeof f.error).toBe('string');
      }
    });

    test('7.P2 [det-machine] 合法行 A、B 仍正常产出（不整体中止）', { timeout: 10_000 }, async () => {
      await batchMixedOnce();
      expectMp3(outs.a);
      expectMp3(outs.b);
    });

    test('7.P3 [det-machine] 失败行 C 的目标路径无残留文件', { timeout: 10_000 }, async () => {
      await batchMixedOnce();
      expect(fs.existsSync(outs.c)).toBe(false);
    });

    test('15.P8 [det-machine] 失败清单 error 透传端点错误原文（非空且非单字 failed）', { timeout: 10_000 }, async () => {
      await batchMixedOnce();
      const c = mixedFailures.find((f) => f.out === outs.c);
      expect(c).toBeDefined();
      const msg = String(c?.error ?? '');
      expect(msg.length).toBeGreaterThan(10);
      expect(msg.toLowerCase()).not.toBe('failed');
      // 谓词：含所请求 voice 名 或 403/NoAudioReceived 片段（契约：错误串原样透传，禁吞改写）
      expect(msg.includes('zz-FakeNonexistentNeural') || /403|NoAudioReceived/i.test(msg)).toBe(true);
    });
  });

  describe('15.P1 坏 JSON / 注释 / 空行 manifest', () => {
    test('15.P1 [real-process] 合法行照常产出、坏行入清单、index 为物理行号、error 含 invalid JSON', { timeout: 300_000 }, async () => {
      const dir = tmpDir('etts-s15a-');
      cleanupDirs.push(dir);
      const manifest = path.join(dir, 'manifest.jsonl');
      const goodA = path.join(dir, 'good-a.mp3');
      const goodB = path.join(dir, 'good-b.mp3');
      const bad0 = '{"text": "bad0", "voice": "zh-CN-XiaoxiaoNeural"'; // 行0：截断 JSON
      const bad5 = 'this is not json !!'; // 行5：非 JSON
      const lines = [
        bad0, // 行0（0 起物理行号）
        '# 这是一行注释', // 行1：注释行跳过
        '', // 行2：空行跳过
        JSON.stringify({ text: 'good three', out: goodA, voice: 'zh-CN-XiaoxiaoNeural' }), // 行3
        JSON.stringify({ text: 'good four', out: goodB, lang: 'de-DE' }), // 行4
        bad5, // 行5
      ];
      fs.writeFileSync(manifest, lines.join('\n') + '\n');
      const failuresPath = path.join(dir, 'failures.jsonl');
      const r = await runBin(['batch', manifest, '--failures', failuresPath], { env: netEnv(), timeoutMs: 240_000 });
      expect(r.code).toBe(1);
      expect(fs.existsSync(failuresPath)).toBe(true);
      const failures = readJsonlFile(failuresPath);
      expect(failures.length).toBe(2);
      // 契约逐字：index 为「0 起、含注释/空行在内的物理行号」→ 首坏行 index===0、次坏行 index===5
      expect(failures[0].index).toBe(0);
      expect(failures[1].index).toBe(5);
      // 契约逐字：`error: "invalid JSON: <原文前 80 字符>"`（坏行原文 48 字符 < 80，应完整包含）
      const err0 = String(failures[0].error);
      expect(err0.startsWith('invalid JSON: ')).toBe(true);
      expect(err0).toContain(bad0);
      // 合法行照常产出（不中断）
      expectMp3(goodA);
      expectMp3(goodB);
    });
  });

  /* ================================================================
   * 场景 8：--skip-existing；场景 15.P7：0 字节视为不存在
   * ================================================================ */
  describe('场景8 --skip-existing + 15.P7', () => {
    test('8.P1 [real-process] 带 --skip-existing 重跑已存在目标：exit==0 且 mtime 不变', { timeout: 300_000 }, async () => {
      const dir = tmpDir('etts-s8-');
      cleanupDirs.push(dir);
      const manifest = path.join(dir, 'm.jsonl');
      const failuresPath = path.join(dir, 'f.jsonl');
      const out = path.join(dir, 'skip.mp3');
      writeJsonl(manifest, [{ text: GEN_TEXT, out, voice: 'zh-CN-XiaoxiaoNeural' }]);
      // 轮0：生成
      const r0 = await runBin(['batch', manifest, '--failures', failuresPath], { env: netEnv(), timeoutMs: 240_000 });
      expect(r0.code).toBe(0);
      expectMp3(out);
      // 固定 mtime 为历史时间戳 T0，规避时钟精度干扰
      const T0 = 1_000_000_000_000; // 2001-09-09
      fs.utimesSync(out, new Date(T0), new Date(T0));
      // 轮1：--skip-existing 重跑
      const r1 = await runBin(['batch', manifest, '--skip-existing', '--failures', failuresPath], {
        env: netEnv(),
        timeoutMs: 240_000,
      });
      expect(r1.code).toBe(0);
      expect(fs.statSync(out).mtimeMs).toBe(T0); // 不重写 = mtime 恒等于 T0
      const summary = JSON.parse(lastLine(r1.stdout)) as Record<string, number>;
      expect(summary.skipped).toBe(1);
      expect(summary.failed).toBe(0);
    });

    test('8.P2 [real-process] 不带 skip 的对照轮：exit==0 且 mtime 前移', { timeout: 300_000 }, async () => {
      const dir = tmpDir('etts-s8b-');
      cleanupDirs.push(dir);
      const manifest = path.join(dir, 'm.jsonl');
      const out = path.join(dir, 'noskip.mp3');
      writeJsonl(manifest, [{ text: GEN_TEXT, out, voice: 'zh-CN-XiaoxiaoNeural' }]);
      const r0 = await runBin(['batch', manifest], { env: netEnv(), timeoutMs: 240_000 });
      expect(r0.code).toBe(0);
      const T0 = 1_000_000_000_000;
      fs.utimesSync(out, new Date(T0), new Date(T0));
      const r1 = await runBin(['batch', manifest], { env: netEnv(), timeoutMs: 240_000 });
      expect(r1.code).toBe(0);
      expect(fs.statSync(out).mtimeMs).toBeGreaterThan(T0); // 重合成 = mtime 前移
      const summary = JSON.parse(lastLine(r1.stdout)) as Record<string, number>;
      expect(summary.skipped).toBe(0);
    });

    test('15.P7 [real-process] --skip-existing 遇 size==0 已存在文件视为不存在：重合成且产物 size>0', { timeout: 300_000 }, async () => {
      const dir = tmpDir('etts-s15b-');
      cleanupDirs.push(dir);
      const manifest = path.join(dir, 'm.jsonl');
      const out = path.join(dir, 'zero.mp3');
      fs.writeFileSync(out, ''); // 预置 0 字节文件
      writeJsonl(manifest, [{ text: GEN_TEXT, out, voice: 'zh-CN-XiaoxiaoNeural' }]);
      const r = await runBin(['batch', manifest, '--skip-existing'], { env: netEnv(), timeoutMs: 240_000 });
      expect(r.code).toBe(0);
      expect(fs.statSync(out).size).toBeGreaterThan(0);
      const summary = JSON.parse(lastLine(r.stdout)) as Record<string, number>;
      expect(summary.skipped).toBe(0); // 0 字节不算 skipped（契约：size==0 视为不存在）
    });
  });

  /* ================================================================
   * 场景 9：--retry 逐条重试
   * ================================================================ */
  describe('场景9 --retry 逐条重试', () => {
    let retry2Marks = -1;
    let defaultFailuresPath = '';

    /**
     * 持续失败的确定性构造：不存在音色 + 不可达代理（--proxy http://127.0.0.1:9，契约 CLI flag）。
     * 每次尝试立即 ECONNREFUSED，不依赖网络异常运气。
     */
    function retryManifest(dir: string): string {
      const manifest = path.join(dir, 'm.jsonl');
      writeJsonl(manifest, [{ text: 'retry probe', out: path.join(dir, 'retry.mp3'), voice: 'zz-FakeNonexistentNeural' }]);
      return manifest;
    }

    test('9.P1 [real-process] --retry 2 且某行持续失败：stderr 尝试标记 >=2 且 exit==1', { timeout: 300_000 }, async () => {
      const dir = tmpDir('etts-s9-');
      cleanupDirs.push(dir);
      const manifest = retryManifest(dir);
      const r = await runBin(
        ['batch', manifest, '--retry', '2', '--proxy', 'http://127.0.0.1:9', '--failures', path.join(dir, 'f.jsonl')],
        { env: netEnv(), timeoutMs: 240_000 },
      );
      expect(r.code).toBe(1);
      // CONTRACT_AMBIGUOUS: 绑定约定「标记措辞以实现为准，契约仅约束存在且可计数」
      retry2Marks = countAttemptMarks(r.stderr);
      expect(retry2Marks).toBeGreaterThanOrEqual(2);
    });

    test('9.P2 [det-machine] 默认轮尝试标记数 >=3 且 > retry2 轮', { timeout: 300_000 }, async () => {
      const dir = tmpDir('etts-s9b-');
      cleanupDirs.push(dir);
      defaultFailuresPath = path.join(dir, 'f.jsonl');
      const manifest = retryManifest(dir);
      const r = await runBin(
        ['batch', manifest, '--proxy', 'http://127.0.0.1:9', '--failures', defaultFailuresPath],
        { env: netEnv(), timeoutMs: 240_000 },
      );
      expect(r.code).toBe(1);
      const marks = countAttemptMarks(r.stderr);
      expect(marks).toBeGreaterThanOrEqual(3); // 契约：--retry 缺省 3
      expect(retry2Marks).toBeGreaterThanOrEqual(0);
      expect(marks).toBeGreaterThan(retry2Marks);
    });

    test('9.P3 [det-machine] 失败行在失败清单中恰 1 条（重试不产生重复条目）', { timeout: 10_000 }, () => {
      // 依赖 9.P2 轮的失败清单（同文件顺序执行保证先跑）
      expect(defaultFailuresPath).not.toBe('');
      expect(fs.existsSync(defaultFailuresPath)).toBe(true);
      expect(readJsonlFile(defaultFailuresPath).length).toBe(1);
    });
  });

  /* ================================================================
   * 场景 12：代理透传（env）；场景 15.P5：代理透传（CLI flag）
   * ================================================================ */
  describe('场景12 代理透传 + 15.P5', () => {
    const PROXY = 'http://127.0.0.1:9'; // 不可达代理（discard 端口）

    test('12.P1 [real-process] ETTS_PROXY=http://127.0.0.1:9 → exit!=0 且无产物', { timeout: 120_000 }, async () => {
      const dir = tmpDir('etts-s12-');
      cleanupDirs.push(dir);
      const out = path.join(dir, 'px.mp3');
      const r = await runBin(['gen', GEN_TEXT, '--voice', 'zh-CN-XiaoxiaoNeural', '--out', out], {
        env: netEnv({ ETTS_PROXY: PROXY, NO_PROXY: '' }),
        timeoutMs: 110_000,
      });
      expect(r.code).not.toBe(0);
      expect(fs.existsSync(out)).toBe(false);
    });

    test('12.P2 [real-process] 仅 HTTPS_PROXY=http://127.0.0.1:9 → exit!=0 且无产物', { timeout: 120_000 }, async () => {
      const dir = tmpDir('etts-s12b-');
      cleanupDirs.push(dir);
      const out = path.join(dir, 'px2.mp3');
      const r = await runBin(['gen', GEN_TEXT, '--voice', 'zh-CN-XiaoxiaoNeural', '--out', out], {
        env: netEnv({ HTTPS_PROXY: PROXY, ETTS_PROXY: '', NO_PROXY: '' }),
        timeoutMs: 110_000,
      });
      expect(r.code).not.toBe(0);
      expect(fs.existsSync(out)).toBe(false);
    });

    test('15.P5 [real-process] gen --proxy http://127.0.0.1:9 → exit!=0 且无产物（CLI flag 路径）', { timeout: 120_000 }, async () => {
      const dir = tmpDir('etts-s15c-');
      cleanupDirs.push(dir);
      const out = path.join(dir, 'px3.mp3');
      const r = await runBin(
        ['gen', GEN_TEXT, '--voice', 'zh-CN-XiaoxiaoNeural', '--out', out, '--proxy', PROXY],
        { env: netEnv({ ETTS_PROXY: '', HTTPS_PROXY: '', NO_PROXY: '' }), timeoutMs: 110_000 },
      );
      expect(r.code).not.toBe(0);
      expect(fs.existsSync(out)).toBe(false);
    });
  });

  /* ================================================================
   * 场景 15.P2：lang 主子标签两分支
   * ================================================================ */
  describe('15.P2 lang 主子标签', () => {
    test('15.P2 [real-process] --lang ja 唯一命中 ja-JP（exit 0 + stderr 回显）；--lang zh 多义 → exit==2', { timeout: 240_000 }, async () => {
      const dir = tmpDir('etts-s15d-');
      cleanupDirs.push(dir);
      const jaOut = path.join(dir, 'ja.mp3');
      const rJa = await runBin(['gen', GEN_TEXT, '--lang', 'ja', '--out', jaOut], {
        env: netEnv(),
        timeoutMs: 110_000,
      });
      expect(rJa.code).toBe(0);
      expectMp3(jaOut);
      // 契约·stderr 回显：`voice: <name> (via lang <locale>, gender <g>)`
      // CONTRACT_AMBIGUOUS: `<locale>` 回显输入值(ja)还是命中值(ja-JP)未声明 → 仅硬断言 voice 名与回显前缀
      expect(rJa.stderr).toContain('ja-JP-NanamiNeural');
      expect(rJa.stderr).toMatch(/voice: ja-JP-NanamiNeural/);

      const zhOut = path.join(dir, 'zh.mp3');
      const rZh = await runBin(['gen', GEN_TEXT, '--lang', 'zh', '--out', zhOut], {
        env: netEnv(),
        timeoutMs: 110_000,
      });
      // 契约·边界值：表内多义（zh 命中 zh-HK/zh-CN）→ 报错，exit 2 in gen
      expect(rZh.code).toBe(2);
      expect(rZh.stderr.trim().length).toBeGreaterThan(0);
      expect(fs.existsSync(zhOut)).toBe(false);
    });
  });

  /* ================================================================
   * 场景 6：主壳路由 honeydo etts + bin 独立可用
   * ================================================================ */
  describe('场景6 主壳路由', () => {
    test('6.P1 [real-process] honeydo etts voices exit==0 且 stdout 非空', { timeout: 120_000 }, async () => {
      const r = await runHoneydo(['etts', 'voices'], { env: netEnv(), timeoutMs: 110_000 });
      expect(r.code).toBe(0);
      expect(r.stdout.trim().length).toBeGreaterThan(0);
    });

    test('6.P2 [real-process] honeydo etts gen 真实产出 mp3（size>=1024）', { timeout: 120_000 }, async () => {
      const dir = tmpDir('etts-s6-');
      cleanupDirs.push(dir);
      const out = path.join(dir, 'route.mp3');
      const r = await runHoneydo(['etts', 'gen', '主壳路由冒烟', '--voice', 'zh-CN-XiaoxiaoNeural', '--out', out], {
        env: netEnv(),
        timeoutMs: 110_000,
      });
      expect(r.code).toBe(0);
      expectMp3(out);
    });

    test('6.P3 [real-process] 不经主壳直接 etts voices exit==0', { timeout: 120_000 }, async () => {
      const r = await runBin(['voices'], { env: netEnv(), timeoutMs: 110_000 });
      expect(r.code).toBe(0);
    });
  });

  /* ================================================================
   * 场景 11.P6：全命令面 exit 值均落在 {0,1,2}（汇总断言，最后执行）
   * ================================================================ */
  describe('11.P6 退出码全集汇总', () => {
    test('11.P6 [det-machine] 全命令面实测 exit 值均落在 {0,1,2}', () => {
      expect(exitCodes.length).toBeGreaterThan(0); // 防空集合 no-op
      for (const code of exitCodes) {
        expect([0, 1, 2]).toContain(code);
      }
    });
  });
});
