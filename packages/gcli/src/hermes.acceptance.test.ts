import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseSubcommand, run } from "./cli.js";

// ============================================================================
// 红队验收测试 — gcli `hermes` 子命令（hermes agent 模型/provider 一键切换器）
//
// 信息隔离铁律：本文件仅基于设计文档「契约规约」「验收场景」编写，
// 未读蓝队实现源码。若蓝队未按下方 DI 契约导出符号 / 形状不一致，
// 本文件红灯失败是预期 —— 届时由蓝队对齐契约。
//
// 契约（逐字取自设计文档）：
//   gcli hermes <provider> [--model <m>] [--dry-run] [--no-verify] [--keep-on-fail]
//   gcli hermes            # TTY: 复用现有 picker；非 TTY: exit 2（零交互红线）
//   gcli hermes status     # exit 0，stdout 当前 provider/model/上次切换摘要
//   gcli hermes rollback   # exit 0 成功 / exit 1 无 state 或回滚失败
//   exit 0=成功 / 1=后端或验证失败 / 2=参数错误/非 TTY 缺 provider
//   stdout 纯净：switch/rollback 进度全走 stderr；stdout 仅 status/dry-run
//   失败路径一律 resolve {ok:false} / {exitCode,stderr}，禁止 throw 穿透 main()
//
// RunDeps 新增 5 注入点（契约逐字）：
//   runHermes(args, timeoutMs)
//   readTextFile(path)
//   writeTextFileAtomic(path, text, mode?)
//   copyFile(src, dst)
//   queryLastSessionModel()
//
// 文件契约：
//   registry ~/.config/gcli/hermes-providers.json
//     {[ccSwitchName]: {id, keyEnv, modelOverride?}}；损坏/缺失 → 视为空
//   state ~/.config/gcli/hermes-state.json (0o600)
//     {lastSwitch: {ts:number, ccName, to:{id,model,base_url},
//       from:{id,model,base_url}, configBackup,
//       env:{key, prevValue:string|null},
//       cronRepinned:[{jobId, prevProvider, prevModel}]}}
//   备份命名 config.yaml.bak-before-<slug>-<epoch>
//   内置 seed：Kimi For Coding→kimi-coding/KIMI_CODING_API_KEY、
//             glm flash lastest→glm-flash/BIGMODEL_API_KEY
//   token 红线：stdout/stderr/dry-run 永不打印 token 值；dry-run 计划行 KEY=<redacted>
//
// CONTRACT_AMBIGUOUS 汇总（实现若偏离此处假设，红灯后需契约对齐，非测试放宽）：
//   1. readTextFile 错误通道假定为 throw ENOENT（registry 缺失→视为空由实现 catch）
//   2. runHermes 返回值假定为 RunOutcome {exitCode,stdout,stderr}
//   3. ping 验证调用假定为 runHermes(["-z","ping"], 60000)（设计步骤 8 逐字）
//   4. queryLastSessionModel 形状未钉死；本测试默认返 null（无数据/best-effort 跳过）
//   5. home 解析假定 os.homedir() 常量（契约未提供 homedir 注入点；未考虑 XDG）
//   6. picker skip 的 exit code 未钉死，按「非失败=0」断言
//   7. 未知 provider exit code 1-vs-2 未钉死，只断言非零+语义+零副作用
//   8. id 冲突源按设计文字「推导 id 与 config 已有条目冲突」理解为
//      config.yaml providers 段已有同 id 条目
//   9. toggle rollback 依赖 rollback 流程自身也执行「备份先行」并刷新
//      state.configBackup（否则第二跳无 B 备份可恢复，与「支持来回 toggle」矛盾）
//  10. model 段三键按真实 config.yaml 观察为 default/provider/base_url
//  11. cron edit 参数形按设计步骤 6 逐字：
//      ["cron","edit",<id>,"--provider",<new>,"--model",<m>]
// ============================================================================

// ---------------------------------------------------------------------------
// 路径常量（fixture-home = os.homedir() 下的替身路径，键入 fake FS Map）
// ---------------------------------------------------------------------------

const HOME = os.homedir();
const P = {
  config: path.join(HOME, ".hermes", "config.yaml"),
  env: path.join(HOME, ".hermes", ".env"),
  cronJobs: path.join(HOME, ".hermes", "cron", "jobs.json"),
  registry: path.join(HOME, ".config", "gcli", "hermes-providers.json"),
  state: path.join(HOME, ".config", "gcli", "hermes-state.json"),
};

// ---------------------------------------------------------------------------
// cc-switch provider 夹具（token 一律用夹具值，绝不用真实 token）
// ---------------------------------------------------------------------------

const TOKEN_KIMI = "TEST-TOKEN-DEADBEEF"; // 场景 15 指定夹具值
const TOKEN_GLM = "TEST-TOKEN-GLM-OLD";
const TOKEN_DEEPSEEK = "TEST-TOKEN-DEEPSEEK";

const GLM_RAW = {
  name: "glm flash lastest",
  settingsConfig: {
    env: {
      ANTHROPIC_BASE_URL: "https://open.bigmodel.cn/api/anthropic",
      ANTHROPIC_AUTH_TOKEN: TOKEN_GLM,
      ANTHROPIC_MODEL: "glm-5.3-flash",
    },
  },
};
const KIMI_RAW = {
  name: "Kimi For Coding",
  settingsConfig: {
    env: {
      ANTHROPIC_BASE_URL: "https://api.kimi.com/coding/",
      ANTHROPIC_AUTH_TOKEN: TOKEN_KIMI,
      // 带 [1M] 上下文后缀，stripContextSuffix 后应为 kimi-k3
      ANTHROPIC_MODEL: "kimi-k3[1M]",
    },
  },
};
const DEEPSEEK_RAW = {
  name: "DeepSeek Official",
  settingsConfig: {
    env: {
      ANTHROPIC_BASE_URL: "https://deepseek.example.com/anthropic",
      ANTHROPIC_AUTH_TOKEN: TOKEN_DEEPSEEK,
      ANTHROPIC_MODEL: "deepseek-v4-flash",
    },
  },
};
const TOKENLESS_RAW = {
  name: "Tokenless One",
  settingsConfig: {
    env: {
      ANTHROPIC_BASE_URL: "https://tokenless.example.com",
      ANTHROPIC_MODEL: "tokenless-1",
    },
  },
};
const MODELLESS_RAW = {
  name: "Modelless One",
  settingsConfig: {
    env: {
      ANTHROPIC_BASE_URL: "https://modelless.example.com",
      ANTHROPIC_AUTH_TOKEN: "TEST-TOKEN-MODELLESS",
    },
  },
};
const ALL_PROVIDERS = [
  GLM_RAW,
  KIMI_RAW,
  DEEPSEEK_RAW,
  TOKENLESS_RAW,
  MODELLESS_RAW,
];

// ---------------------------------------------------------------------------
// hermes 文件夹具（结构按真实 ~/.hermes/config.yaml 观察：model 段 3 键
// default/provider/base_url；providers 段 2 空格 id + 4 空格字段，最后顶层段）
// ---------------------------------------------------------------------------

// 现状 A：当前 provider = glm-flash（providers 段尚无 kimi-coding 条目 → 切换须追加）
const CONFIG_A = `model:
  default: glm-5.3-flash
  provider: glm-flash
  base_url: https://open.bigmodel.cn/api/anthropic
agent:
  max_turns: 90
providers:
  glm-flash:
    name: GLM Flash
    base_url: https://open.bigmodel.cn/api/anthropic
    transport: anthropic_messages
    key_env: BIGMODEL_API_KEY
    default_model: glm-5.3-flash
`;

// 现状 B：当前 provider = kimi-coding（rollback 测试起点）
const CONFIG_B = `model:
  default: kimi-k3
  provider: kimi-coding
  base_url: https://api.kimi.com/coding/
agent:
  max_turns: 90
providers:
  glm-flash:
    name: GLM Flash
    base_url: https://open.bigmodel.cn/api/anthropic
    transport: anthropic_messages
    key_env: BIGMODEL_API_KEY
    default_model: glm-5.3-flash
  kimi-coding:
    name: Kimi Coding Plan
    base_url: https://api.kimi.com/coding/
    transport: anthropic_messages
    key_env: KIMI_CODING_API_KEY
    default_model: kimi-k3
`;

// id 冲突夹具：config providers 段已占用 deepseek-official（指向不同 base_url）
const CONFIG_A_WITH_CONFLICT = `model:
  default: glm-5.3-flash
  provider: glm-flash
  base_url: https://open.bigmodel.cn/api/anthropic
agent:
  max_turns: 90
providers:
  glm-flash:
    name: GLM Flash
    base_url: https://open.bigmodel.cn/api/anthropic
    transport: anthropic_messages
    key_env: BIGMODEL_API_KEY
    default_model: glm-5.3-flash
  deepseek-official:
    name: Legacy DeepSeek
    base_url: https://legacy-deepseek.example.com
    transport: anthropic_messages
    key_env: LEGACY_DEEPSEEK_API_KEY
    default_model: deepseek-old
`;

// 畸形夹具 1：缺 providers: 顶层段
const CONFIG_NO_PROVIDERS = `model:
  default: glm-5.3-flash
  provider: glm-flash
  base_url: https://open.bigmodel.cn/api/anthropic
agent:
  max_turns: 90
`;

// 畸形夹具 2：model 段意外嵌套
const CONFIG_NESTED_MODEL = `model:
  default: glm-5.3-flash
  provider: glm-flash
  base_url: https://open.bigmodel.cn/api/anthropic
  nested:
    oops: 1
agent:
  max_turns: 90
providers:
  glm-flash:
    name: GLM Flash
    base_url: https://open.bigmodel.cn/api/anthropic
    transport: anthropic_messages
    key_env: BIGMODEL_API_KEY
    default_model: glm-5.3-flash
`;

// .env 夹具：含注释与空行（upsert 须原样保留）
const ENV_A = `# hermes api keys
BIGMODEL_API_KEY=${TOKEN_GLM}

`;

// cron jobs 夹具：job-a1/a2 pin glm-flash（enabled）；job-c1 pin deepseek-official；
// job-nopin 未 pin；job-off pin glm-flash 但 disabled
const JOBS_JSON = JSON.stringify({
  jobs: [
    {
      id: "job-a1",
      enabled: true,
      provider: "glm-flash",
      model: "glm-5.3-flash",
    },
    {
      id: "job-a2",
      enabled: true,
      provider: "glm-flash",
      model: "glm-5.3-flash",
    },
    {
      id: "job-c1",
      enabled: true,
      provider: "deepseek-official",
      model: "deepseek-v4-flash",
    },
    { id: "job-nopin", enabled: true, provider: null, model: null },
    {
      id: "job-off",
      enabled: false,
      provider: "glm-flash",
      model: "glm-5.3-flash",
    },
  ],
});

// rollback 用的 state 夹具（glm-flash → kimi-coding 一跳）
const BACKUP_PATH = path.join(
  HOME,
  ".hermes",
  "config.yaml.bak-before-kimi-coding-1757000000",
);
function stateFileGlmToKimi(prevValue: string | null) {
  return JSON.stringify({
    lastSwitch: {
      ts: 1757000000000,
      ccName: "Kimi For Coding",
      to: {
        id: "kimi-coding",
        model: "kimi-k3",
        base_url: "https://api.kimi.com/coding/",
      },
      from: {
        id: "glm-flash",
        model: "glm-5.3-flash",
        base_url: "https://open.bigmodel.cn/api/anthropic",
      },
      configBackup: BACKUP_PATH,
      env: { key: "KIMI_CODING_API_KEY", prevValue },
      cronRepinned: [
        {
          jobId: "job-a1",
          prevProvider: "glm-flash",
          prevModel: "glm-5.3-flash",
        },
        {
          jobId: "job-a2",
          prevProvider: "glm-flash",
          prevModel: "glm-5.3-flash",
        },
      ],
    },
  });
}

// rollback 起点的 jobs.json：job-a1/a2 已 pin 在 kimi-coding
const JOBS_ON_KIMI = JSON.stringify({
  jobs: [
    { id: "job-a1", enabled: true, provider: "kimi-coding", model: "kimi-k3" },
    { id: "job-a2", enabled: true, provider: "kimi-coding", model: "kimi-k3" },
    { id: "job-nopin", enabled: true, provider: null, model: null },
  ],
});

const ENV_WITH_KIMI = `# hermes api keys
BIGMODEL_API_KEY=${TOKEN_GLM}
KIMI_CODING_API_KEY=${TOKEN_KIMI}
`;

// ---------------------------------------------------------------------------
// fake FS（Map<string,string>）+ 全局副作用时序记录 seq
// ---------------------------------------------------------------------------

type WriteRec = { path: string; text: string; mode?: number };
type CopyRec = { src: string; dst: string };
type HermesCall = { args: string[]; timeoutMs?: number };

function makeFs(seed: Record<string, string>) {
  const files = new Map<string, string>(Object.entries(seed));
  const writes: WriteRec[] = [];
  const copies: CopyRec[] = [];
  const seq: string[] = [];
  // DI 契约（cli.ts RunDeps JSDoc）：readTextFile 缺失/不可读 → resolve undefined（不 throw）
  const readTextFile = vi.fn(
    async (p: string): Promise<string | undefined> => files.get(p),
  );
  const writeTextFileAtomic = vi.fn(
    async (
      p: string,
      text: string,
      mode?: number,
    ): Promise<{ ok: true } | { ok: false; error: string }> => {
      writes.push({ path: p, text, mode });
      seq.push(`write:${p}`);
      files.set(p, text);
      return { ok: true };
    },
  );
  const copyFile = vi.fn(
    async (
      src: string,
      dst: string,
    ): Promise<{ ok: true } | { ok: false; error: string }> => {
      const v = files.get(src);
      if (v === undefined) {
        return { ok: false, error: `ENOENT: no such file: ${src}` };
      }
      copies.push({ src, dst });
      seq.push(`copy:${src}->${dst}`);
      files.set(dst, v);
      return { ok: true };
    },
  );
  return {
    files,
    writes,
    copies,
    seq,
    readTextFile,
    writeTextFileAtomic,
    copyFile,
  };
}

type RunOutcome = { exitCode: number; stdout: string; stderr: string };

// runHermes 故障注入路由器：handlers 按序匹配，未匹配默认成功
function makeRunHermes(
  seq: string[],
  calls: HermesCall[],
  fail?: (args: string[]) => RunOutcome | undefined,
) {
  return vi.fn(
    async (args: string[], timeoutMs?: number): Promise<RunOutcome> => {
      calls.push({ args, timeoutMs });
      seq.push(`hermes:${args.join(" ")}`);
      if (fail) {
        const r = fail(args);
        if (r) return r;
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  );
}

function makeDeps(opts: {
  files?: Record<string, string>;
  providers?: typeof ALL_PROVIDERS;
  isInteractive?: boolean;
  pickProvider?: ReturnType<typeof vi.fn>;
  runHermesFail?: (args: string[]) => RunOutcome | undefined;
  queryLastSessionModel?: ReturnType<typeof vi.fn>;
}) {
  const fs = makeFs(opts.files ?? {});
  const hermesCalls: HermesCall[] = [];
  const runHermes = makeRunHermes(fs.seq, hermesCalls, opts.runHermesFail);
  const deps = {
    // 既有 cc-switch / picker 接缝（机械覆盖）
    readCcSwitchProvider: vi.fn(async () => ({
      ok: true as const,
      providers: opts.providers ?? ALL_PROVIDERS,
    })),
    pickProvider:
      opts.pickProvider ??
      vi.fn(
        async (
          _entries: { name: string }[],
          _initialIndex: number,
        ): Promise<{ kind: "skip" }> => ({ kind: "skip" }),
      ),
    readLastProvider: vi.fn(async (): Promise<string | undefined> => undefined),
    writeLastProvider: vi.fn(async (): Promise<void> => {}),
    fetchProviderQuotas: vi.fn(
      async (): Promise<Map<string, string>> => new Map(),
    ),
    // 既有后端接缝（hermes 路径绝不应触发）
    runApi: vi.fn(
      async (): Promise<RunOutcome> => ({
        exitCode: 0,
        stdout: "",
        stderr: "",
      }),
    ),
    runClaude: vi.fn(
      async (): Promise<RunOutcome> => ({
        exitCode: 0,
        stdout: "",
        stderr: "",
      }),
    ),
    runAgy: vi.fn(
      async (): Promise<RunOutcome> => ({
        exitCode: 0,
        stdout: "",
        stderr: "",
      }),
    ),
    readStdin: vi.fn(async () => ""),
    runClaudeInteractive: vi.fn(async () => ({ exitCode: 0 })),
    runAgyInteractive: vi.fn(async () => ({ exitCode: 0 })),
    isInteractive: vi.fn(() => opts.isInteractive ?? false),
    // 契约新增 5 注入点
    runHermes,
    readTextFile: fs.readTextFile,
    writeTextFileAtomic: fs.writeTextFileAtomic,
    copyFile: fs.copyFile,
    queryLastSessionModel:
      opts.queryLastSessionModel ?? vi.fn(async () => undefined),
  };
  return { deps, fs, hermesCalls };
}

type Deps = ReturnType<typeof makeDeps>["deps"];
async function runHermesCli(argv: string[], deps: Deps) {
  // 契约落地后去掉 cast：fake 与 RunDeps 形状不一致时由 tsc 编译期抓出
  return run(argv, deps);
}

// ---------------------------------------------------------------------------
// 断言辅助
// ---------------------------------------------------------------------------

function cronEdits(calls: HermesCall[]) {
  return calls.filter((c) => c.args[0] === "cron" && c.args[1] === "edit");
}
function editJobId(c: HermesCall) {
  return c.args[2];
}
function editArg(c: HermesCall, flag: string) {
  const i = c.args.indexOf(flag);
  return i >= 0 ? c.args[i + 1] : undefined;
}
function gatewayCalls(calls: HermesCall[], sub: "stop" | "start") {
  return calls.filter((c) => c.args[0] === "gateway" && c.args[1] === sub);
}
function pingCalls(calls: HermesCall[]) {
  return calls.filter((c) => c.args[0] === "-z");
}
// model 段行级断言：2 空格缩进键只在 model 段出现（providers 段 id 顶格 2 空格
// 但带冒号直连，字段是 4 空格），可区分
function modelSectionHas(config: string, key: string, value: string) {
  return new RegExp(`^  ${key}: ${value}$`, "m").test(config);
}

// ============================================================================
// 子命令路由：parseSubcommand 新增 'hermes'
// ============================================================================

describe("parseSubcommand // hermes 子命令路由", () => {
  it("'hermes' → 剥首参，subcommand='hermes'，rest 保留", () => {
    const r = parseSubcommand(["hermes", "kimi", "--dry-run"]);
    expect("error" in r).toBe(false);
    if ("error" in r) throw new Error("unexpected error");
    expect(r.subcommand).toBe("hermes");
    expect(r.rest).toEqual(["kimi", "--dry-run"]);
  });

  it("'hermes status' / 'hermes rollback' 保留字进 rest（路由层不解释）", () => {
    const s = parseSubcommand(["hermes", "status"]);
    expect("error" in s).toBe(false);
    if (!("error" in s)) {
      expect(s.subcommand).toBe("hermes");
      expect(s.rest).toEqual(["status"]);
    }
    const rb = parseSubcommand(["hermes", "rollback"]);
    expect("error" in rb).toBe(false);
    if (!("error" in rb)) {
      expect(rb.subcommand).toBe("hermes");
      expect(rb.rest).toEqual(["rollback"]);
    }
  });

  it("不破坏既有路由：agy/claude/api 仍生效", () => {
    for (const sub of ["agy", "claude", "api"]) {
      const r = parseSubcommand([sub, "-p", "hi"]);
      expect("error" in r).toBe(false);
      if (!("error" in r)) expect(r.subcommand).toBe(sub);
    }
  });
});

// ============================================================================
// 场景 1：一键切换 Happy Path（P1-P6）+ 备份先行/原子写/state/stdout 纯净
// ============================================================================

describe("run() hermes switch // 场景1 happy path", () => {
  function happyDeps() {
    return makeDeps({
      files: {
        [P.config]: CONFIG_A,
        [P.env]: ENV_A,
        [P.cronJobs]: JOBS_JSON,
        // registry 缺失 → 视为空；kimi 走内置 seed
      },
    });
  }

  it("场景1.P1: exit code == 0", async () => {
    const { deps } = happyDeps();
    const r = await runHermesCli(["hermes", "kimi"], deps);
    expect(r.exitCode).toBe(0);
  });

  it("场景1.P2: config.yaml model 段与 providers 条目指向 kimi-coding/kimi-k3（且不再指向旧）", async () => {
    const { deps, fs } = happyDeps();
    const r = await runHermesCli(["hermes", "kimi"], deps);
    expect(r.exitCode).toBe(0);
    const cfg = fs.files.get(P.config);
    expect(cfg).toBeDefined();
    // model 段三键全换
    expect(modelSectionHas(cfg as string, "provider", "kimi-coding")).toBe(
      true,
    );
    expect(modelSectionHas(cfg as string, "default", "kimi-k3")).toBe(true);
    expect(
      modelSectionHas(
        cfg as string,
        "base_url",
        "https://api.kimi.com/coding/",
      ),
    ).toBe(true);
    // kill No-op mutation：model 段不再含旧 provider/旧模型
    expect(modelSectionHas(cfg as string, "provider", "glm-flash")).toBe(false);
    expect(modelSectionHas(cfg as string, "default", "glm-5.3-flash")).toBe(
      false,
    );
    // providers 段条目存在（新条目追加或 upsert），含目标 base_url 字段
    expect(cfg).toMatch(/^ {2}kimi-coding:$/m);
    expect(cfg).toMatch(/^ {4}base_url: https:\/\/api\.kimi\.com\/coding\/$/m);
  });

  it("场景1.P3: .env 含 KIMI_CODING_API_KEY= 条目；注释与旧 key 原样保留；写盘 mode 0o600", async () => {
    const { deps, fs } = happyDeps();
    const r = await runHermesCli(["hermes", "kimi"], deps);
    expect(r.exitCode).toBe(0);
    const env = fs.files.get(P.env) as string;
    expect(env).toMatch(/^KIMI_CODING_API_KEY=/m);
    expect(env).toContain("# hermes api keys");
    expect(env).toMatch(/^BIGMODEL_API_KEY=/m);
    const envWrites = fs.writes.filter((w) => w.path === P.env);
    expect(envWrites.length).toBeGreaterThan(0);
    // 契约：.env upsert 保持 0o600
    expect(envWrites[envWrites.length - 1].mode).toBe(0o600);
  });

  it("场景1.P4: cron edit 次数 == 旧 pin 任务数(2)，每条 --provider == kimi-coding --model == kimi-k3", async () => {
    const { deps, hermesCalls } = happyDeps();
    const r = await runHermesCli(["hermes", "kimi"], deps);
    expect(r.exitCode).toBe(0);
    const edits = cronEdits(hermesCalls);
    expect(edits.length).toBe(2);
    for (const e of edits) {
      expect(editArg(e, "--provider")).toBe("kimi-coding");
      expect(editArg(e, "--model")).toBe("kimi-k3");
    }
  });

  it("场景1.P5: gateway stop 先于 gateway start", async () => {
    const { deps, hermesCalls } = happyDeps();
    const r = await runHermesCli(["hermes", "kimi"], deps);
    expect(r.exitCode).toBe(0);
    const stops = gatewayCalls(hermesCalls, "stop");
    const starts = gatewayCalls(hermesCalls, "start");
    expect(stops.length).toBeGreaterThan(0);
    expect(starts.length).toBeGreaterThan(0);
    const stopIdx = hermesCalls.indexOf(stops[0]);
    const startIdx = hermesCalls.indexOf(starts[0]);
    expect(startIdx).toBeGreaterThan(stopIdx);
  });

  it("场景1.P6: 发起真实验证调用 runHermes(['-z', ...], 60000)", async () => {
    const { deps, hermesCalls } = happyDeps();
    const r = await runHermesCli(["hermes", "kimi"], deps);
    expect(r.exitCode).toBe(0);
    const pings = pingCalls(hermesCalls);
    expect(pings.length).toBe(1);
    expect(pings[0].args).toContain("ping");
    expect(pings[0].timeoutMs).toBe(60000);
  });

  it("场景1 附加: 成功写 state 文件（shape 逐字契约 + mode 0o600）", async () => {
    const { deps, fs } = happyDeps();
    const r = await runHermesCli(["hermes", "kimi"], deps);
    expect(r.exitCode).toBe(0);
    const stateWrites = fs.writes.filter((w) => w.path === P.state);
    expect(stateWrites.length).toBe(1);
    expect(stateWrites[0].mode).toBe(0o600);
    const st = JSON.parse(stateWrites[0].text) as {
      lastSwitch: Record<string, unknown>;
    };
    expect(typeof st.lastSwitch.ts).toBe("number");
    expect(st.lastSwitch.ccName).toBe("Kimi For Coding");
    expect(st.lastSwitch.to).toMatchObject({
      id: "kimi-coding",
      model: "kimi-k3",
      base_url: "https://api.kimi.com/coding/",
    });
    expect(st.lastSwitch.from).toMatchObject({
      id: "glm-flash",
      model: "glm-5.3-flash",
      base_url: "https://open.bigmodel.cn/api/anthropic",
    });
    expect(typeof st.lastSwitch.configBackup).toBe("string");
    expect(st.lastSwitch.env).toMatchObject({
      key: "KIMI_CODING_API_KEY",
      prevValue: null,
    });
    expect(st.lastSwitch.cronRepinned).toMatchObject([
      {
        jobId: "job-a1",
        prevProvider: "glm-flash",
        prevModel: "glm-5.3-flash",
      },
      {
        jobId: "job-a2",
        prevProvider: "glm-flash",
        prevModel: "glm-5.3-flash",
      },
    ]);
  });

  it("场景1 附加: 备份先行——copyFile 备份在 config 写入之前；备份名匹配契约模式", async () => {
    const { deps, fs } = happyDeps();
    const r = await runHermesCli(["hermes", "kimi"], deps);
    expect(r.exitCode).toBe(0);
    const bakCopy = fs.copies.find(
      (c) =>
        c.src === P.config &&
        /config\.yaml\.bak-before-kimi-coding-\d+$/.test(c.dst),
    );
    expect(bakCopy).toBeDefined();
    const copyIdx = fs.seq.indexOf(`copy:${P.config}->${bakCopy?.dst}`);
    const writeIdx = fs.seq.indexOf(`write:${P.config}`);
    expect(copyIdx).toBeGreaterThanOrEqual(0);
    expect(writeIdx).toBeGreaterThan(copyIdx);
  });

  it("场景1 附加: stdout 纯净——switch 进度全走 stderr，stdout 为空；不触发 claude/agy/api 后端", async () => {
    const { deps } = happyDeps();
    const r = await runHermesCli(["hermes", "kimi"], deps);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
    expect(deps.runClaude).not.toHaveBeenCalled();
    expect(deps.runAgy).not.toHaveBeenCalled();
    expect(deps.runApi).not.toHaveBeenCalled();
    expect(deps.runClaudeInteractive).not.toHaveBeenCalled();
    expect(deps.runAgyInteractive).not.toHaveBeenCalled();
  });

  it("场景1 附加: state.db 比对是 best-effort——queryLastSessionModel 返回不匹配行也不 fail", async () => {
    const { deps } = makeDeps({
      files: { [P.config]: CONFIG_A, [P.env]: ENV_A, [P.cronJobs]: JOBS_JSON },
      // CONTRACT_AMBIGUOUS(4): 形状未钉死；任何「不等于目标」的读数都不应致命
      queryLastSessionModel: vi.fn(async () => ({
        provider: "glm-flash",
        model: "glm-5.3-flash",
      })),
    });
    const r = await runHermesCli(["hermes", "kimi"], deps);
    expect(r.exitCode).toBe(0);
  });
});

// ============================================================================
// 场景 11：备份生成且内容 == 切换前快照（字节级）
// ============================================================================

describe("run() hermes switch // 场景11 备份", () => {
  it("场景11.P1+P2: 生成匹配命名模式的备份文件，内容逐字节 == 切换前 config", async () => {
    const { deps, fs } = makeDeps({
      files: { [P.config]: CONFIG_A, [P.env]: ENV_A, [P.cronJobs]: JOBS_JSON },
    });
    const r = await runHermesCli(["hermes", "kimi"], deps);
    expect(r.exitCode).toBe(0);
    const bak = fs.copies.find(
      (c) =>
        c.src === P.config &&
        /config\.yaml\.bak-before-kimi-coding-\d+$/.test(c.dst),
    );
    expect(bak).toBeDefined();
    expect(fs.files.get(bak?.dst as string)).toBe(CONFIG_A);
  });
});

// ============================================================================
// 三层匹配（exact → case-insensitive → substring）
// ============================================================================

describe("run() hermes provider 三层匹配", () => {
  for (const query of ["Kimi For Coding", "kimi for coding", "kimi"]) {
    it(`'${query}' → 命中 Kimi For Coding，exit 0 切到 kimi-coding`, async () => {
      const { deps, fs } = makeDeps({
        files: {
          [P.config]: CONFIG_A,
          [P.env]: ENV_A,
          [P.cronJobs]: JOBS_JSON,
        },
      });
      const r = await runHermesCli(["hermes", query], deps);
      expect(r.exitCode).toBe(0);
      const cfg = fs.files.get(P.config) as string;
      expect(modelSectionHas(cfg, "provider", "kimi-coding")).toBe(true);
    });
  }
});

// ============================================================================
// 模型名解析优先级：cc-switch ANTHROPIC_MODEL(strip) < registry modelOverride < --model
// ============================================================================

describe("run() hermes 模型名解析优先级", () => {
  it("cc-switch ANTHROPIC_MODEL 'kimi-k3[1M]' → stripContextSuffix 写 'kimi-k3'（不含 [1M]）", async () => {
    const { deps, fs } = makeDeps({
      files: { [P.config]: CONFIG_A, [P.env]: ENV_A, [P.cronJobs]: JOBS_JSON },
    });
    const r = await runHermesCli(["hermes", "kimi"], deps);
    expect(r.exitCode).toBe(0);
    const cfg = fs.files.get(P.config) as string;
    expect(modelSectionHas(cfg, "default", "kimi-k3")).toBe(true);
    expect(cfg).not.toContain("[1M]");
  });

  it("registry modelOverride 优先于 cc-switch model", async () => {
    const { deps, fs } = makeDeps({
      files: {
        [P.config]: CONFIG_A,
        [P.env]: ENV_A,
        [P.cronJobs]: JOBS_JSON,
        [P.registry]: JSON.stringify({
          "Kimi For Coding": {
            id: "kimi-coding",
            keyEnv: "KIMI_CODING_API_KEY",
            modelOverride: "k3-stable",
          },
        }),
      },
    });
    const r = await runHermesCli(["hermes", "kimi"], deps);
    expect(r.exitCode).toBe(0);
    const cfg = fs.files.get(P.config) as string;
    expect(modelSectionHas(cfg, "default", "k3-stable")).toBe(true);
    expect(modelSectionHas(cfg, "default", "kimi-k3")).toBe(false);
  });

  it("--model 最高优先，且持久化写回 registry modelOverride", async () => {
    const { deps, fs } = makeDeps({
      files: {
        [P.config]: CONFIG_A,
        [P.env]: ENV_A,
        [P.cronJobs]: JOBS_JSON,
        [P.registry]: JSON.stringify({
          "Kimi For Coding": {
            id: "kimi-coding",
            keyEnv: "KIMI_CODING_API_KEY",
            modelOverride: "k3-stable",
          },
        }),
      },
    });
    const r = await runHermesCli(
      ["hermes", "kimi", "--model", "kimi-k9"],
      deps,
    );
    expect(r.exitCode).toBe(0);
    const cfg = fs.files.get(P.config) as string;
    expect(modelSectionHas(cfg, "default", "kimi-k9")).toBe(true);
    const regWrites = fs.writes.filter((w) => w.path === P.registry);
    expect(regWrites.length).toBeGreaterThan(0);
    const reg = JSON.parse(regWrites[regWrites.length - 1].text) as Record<
      string,
      { id: string; keyEnv: string; modelOverride?: string }
    >;
    expect(reg["Kimi For Coding"].modelOverride).toBe("kimi-k9");
    // cron 重 pin 也用 --model 覆盖值
  });

  it("--model 覆盖值也用于 cron edit --model 参数", async () => {
    const { deps, hermesCalls } = makeDeps({
      files: { [P.config]: CONFIG_A, [P.env]: ENV_A, [P.cronJobs]: JOBS_JSON },
    });
    const r = await runHermesCli(
      ["hermes", "kimi", "--model", "kimi-k9"],
      deps,
    );
    expect(r.exitCode).toBe(0);
    for (const e of cronEdits(hermesCalls)) {
      expect(editArg(e, "--model")).toBe("kimi-k9");
    }
  });
});

// ============================================================================
// 设计步骤 1：无 token / 无 model → exit 1
// ============================================================================

describe("run() hermes cc-switch 缺字段 // exit 1", () => {
  it("provider 无 token → exit 1，零写零外部调用", async () => {
    const { deps, fs, hermesCalls } = makeDeps({
      files: { [P.config]: CONFIG_A, [P.env]: ENV_A, [P.cronJobs]: JOBS_JSON },
    });
    const r = await runHermesCli(["hermes", "tokenless"], deps);
    expect(r.exitCode).toBe(1);
    expect(fs.files.get(P.config)).toBe(CONFIG_A);
    expect(fs.files.get(P.env)).toBe(ENV_A);
    expect(fs.writes.length).toBe(0);
    expect(fs.copies.length).toBe(0);
    expect(hermesCalls.length).toBe(0);
  });

  it("provider 无 model（且无 registry override、无 --model）→ exit 1，零写", async () => {
    const { deps, fs, hermesCalls } = makeDeps({
      files: { [P.config]: CONFIG_A, [P.env]: ENV_A, [P.cronJobs]: JOBS_JSON },
    });
    const r = await runHermesCli(["hermes", "modelless"], deps);
    expect(r.exitCode).toBe(1);
    expect(fs.files.get(P.config)).toBe(CONFIG_A);
    expect(fs.writes.length).toBe(0);
    expect(hermesCalls.length).toBe(0);
  });
});

// ============================================================================
// 场景 9：未知 provider 报错且不写盘
// ============================================================================

describe("run() hermes 未知 provider // 场景9", () => {
  it("场景9.P1+P2: exit != 0，stderr 含不存在语义，文件字节级不变且零写副作用", async () => {
    const { deps, fs, hermesCalls } = makeDeps({
      files: { [P.config]: CONFIG_A, [P.env]: ENV_A, [P.cronJobs]: JOBS_JSON },
    });
    const r = await runHermesCli(["hermes", "nope-not-a-provider"], deps);
    // CONTRACT_AMBIGUOUS(7): 1 vs 2 未钉死，只钉非零
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/not found|unknown|no such|未(知|找到)|不存在/i);
    expect(fs.files.get(P.config)).toBe(CONFIG_A);
    expect(fs.files.get(P.env)).toBe(ENV_A);
    expect(fs.writes.length).toBe(0);
    expect(fs.copies.length).toBe(0);
    expect(hermesCalls.length).toBe(0);
  });
});

// ============================================================================
// 场景 5：非 TTY 裸调用 exit 2 零交互
// ============================================================================

describe("run() hermes 非 TTY 裸调用 // 场景5", () => {
  it("场景5.P1+P2+P3: exit == 2，stderr 含用法关键词，picker 不触发，文件不变", async () => {
    const { deps, fs, hermesCalls } = makeDeps({
      files: { [P.config]: CONFIG_A, [P.env]: ENV_A, [P.cronJobs]: JOBS_JSON },
      isInteractive: false,
    });
    const r = await runHermesCli(["hermes"], deps);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/status|rollback|provider/);
    expect(deps.pickProvider).not.toHaveBeenCalled();
    expect(fs.files.get(P.config)).toBe(CONFIG_A);
    expect(fs.files.get(P.env)).toBe(ENV_A);
    expect(fs.writes.length).toBe(0);
    expect(hermesCalls.length).toBe(0);
  });
});

// ============================================================================
// 场景 6：TTY 裸调用弹 picker（det 层近似：picker 收到 ≥2 provider 条目）
// + picker select / skip
// ============================================================================

describe("run() hermes TTY picker // 场景6 + select/skip", () => {
  it("场景6.P1(det 近似): TTY 裸调用 → pickProvider 被调且条目含 ≥2 个 provider 名", async () => {
    const pickProvider = vi.fn(
      async (
        entries: { name: string }[],
        _i: number,
      ): Promise<{ kind: "select"; entry: { name: string } }> => {
        const entry = entries.find((e) => e.name === "Kimi For Coding");
        if (!entry) throw new Error("Kimi For Coding not in picker entries");
        return { kind: "select", entry };
      },
    );
    const { deps } = makeDeps({
      files: { [P.config]: CONFIG_A, [P.env]: ENV_A, [P.cronJobs]: JOBS_JSON },
      isInteractive: true,
      pickProvider,
    });
    const r = await runHermesCli(["hermes"], deps);
    expect(pickProvider).toHaveBeenCalledTimes(1);
    const entries = pickProvider.mock.calls[0][0] as { name: string }[];
    expect(entries.length).toBeGreaterThanOrEqual(2);
    const names = entries.map((e) => e.name);
    expect(names).toContain("Kimi For Coding");
    expect(names).toContain("glm flash lastest");
    expect(r.exitCode).toBe(0);
  });

  it("picker select Kimi → 等同 'hermes kimi' 全流程切换", async () => {
    const pickProvider = vi.fn(
      async (
        entries: { name: string }[],
        _i: number,
      ): Promise<{ kind: "select"; entry: { name: string } }> => {
        const entry = entries.find((e) => e.name === "Kimi For Coding");
        if (!entry) throw new Error("not in entries");
        return { kind: "select", entry };
      },
    );
    const { deps, fs, hermesCalls } = makeDeps({
      files: { [P.config]: CONFIG_A, [P.env]: ENV_A, [P.cronJobs]: JOBS_JSON },
      isInteractive: true,
      pickProvider,
    });
    const r = await runHermesCli(["hermes"], deps);
    expect(r.exitCode).toBe(0);
    const cfg = fs.files.get(P.config) as string;
    expect(modelSectionHas(cfg, "provider", "kimi-coding")).toBe(true);
    expect(gatewayCalls(hermesCalls, "stop").length).toBeGreaterThan(0);
  });

  it("picker skip → 零写零外部调用，不切换（CONTRACT_AMBIGUOUS(6): exit 假定为 0）", async () => {
    const { deps, fs, hermesCalls } = makeDeps({
      files: { [P.config]: CONFIG_A, [P.env]: ENV_A, [P.cronJobs]: JOBS_JSON },
      isInteractive: true,
      // 默认 pickProvider = {kind:"skip"}
    });
    const r = await runHermesCli(["hermes"], deps);
    expect(deps.pickProvider).toHaveBeenCalledTimes(1);
    expect(r.exitCode).toBe(0);
    expect(fs.files.get(P.config)).toBe(CONFIG_A);
    expect(fs.files.get(P.env)).toBe(ENV_A);
    expect(fs.writes.length).toBe(0);
    expect(fs.copies.length).toBe(0);
    expect(hermesCalls.length).toBe(0);
  });
});

// ============================================================================
// 场景 2 / 14：status
// ============================================================================

describe("run() hermes status // 场景2 + 场景14", () => {
  it("场景2.P1+P2+P3: exit 0，stdout 含当前 provider/model + 上次 from→to", async () => {
    const { deps, hermesCalls } = makeDeps({
      files: {
        [P.config]: CONFIG_B,
        [P.env]: ENV_WITH_KIMI,
        [P.cronJobs]: JOBS_ON_KIMI,
        [P.state]: stateFileGlmToKimi(null),
      },
    });
    const r = await runHermesCli(["hermes", "status"], deps);
    expect(r.exitCode).toBe(0);
    // 当前生效 provider/model
    expect(r.stdout).toContain("kimi-coding");
    expect(r.stdout).toContain("kimi-k3");
    // 上次切换 from→to 两端都出现
    expect(r.stdout).toContain("glm-flash");
    expect(r.stdout).toContain("kimi-coding");
    // status 是纯查询：无外部命令、无写
    expect(hermesCalls.length).toBe(0);
  });

  it("场景2 附加: status 显示当前 provider 的 key_env 名（.env key 存在性检查，只打印 key 名）", async () => {
    const { deps } = makeDeps({
      files: {
        [P.config]: CONFIG_A,
        [P.env]: ENV_A,
        [P.cronJobs]: JOBS_JSON,
      },
    });
    const r = await runHermesCli(["hermes", "status"], deps);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("BIGMODEL_API_KEY");
    // token 红线对 status 同样生效
    expect(r.stdout).not.toContain(TOKEN_GLM);
    expect(r.stderr).not.toContain(TOKEN_GLM);
  });

  it("场景14.P1: 无切换记录 → exit 0，stdout 含当前 provider 名", async () => {
    const { deps } = makeDeps({
      files: { [P.config]: CONFIG_A, [P.env]: ENV_A, [P.cronJobs]: JOBS_JSON },
      // 无 state 文件
    });
    const r = await runHermesCli(["hermes", "status"], deps);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("glm-flash");
    expect(r.stdout).toContain("glm-5.3-flash");
  });
});

// ============================================================================
// 场景 4：--dry-run 只看计划不落盘
// ============================================================================

describe("run() hermes --dry-run // 场景4", () => {
  it("场景4.P1+P2+P3: exit 0，stdout 含目标 provider，文件字节级不变，零外部命令", async () => {
    const { deps, fs, hermesCalls } = makeDeps({
      files: { [P.config]: CONFIG_A, [P.env]: ENV_A, [P.cronJobs]: JOBS_JSON },
    });
    const r = await runHermesCli(["hermes", "kimi", "--dry-run"], deps);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("kimi-coding");
    expect(fs.files.get(P.config)).toBe(CONFIG_A);
    expect(fs.files.get(P.env)).toBe(ENV_A);
    // 零写：无 writeTextFileAtomic / copyFile / state 文件
    expect(fs.writes.length).toBe(0);
    expect(fs.copies.length).toBe(0);
    expect(fs.files.has(P.state)).toBe(false);
    // 零写副作用外部命令（cron edit / gateway / 验证请求都不发）
    expect(hermesCalls.length).toBe(0);
  });
});

// ============================================================================
// 场景 7 / 8：验证失败自动回滚 / --keep-on-fail 抑制
// ============================================================================

describe("run() hermes 验证失败 // 场景7 + 场景8", () => {
  // ping 第一次失败（切换验证），之后成功（回滚验证可通过）
  function pingFailsOnce() {
    let n = 0;
    return (args: string[]): RunOutcome | undefined => {
      if (args[0] === "-z") {
        n += 1;
        if (n === 1) {
          return { exitCode: 1, stdout: "", stderr: "ping boom" };
        }
      }
      return undefined;
    };
  }

  it("场景7.P1+P2: ping 失败 → exit 1，最终 config 与切换前逐字节一致（回到 glm-flash）", async () => {
    const { deps, fs } = makeDeps({
      files: { [P.config]: CONFIG_A, [P.env]: ENV_A, [P.cronJobs]: JOBS_JSON },
      runHermesFail: pingFailsOnce(),
    });
    const r = await runHermesCli(["hermes", "kimi"], deps);
    expect(r.exitCode).toBe(1);
    expect(fs.files.get(P.config)).toBe(CONFIG_A);
    expect(fs.files.get(P.config)).toContain("glm-flash");
  });

  it("场景7.P3: 被重 pin 的 cron 任务最终回 pin 到 glm-flash（回放序列：末次 edit 目标 == A）", async () => {
    const { deps, hermesCalls } = makeDeps({
      files: { [P.config]: CONFIG_A, [P.env]: ENV_A, [P.cronJobs]: JOBS_JSON },
      runHermesFail: pingFailsOnce(),
    });
    const r = await runHermesCli(["hermes", "kimi"], deps);
    expect(r.exitCode).toBe(1);
    const edits = cronEdits(hermesCalls);
    // 切换 2 条（→kimi）+ 回滚回放 2 条（→glm）
    expect(edits.length).toBe(4);
    for (const jobId of ["job-a1", "job-a2"]) {
      const forJob = edits.filter((e) => editJobId(e) === jobId);
      expect(forJob.length).toBe(2);
      expect(editArg(forJob[0], "--provider")).toBe("kimi-coding");
      const last = forJob[forJob.length - 1];
      expect(editArg(last, "--provider")).toBe("glm-flash");
      expect(editArg(last, "--model")).toBe("glm-5.3-flash");
    }
  });

  it("场景7.P4: stderr 明确提示验证失败与已回滚", async () => {
    const { deps } = makeDeps({
      files: { [P.config]: CONFIG_A, [P.env]: ENV_A, [P.cronJobs]: JOBS_JSON },
      runHermesFail: pingFailsOnce(),
    });
    const r = await runHermesCli(["hermes", "kimi"], deps);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/fail/i);
    expect(r.stderr).toMatch(/rollback|rolled back|回滚/i);
  });

  it("场景7 附加: 回滚把新增的 .env key 行删掉（prevValue=null → 删行）", async () => {
    const { deps, fs } = makeDeps({
      files: { [P.config]: CONFIG_A, [P.env]: ENV_A, [P.cronJobs]: JOBS_JSON },
      runHermesFail: pingFailsOnce(),
    });
    const r = await runHermesCli(["hermes", "kimi"], deps);
    expect(r.exitCode).toBe(1);
    const env = fs.files.get(P.env) as string;
    expect(env).not.toMatch(/^KIMI_CODING_API_KEY=/m);
    expect(env).toMatch(/^BIGMODEL_API_KEY=/m);
  });

  it("场景8.P1+P2: --keep-on-fail → exit 1，config 保留 kimi-coding，无回滚 copyFile 恢复", async () => {
    const { deps, fs, hermesCalls } = makeDeps({
      files: { [P.config]: CONFIG_A, [P.env]: ENV_A, [P.cronJobs]: JOBS_JSON },
      // ping 永远失败；若误触发回滚，回滚验证也会失败——config 仍须保留 B
      runHermesFail: (args) =>
        args[0] === "-z"
          ? { exitCode: 1, stdout: "", stderr: "ping boom" }
          : undefined,
    });
    const r = await runHermesCli(["hermes", "kimi", "--keep-on-fail"], deps);
    expect(r.exitCode).toBe(1);
    const cfg = fs.files.get(P.config) as string;
    expect(modelSectionHas(cfg, "provider", "kimi-coding")).toBe(true);
    // 无回滚：不存在 dst == config 的 copyFile 恢复动作
    expect(fs.copies.filter((c) => c.dst === P.config).length).toBe(0);
    // 无回滚回放：cron edit 只发生切换方向的 2 条
    const edits = cronEdits(hermesCalls);
    expect(edits.length).toBe(2);
    for (const e of edits) {
      expect(editArg(e, "--provider")).toBe("kimi-coding");
    }
  });

  it("gateway start 失败 → 自动回滚（exit 1，config 恢复 A，恢复动作发生在失败的 start 之后）", async () => {
    const { deps, fs, hermesCalls } = makeDeps({
      files: { [P.config]: CONFIG_A, [P.env]: ENV_A, [P.cronJobs]: JOBS_JSON },
      runHermesFail: (args) =>
        args[0] === "gateway" && args[1] === "start"
          ? { exitCode: 1, stdout: "", stderr: "gateway boom" }
          : undefined,
    });
    const r = await runHermesCli(["hermes", "kimi"], deps);
    expect(r.exitCode).toBe(1);
    expect(fs.files.get(P.config)).toBe(CONFIG_A);
    // 回滚恢复动作（copyFile 整文件恢复 config）在第一个失败的 gateway start 之后
    const failStartIdx = hermesCalls.findIndex(
      (c) => c.args[0] === "gateway" && c.args[1] === "start",
    );
    expect(failStartIdx).toBeGreaterThanOrEqual(0);
    const restoreIdx = fs.seq.findIndex(
      (s) => s.startsWith(`copy:`) && s.endsWith(`->${P.config}`),
    );
    expect(restoreIdx).toBeGreaterThanOrEqual(0);
    const failStartSeqIdx = fs.seq.indexOf("hermes:gateway start");
    expect(restoreIdx).toBeGreaterThan(failStartSeqIdx);
  });
});

// ============================================================================
// cron 单条失败 warn 继续（不触发回滚）
// ============================================================================

describe("run() hermes cron 单条失败 // warn 继续", () => {
  it("job-a2 cron edit 失败 → 仍 exit 0，stderr 含 warn 与失败 job id，config 切换生效，state 写入", async () => {
    const { deps, fs, hermesCalls } = makeDeps({
      files: { [P.config]: CONFIG_A, [P.env]: ENV_A, [P.cronJobs]: JOBS_JSON },
      runHermesFail: (args) =>
        args[0] === "cron" && args[1] === "edit" && args[2] === "job-a2"
          ? { exitCode: 1, stdout: "", stderr: "cron boom" }
          : undefined,
    });
    const r = await runHermesCli(["hermes", "kimi"], deps);
    expect(r.exitCode).toBe(0);
    // 两条都尝试了（失败不短路）
    const edits = cronEdits(hermesCalls);
    expect(edits.length).toBe(2);
    // warn 可见且能定位到失败任务
    expect(r.stderr).toMatch(/warn/i);
    expect(r.stderr).toContain("job-a2");
    // 不触发回滚：config 已是 kimi
    const cfg = fs.files.get(P.config) as string;
    expect(modelSectionHas(cfg, "provider", "kimi-coding")).toBe(true);
    expect(fs.copies.filter((c) => c.dst === P.config).length).toBe(0);
    // state 照常写入
    expect(fs.files.has(P.state)).toBe(true);
  });
});

// ============================================================================
// 场景 12：cron 重 pin 选择性
// ============================================================================

describe("run() hermes cron 选择性重 pin // 场景12", () => {
  it("场景12.P1+P2: 仅 pin 在旧 provider 且 enabled 的任务被 edit（job-a1/a2），C/未 pin/disabled 不动", async () => {
    const { deps, hermesCalls } = makeDeps({
      files: { [P.config]: CONFIG_A, [P.env]: ENV_A, [P.cronJobs]: JOBS_JSON },
    });
    const r = await runHermesCli(["hermes", "kimi"], deps);
    expect(r.exitCode).toBe(0);
    const ids = cronEdits(hermesCalls).map(editJobId);
    expect(new Set(ids)).toEqual(new Set(["job-a1", "job-a2"]));
    expect(ids).not.toContain("job-c1");
    expect(ids).not.toContain("job-nopin");
    expect(ids).not.toContain("job-off");
  });
});

// ============================================================================
// 场景 3 / 13：rollback
// ============================================================================

describe("run() hermes rollback // 场景3 + 场景13", () => {
  function rollbackDeps(prevValue: string | null = null) {
    return makeDeps({
      files: {
        [P.config]: CONFIG_B,
        [P.env]: ENV_WITH_KIMI,
        [P.cronJobs]: JOBS_ON_KIMI,
        [P.state]: stateFileGlmToKimi(prevValue),
        [BACKUP_PATH]: CONFIG_A,
      },
    });
  }

  it("场景3.P1+P2: exit 0，config 恢复为 A（逐字节 == 备份快照，含 glm-flash/glm-5.3-flash）", async () => {
    const { deps, fs } = rollbackDeps();
    const r = await runHermesCli(["hermes", "rollback"], deps);
    expect(r.exitCode).toBe(0);
    expect(fs.files.get(P.config)).toBe(CONFIG_A);
    expect(fs.files.get(P.config)).toContain("glm-flash");
    expect(fs.files.get(P.config)).toContain("glm-5.3-flash");
    // 恢复走 copyFile 整文件恢复
    expect(
      fs.copies.some((c) => c.src === BACKUP_PATH && c.dst === P.config),
    ).toBe(true);
  });

  it("场景3.P3: cron 回放——job-a1/a2 各被 edit 回 glm-flash/glm-5.3-flash", async () => {
    const { deps, hermesCalls } = rollbackDeps();
    const r = await runHermesCli(["hermes", "rollback"], deps);
    expect(r.exitCode).toBe(0);
    const edits = cronEdits(hermesCalls);
    expect(edits.length).toBe(2);
    for (const e of edits) {
      expect(["job-a1", "job-a2"]).toContain(editJobId(e));
      expect(editArg(e, "--provider")).toBe("glm-flash");
      expect(editArg(e, "--model")).toBe("glm-5.3-flash");
    }
    // job-nopin 不被回放
    expect(edits.map(editJobId)).not.toContain("job-nopin");
  });

  it("场景3.P4: rollback 后 status 反映当前 A 且最近记录 B→A", async () => {
    const { deps } = rollbackDeps();
    const rb = await runHermesCli(["hermes", "rollback"], deps);
    expect(rb.exitCode).toBe(0);
    const st = await runHermesCli(["hermes", "status"], deps);
    expect(st.exitCode).toBe(0);
    expect(st.stdout).toContain("glm-flash");
    expect(st.stdout).toContain("kimi-coding");
  });

  it("场景3 附加: rollback 成功后 state from/to 互换写回（toggle 前提）", async () => {
    const { deps, fs } = rollbackDeps();
    const r = await runHermesCli(["hermes", "rollback"], deps);
    expect(r.exitCode).toBe(0);
    const st = JSON.parse(fs.files.get(P.state) as string) as {
      lastSwitch: {
        from: { id: string };
        to: { id: string };
      };
    };
    expect(st.lastSwitch.from.id).toBe("kimi-coding");
    expect(st.lastSwitch.to.id).toBe("glm-flash");
  });

  it("场景3 附加(toggle): 连续两次 rollback 回到 kimi-coding（CONTRACT_AMBIGUOUS(9)）", async () => {
    const { deps, fs } = rollbackDeps();
    const r1 = await runHermesCli(["hermes", "rollback"], deps);
    expect(r1.exitCode).toBe(0);
    expect(fs.files.get(P.config)).toBe(CONFIG_A);
    const r2 = await runHermesCli(["hermes", "rollback"], deps);
    expect(r2.exitCode).toBe(0);
    const cfg = fs.files.get(P.config) as string;
    expect(modelSectionHas(cfg, "provider", "kimi-coding")).toBe(true);
    expect(modelSectionHas(cfg, "default", "kimi-k3")).toBe(true);
  });

  it("场景3 附加: prevValue=null → rollback 删 KIMI key 行；prevValue 有值 → 回写旧值", async () => {
    // null → 删行
    const d1 = rollbackDeps(null);
    const r1 = await runHermesCli(["hermes", "rollback"], d1.deps);
    expect(r1.exitCode).toBe(0);
    expect(d1.fs.files.get(P.env)).not.toMatch(/^KIMI_CODING_API_KEY=/m);
    expect(d1.fs.files.get(P.env)).toMatch(/^BIGMODEL_API_KEY=/m);
    // 有值 → 回写
    const d2 = rollbackDeps("TEST-TOKEN-PREV-KIMI");
    const r2 = await runHermesCli(["hermes", "rollback"], d2.deps);
    expect(r2.exitCode).toBe(0);
    expect(d2.fs.files.get(P.env)).toMatch(
      /^KIMI_CODING_API_KEY=TEST-TOKEN-PREV-KIMI$/m,
    );
  });

  it("场景3 附加: rollback 也要 gateway 重启 + ping 验证", async () => {
    const { deps, hermesCalls } = rollbackDeps();
    const r = await runHermesCli(["hermes", "rollback"], deps);
    expect(r.exitCode).toBe(0);
    expect(gatewayCalls(hermesCalls, "stop").length).toBeGreaterThan(0);
    expect(gatewayCalls(hermesCalls, "start").length).toBeGreaterThan(0);
    expect(pingCalls(hermesCalls).length).toBe(1);
  });

  it("场景13.P1+P2: 无 state → exit 1，stderr 含无历史语义，文件不变零写副作用", async () => {
    const { deps, fs, hermesCalls } = makeDeps({
      files: { [P.config]: CONFIG_B, [P.env]: ENV_WITH_KIMI },
      // 无 state 文件
    });
    const r = await runHermesCli(["hermes", "rollback"], deps);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(
      /(no|missing|absent|without|nothing)[^\n]*(state|history|switch|rollback)/i,
    );
    expect(fs.files.get(P.config)).toBe(CONFIG_B);
    expect(fs.files.get(P.env)).toBe(ENV_WITH_KIMI);
    expect(fs.writes.length).toBe(0);
    expect(fs.copies.length).toBe(0);
    expect(hermesCalls.length).toBe(0);
  });

  it("场景13 附加: state 畸形 JSON → exit 1 不猜，零写", async () => {
    const { deps, fs, hermesCalls } = makeDeps({
      files: {
        [P.config]: CONFIG_B,
        [P.env]: ENV_WITH_KIMI,
        [P.state]: "{not-json",
      },
    });
    const r = await runHermesCli(["hermes", "rollback"], deps);
    expect(r.exitCode).toBe(1);
    expect(fs.files.get(P.config)).toBe(CONFIG_B);
    expect(fs.writes.length).toBe(0);
    expect(hermesCalls.length).toBe(0);
  });
});

// ============================================================================
// registry：seed 命中 / 推导写回 / id 冲突
// ============================================================================

describe("run() hermes registry // seed + 推导 + 冲突", () => {
  it("seed 命中 Kimi For Coding → kimi-coding/KIMI_CODING_API_KEY（非推导的 kimi-for-coding）", async () => {
    const { deps, fs } = makeDeps({
      files: { [P.config]: CONFIG_A, [P.env]: ENV_A, [P.cronJobs]: JOBS_JSON },
      // registry 缺失 → 纯 seed
    });
    const r = await runHermesCli(["hermes", "Kimi For Coding"], deps);
    expect(r.exitCode).toBe(0);
    const cfg = fs.files.get(P.config) as string;
    expect(modelSectionHas(cfg, "provider", "kimi-coding")).toBe(true);
    expect(modelSectionHas(cfg, "provider", "kimi-for-coding")).toBe(false);
    expect(fs.files.get(P.env)).toMatch(/^KIMI_CODING_API_KEY=/m);
    expect(fs.files.get(P.env)).not.toMatch(/^KIMI_FOR_CODING_API_KEY=/m);
  });

  it("seed 命中 glm flash lastest → glm-flash/BIGMODEL_API_KEY（非推导的 glm-flash-lastest）", async () => {
    const { deps, fs } = makeDeps({
      files: {
        [P.config]: CONFIG_B,
        [P.env]: ENV_WITH_KIMI,
        [P.cronJobs]: JOBS_ON_KIMI,
      },
    });
    const r = await runHermesCli(["hermes", "glm"], deps);
    expect(r.exitCode).toBe(0);
    const cfg = fs.files.get(P.config) as string;
    expect(modelSectionHas(cfg, "provider", "glm-flash")).toBe(true);
    expect(modelSectionHas(cfg, "provider", "glm-flash-lastest")).toBe(false);
    expect(fs.files.get(P.env)).toMatch(/^BIGMODEL_API_KEY=/m);
  });

  it("推导写回：DeepSeek Official（不在 registry）→ 推导 deepseek-official/DEEPSEEK_OFFICIAL_API_KEY 并写回 registry", async () => {
    const { deps, fs } = makeDeps({
      files: { [P.config]: CONFIG_A, [P.env]: ENV_A, [P.cronJobs]: JOBS_JSON },
    });
    const r = await runHermesCli(["hermes", "deepseek"], deps);
    expect(r.exitCode).toBe(0);
    const cfg = fs.files.get(P.config) as string;
    expect(modelSectionHas(cfg, "provider", "deepseek-official")).toBe(true);
    expect(modelSectionHas(cfg, "default", "deepseek-v4-flash")).toBe(true);
    expect(fs.files.get(P.env)).toMatch(/^DEEPSEEK_OFFICIAL_API_KEY=/m);
    // 推导结果写回 registry（防漂移）
    const regWrites = fs.writes.filter((w) => w.path === P.registry);
    expect(regWrites.length).toBeGreaterThan(0);
    const reg = JSON.parse(regWrites[regWrites.length - 1].text) as Record<
      string,
      { id: string; keyEnv: string }
    >;
    expect(reg["DeepSeek Official"]).toMatchObject({
      id: "deepseek-official",
      keyEnv: "DEEPSEEK_OFFICIAL_API_KEY",
    });
  });

  it("id 冲突：推导 id 与 config 已有条目冲突 → exit 1 零写（CONTRACT_AMBIGUOUS(8)）", async () => {
    const { deps, fs, hermesCalls } = makeDeps({
      files: {
        [P.config]: CONFIG_A_WITH_CONFLICT,
        [P.env]: ENV_A,
        [P.cronJobs]: JOBS_JSON,
      },
    });
    const r = await runHermesCli(["hermes", "deepseek"], deps);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/conflict|already|exist|冲突/i);
    expect(fs.files.get(P.config)).toBe(CONFIG_A_WITH_CONFLICT);
    expect(fs.files.get(P.env)).toBe(ENV_A);
    expect(fs.writes.length).toBe(0);
    expect(fs.copies.length).toBe(0);
    expect(hermesCalls.length).toBe(0);
  });

  it("registry 损坏 JSON → 视为空（best-effort），seed 仍可完成切换", async () => {
    const { deps, fs } = makeDeps({
      files: {
        [P.config]: CONFIG_A,
        [P.env]: ENV_A,
        [P.cronJobs]: JOBS_JSON,
        [P.registry]: "{broken",
      },
    });
    const r = await runHermesCli(["hermes", "kimi"], deps);
    expect(r.exitCode).toBe(0);
    const cfg = fs.files.get(P.config) as string;
    expect(modelSectionHas(cfg, "provider", "kimi-coding")).toBe(true);
  });
});

// ============================================================================
// 场景 10：config.yaml 结构不认识 → 报错不写盘（宁报错不猜）
// ============================================================================

describe("run() hermes 畸形 config // 场景10", () => {
  it("场景10.P1+P2: 缺 providers 段 → exit 1，stderr 拒绝语义，config 字节级不变", async () => {
    const { deps, fs, hermesCalls } = makeDeps({
      files: {
        [P.config]: CONFIG_NO_PROVIDERS,
        [P.env]: ENV_A,
        [P.cronJobs]: JOBS_JSON,
      },
    });
    const r = await runHermesCli(["hermes", "kimi"], deps);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(
      /parse|structure|unexpected|missing|refus|cannot|unable|invalid/i,
    );
    expect(fs.files.get(P.config)).toBe(CONFIG_NO_PROVIDERS);
    // 拒绝写盘：config 无写入
    expect(fs.writes.filter((w) => w.path === P.config).length).toBe(0);
    // 流程在写盘前中止：无 gateway/cron/ping
    expect(hermesCalls.length).toBe(0);
  });

  it("场景10 variant: model 段意外嵌套 → exit 1，config 字节级不变", async () => {
    const { deps, fs } = makeDeps({
      files: {
        [P.config]: CONFIG_NESTED_MODEL,
        [P.env]: ENV_A,
        [P.cronJobs]: JOBS_JSON,
      },
    });
    const r = await runHermesCli(["hermes", "kimi"], deps);
    expect(r.exitCode).toBe(1);
    expect(fs.files.get(P.config)).toBe(CONFIG_NESTED_MODEL);
    expect(fs.writes.filter((w) => w.path === P.config).length).toBe(0);
  });
});

// ============================================================================
// 场景 15：secret-hygiene 三路径（token 夹具值 TEST-TOKEN-DEADBEEF）
// ============================================================================

describe("run() hermes secret-hygiene // 场景15", () => {
  it("场景15.P1(成功路径): stdout+stderr 不含目标 token 值，也不含旧 token", async () => {
    const { deps } = makeDeps({
      files: { [P.config]: CONFIG_A, [P.env]: ENV_A, [P.cronJobs]: JOBS_JSON },
    });
    const r = await runHermesCli(["hermes", "kimi"], deps);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).not.toContain(TOKEN_KIMI);
    expect(r.stderr).not.toContain(TOKEN_KIMI);
    expect(r.stdout).not.toContain(TOKEN_GLM);
    expect(r.stderr).not.toContain(TOKEN_GLM);
  });

  it("场景15.P1(失败路径): ping 失败自动回滚全程 stdout+stderr 不含 token", async () => {
    let n = 0;
    const { deps } = makeDeps({
      files: { [P.config]: CONFIG_A, [P.env]: ENV_A, [P.cronJobs]: JOBS_JSON },
      runHermesFail: (args) => {
        if (args[0] === "-z") {
          n += 1;
          if (n === 1) return { exitCode: 1, stdout: "", stderr: "boom" };
        }
        return undefined;
      },
    });
    const r = await runHermesCli(["hermes", "kimi"], deps);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).not.toContain(TOKEN_KIMI);
    expect(r.stderr).not.toContain(TOKEN_KIMI);
    expect(r.stdout).not.toContain(TOKEN_GLM);
    expect(r.stderr).not.toContain(TOKEN_GLM);
  });

  it("场景15.P2(dry-run): stdout 不含 token 且 .env 计划行显示 KIMI_CODING_API_KEY=<redacted>", async () => {
    const { deps } = makeDeps({
      files: { [P.config]: CONFIG_A, [P.env]: ENV_A, [P.cronJobs]: JOBS_JSON },
    });
    const r = await runHermesCli(["hermes", "kimi", "--dry-run"], deps);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).not.toContain(TOKEN_KIMI);
    expect(r.stderr).not.toContain(TOKEN_KIMI);
    expect(r.stdout).toContain("<redacted>");
    expect(r.stdout).toContain("KIMI_CODING_API_KEY=<redacted>");
  });

  it("场景15 附加: 只打印 key 名是允许的（key 名非 secret）", async () => {
    const { deps } = makeDeps({
      files: { [P.config]: CONFIG_A, [P.env]: ENV_A, [P.cronJobs]: JOBS_JSON },
    });
    const r = await runHermesCli(["hermes", "kimi", "--dry-run"], deps);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("KIMI_CODING_API_KEY");
  });
});
