import { describe, expect, it, vi } from "vitest";
import {
  applyPickerKey,
  buildQuotaRequest,
  formatQuota,
  parseGlmQuota,
  parseKimiUsages,
  run,
} from "./cli.js";

// ============================================================================
// 红队验收测试 — provider picker v2 revise-2（DB 原序 + Emacs 键位）
//
// 产出方式备注：本轮子代理通道故障（连续 API 400），由编排器按
// 「先测试后实现」顺序内联产出——本文件编写时 revise-2 增量实现尚不存在，
// 全部断言源自状态文件冻结契约 C-P1..C-P10（revise-2 修订版）。
//
//   C-P8［revise-2］entries 顺序 = readCcSwitchProvider 返回的 providers
//        DB 原序（零排序，cc-switch UI 所见顺序）；initialIndex 按此序计算。
//   C-P1/P2［revise-2］applyPickerKey(k:{name?,ctrl?,meta?}, index, count)
//        四态 {move,confirm,skip,noop}；ctrl+n≡down、ctrl+p≡up（环形 wrap）、
//        ctrl+g≡escape→skip、meta+"<"→首项、meta+">"→末项（绝对）；
//        ctrl+c 不经此函数（调用方拦截 exit 130）；其余 noop。
//   C-P3 顺序契约 readCcSwitchProvider < pickProvider < writeLastProvider < spawn。
//   C-P4 记忆时机：仅 TTY claude 无 --provider 读（精确匹配失配静默 0）；
//        仅 picker 确认选中后写；Esc/C-g/不切换/显式 --provider/静默复用不写；
//        非 TTY 四接缝全 0。
//   C-P5 print 静默复用：stderr 恰一行 `gcli: provider=<name>（--pick 重选）`。
//   C-P6 --pick 三文案逐字（互斥/非TTY/agy），exit 2 零 spawn 零菜单。
//   C-P9 非 TTY 铁律 + runClaude 收无 --settings args（与无该特性一致）。
//   C-P10 回归：--yolo/--sandbox 拒；ANTHROPIC_MODEL 显式 pin；降级软警告；
//        HELP 含 --pick 与 C-n、不含旧文案「输入编号」。
//   D4 DI：pickProvider(entries:{name,quota?}[], initialIndex) →
//        {kind:"select",entry}|{kind:"skip"}［revise-3：host → quota 副标题］。
//   C-Q1..C-Q6［revise-3］quota 契约：buildQuotaRequest 三态（kimi Bearer /
//        glm 裸 token / 其余 null）；解析器容错不 throw；格式 5h:P% wk:P% ↻rel；
//        fetchProviderQuotas 触发闭集（仅 TTY 弹菜单路径 1 次，入参=全部
//        {name,env}；静默复用/显式 --provider/非 TTY/降级 0 次）；quota 以
//        name 为键透传进 entries。缓存属生产实现内部（run() 层不可观测）。
//
// CONTRACT_AMBIGUOUS 汇总：
//   1. （上次）标注传递方式未钉死 → entries 严格断言 {name,host}，
//      不断言 host 含（上次）；initialIndex 用 name 定位。
//   2. 降级路径（lookup !ok/空列表）是否读记忆未钉死 → 按"降级时不读记忆"
//      断言 read/write 0 次（沿用 v2 轮裁决）。
//   3. 空列表时是否调 pickProvider([]) 未钉死 → 按"警告+继续"断言不调。
//   4. ctrl-c 恢复 raw-mode 后 exit 130 与渲染细节在生产实现内部，run()
//      层经 fake 接缝不可观测，本文件不断言。
// ============================================================================

// ----------------------------------------------------------------------------
// fixtures：settingsConfig 为 JSON 字符串（sqlite TEXT 列原样）。
// 刻意乱序 Zeta → Kimi → GLM＝DB 原序。revise-2 前 v2 轮按字母序排序，
// 本轮契约改为保持 DB 原序——entries 断言必须能区分「原序」与「字母序」。
// ----------------------------------------------------------------------------

const ZETA_RAW = {
  name: "Zeta Corp",
  settingsConfig: JSON.stringify({
    env: {
      // 非 kimi/glm 域 → buildQuotaRequest null（无 quota API，副标题留空）
      ANTHROPIC_BASE_URL: "https://api.zeta.dev/v1",
      ANTHROPIC_AUTH_TOKEN: "zeta-token",
      ANTHROPIC_MODEL: "zeta-1",
    },
  }),
};

const K3_RAW = {
  name: "Kimi For Coding",
  settingsConfig: JSON.stringify({
    env: {
      // kimi.com 域 → kimi kind
      ANTHROPIC_BASE_URL: "https://api.kimi.com/coding/",
      ANTHROPIC_AUTH_TOKEN: "kimi-token",
      // 无 ANTHROPIC_MODEL：断言注入 env 仍显式 pin 该 key（buildSettingsEnv）
      ANTHROPIC_DEFAULT_SONNET_MODEL: "kimi-k3[1M]",
    },
  }),
};

const GLM_RAW = {
  name: "GLM",
  settingsConfig: JSON.stringify({
    env: {
      // bigmodel 域 → glm kind
      ANTHROPIC_BASE_URL: "https://open.bigmodel.cn/api/anthropic",
      ANTHROPIC_AUTH_TOKEN: "glm-token",
      ANTHROPIC_MODEL: "glm-5.2",
    },
  }),
};

// DB 原序（revise-2 契约：菜单顺序 === 此数组顺序，非字母序）
const DB_PROVIDERS = [ZETA_RAW, K3_RAW, GLM_RAW];
const DB_ORDER_NAMES = ["Zeta Corp", "Kimi For Coding", "GLM"];

type PickerEntryLike = { name: string; quota?: string };
type QuotaItemLike = { name: string; env: Record<string, string> };
type PickerOutcomeLike =
  | { kind: "select"; entry: PickerEntryLike }
  | { kind: "skip" };

type SpawnResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  signal?: string | null;
  timedOut?: boolean;
};

function okClaude() {
  return vi.fn(
    async (): Promise<SpawnResult> => ({
      stdout: "claude-ok",
      stderr: "",
      exitCode: 0,
    }),
  );
}

// 反重言 fake：picker 只从实现自己传入的 entries 里 echo 选择——若实现注入了
// 非选中项的 provider（如恒选首位），测试必红。
function pickerSelectByName(name: string) {
  return vi.fn(
    async (entries: PickerEntryLike[]): Promise<PickerOutcomeLike> => {
      const entry = entries.find((e) => e.name === name);
      if (!entry) {
        throw new Error(
          `fake picker: "${name}" not in [${entries.map((e) => e.name).join(", ")}]`,
        );
      }
      return { kind: "select", entry };
    },
  );
}

function makeDeps(
  overrides: Partial<{
    readCcSwitchProvider: ReturnType<typeof vi.fn>;
    pickProvider: ReturnType<typeof vi.fn>;
    fetchProviderQuotas: ReturnType<typeof vi.fn>;
    readLastProvider: ReturnType<typeof vi.fn>;
    writeLastProvider: ReturnType<typeof vi.fn>;
    runClaude: ReturnType<typeof vi.fn>;
    runAgy: ReturnType<typeof vi.fn>;
    runApi: ReturnType<typeof vi.fn>;
    readStdin: ReturnType<typeof vi.fn>;
    runClaudeInteractive: ReturnType<typeof vi.fn>;
    runAgyInteractive: ReturnType<typeof vi.fn>;
    isInteractive: ReturnType<typeof vi.fn>;
  }> = {},
) {
  return {
    readCcSwitchProvider:
      overrides.readCcSwitchProvider ??
      vi.fn(async () => ({ ok: true as const, providers: DB_PROVIDERS })),
    // D4 基线：默认 skip（Esc / 选"不切换"在接缝层同为 {kind:"skip"}）
    pickProvider:
      overrides.pickProvider ??
      vi.fn(
        async (
          _entries: PickerEntryLike[],
          _i: number,
        ): Promise<PickerOutcomeLike> => ({
          kind: "skip",
        }),
      ),
    // C-Q4 基线：默认只给 Kimi 一条 quota（透传断言用）
    fetchProviderQuotas:
      overrides.fetchProviderQuotas ??
      vi.fn(
        async (_items: QuotaItemLike[]): Promise<Map<string, string>> =>
          new Map([["Kimi For Coding", "5h:42% wk:17% ↻2h13m"]]),
      ),
    readLastProvider:
      overrides.readLastProvider ?? vi.fn(async () => undefined),
    writeLastProvider: overrides.writeLastProvider ?? vi.fn(async () => {}),
    runClaude: overrides.runClaude ?? okClaude(),
    runAgy:
      overrides.runAgy ??
      vi.fn(
        async (): Promise<SpawnResult> => ({
          stdout: "agy-ok",
          stderr: "",
          exitCode: 0,
        }),
      ),
    runApi:
      overrides.runApi ??
      vi.fn(async () => ({ exitCode: 0, stdout: "api-ok", stderr: "" })),
    readStdin: overrides.readStdin ?? vi.fn(async () => "default-stdin"),
    runClaudeInteractive:
      overrides.runClaudeInteractive ?? vi.fn(async () => ({ exitCode: 0 })),
    runAgyInteractive: vi.fn(async () => ({ exitCode: 0 })),
    // 本文件主战场是 TTY；非 TTY 用例显式覆盖 false
    isInteractive: overrides.isInteractive ?? vi.fn(() => true),
  };
}

function settingsJsonOf(args: string[]): { env: Record<string, string> } {
  const idx = args.indexOf("--settings");
  expect(idx).toBeGreaterThan(-1);
  return JSON.parse(args[idx + 1]) as { env: Record<string, string> };
}

// ----------------------------------------------------------------------------
// 验收点 1 — applyPickerKey 纯函数（C-P1 键位 / C-P2 四态）
// ----------------------------------------------------------------------------

describe("applyPickerKey // C-P2 四态 + C-P1 wrap + Emacs 键位", () => {
  // toEqual 严格形状：返回闭集为四态 union，多余字段视为偏离。

  it("'down' 普通下移：1→2（count=3）", () => {
    expect(applyPickerKey({ name: "down" }, 1, 3)).toEqual({
      type: "move",
      index: 2,
    });
  });

  it("'down' 环形 wrap：count-1→0（末项下移绕回首项）", () => {
    expect(applyPickerKey({ name: "down" }, 2, 3)).toEqual({
      type: "move",
      index: 0,
    });
  });

  it("'up' 普通上移：1→0", () => {
    expect(applyPickerKey({ name: "up" }, 1, 3)).toEqual({
      type: "move",
      index: 0,
    });
  });

  it("'up' 末项中段上移：2→1（wrap 仅在首项触发）", () => {
    expect(applyPickerKey({ name: "up" }, 2, 3)).toEqual({
      type: "move",
      index: 1,
    });
  });

  it("'up' 环形 wrap：0→count-1（首项上移绕到末项）", () => {
    expect(applyPickerKey({ name: "up" }, 0, 3)).toEqual({
      type: "move",
      index: 2,
    });
  });

  it("'j' ≡ down（含 wrap）", () => {
    expect(applyPickerKey({ name: "j" }, 1, 3)).toEqual({
      type: "move",
      index: 2,
    });
    expect(applyPickerKey({ name: "j" }, 2, 3)).toEqual({
      type: "move",
      index: 0,
    });
  });

  it("'k' ≡ up（含 wrap）", () => {
    expect(applyPickerKey({ name: "k" }, 1, 3)).toEqual({
      type: "move",
      index: 0,
    });
    expect(applyPickerKey({ name: "k" }, 0, 3)).toEqual({
      type: "move",
      index: 2,
    });
  });

  it("ctrl+n ≡ down（含 wrap）［revise-2 Emacs］", () => {
    expect(applyPickerKey({ name: "n", ctrl: true }, 0, 3)).toEqual({
      type: "move",
      index: 1,
    });
    expect(applyPickerKey({ name: "n", ctrl: true }, 2, 3)).toEqual({
      type: "move",
      index: 0,
    });
  });

  it("ctrl+p ≡ up（含 wrap）［revise-2 Emacs］", () => {
    expect(applyPickerKey({ name: "p", ctrl: true }, 1, 3)).toEqual({
      type: "move",
      index: 0,
    });
    expect(applyPickerKey({ name: "p", ctrl: true }, 0, 3)).toEqual({
      type: "move",
      index: 2,
    });
  });

  it("ctrl+g → skip（≡ escape）［revise-2 Emacs］", () => {
    expect(applyPickerKey({ name: "g", ctrl: true }, 1, 3)).toEqual({
      type: "skip",
    });
  });

  it("meta+'<' → 首项 index 0（绝对，不 wrap）［revise-2］", () => {
    expect(applyPickerKey({ name: "<", meta: true }, 2, 3)).toEqual({
      type: "move",
      index: 0,
    });
  });

  it("meta+'>' → 末项 index count-1（绝对）［revise-2］", () => {
    expect(applyPickerKey({ name: ">", meta: true }, 0, 3)).toEqual({
      type: "move",
      index: 2,
    });
  });

  it("meta+'>' count=1 → index 0", () => {
    expect(applyPickerKey({ name: ">", meta: true }, 0, 1)).toEqual({
      type: "move",
      index: 0,
    });
  });

  it("count=0：任何移动键 → noop（无可渲染行）", () => {
    expect(applyPickerKey({ name: ">", meta: true }, 0, 0)).toEqual({
      type: "noop",
    });
    expect(applyPickerKey({ name: "n", ctrl: true }, 0, 0)).toEqual({
      type: "noop",
    });
    expect(applyPickerKey({ name: "<", meta: true }, 0, 0)).toEqual({
      type: "noop",
    });
  });

  it("'return' 与 'enter' → confirm（与 index 无关）", () => {
    expect(applyPickerKey({ name: "return" }, 0, 3)).toEqual({
      type: "confirm",
    });
    expect(applyPickerKey({ name: "enter" }, 2, 3)).toEqual({
      type: "confirm",
    });
  });

  it("'escape' → skip", () => {
    expect(applyPickerKey({ name: "escape" }, 1, 3)).toEqual({
      type: "skip",
    });
  });

  it("水平/分页 Emacs 键与裸 n/p → noop［revise-2 明确不映射］", () => {
    for (const name of ["f", "b", "a", "e", "v"]) {
      expect(applyPickerKey({ name, ctrl: true }, 1, 3)).toEqual({
        type: "noop",
      });
    }
    expect(applyPickerKey({ name: "v", meta: true }, 1, 3)).toEqual({
      type: "noop",
    });
    expect(applyPickerKey({ name: "n" }, 1, 3)).toEqual({ type: "noop" });
    expect(applyPickerKey({ name: "p" }, 1, 3)).toEqual({ type: "noop" });
  });

  it("无名键（{name:undefined}）→ noop", () => {
    expect(applyPickerKey({}, 1, 3)).toEqual({ type: "noop" });
  });

  it("count=1 退化：down/up 均留在 index 0", () => {
    expect(applyPickerKey({ name: "down" }, 0, 1)).toEqual({
      type: "move",
      index: 0,
    });
    expect(applyPickerKey({ name: "up" }, 0, 1)).toEqual({
      type: "move",
      index: 0,
    });
  });
});

// ----------------------------------------------------------------------------
// 验收点 2 — 顺序（C-P8 revise-2 核心：DB 原序，零排序）
// ----------------------------------------------------------------------------

describe("entries 顺序 // C-P8 DB 原序（revise-2 核心）", () => {
  it("entries 顺序 === lookup.providers 原序（Zeta,Kimi,GLM——非字母序）", async () => {
    const deps = makeDeps({ pickProvider: pickerSelectByName("GLM") });
    await run(["-p", "hi"], deps);
    expect(deps.pickProvider).toHaveBeenCalledTimes(1);
    const entries = deps.pickProvider.mock.calls[0][0] as PickerEntryLike[];
    expect(entries.map((e) => e.name)).toEqual(DB_ORDER_NAMES);
  });

  it("quota 以 name 为键透传：Kimi 项 quota=fake 文本，无数据项无 quota 字段（C-Q6）", async () => {
    const deps = makeDeps({ pickProvider: pickerSelectByName("GLM") });
    await run(["-p", "hi"], deps);
    const entries = deps.pickProvider.mock.calls[0][0] as PickerEntryLike[];
    // CONTRACT_AMBIGUOUS：（上次）标注拼在 quota 尾，不单独断言其拼接细节
    expect(entries[0]).toEqual({ name: "Zeta Corp" });
    expect(entries[1]).toEqual({
      name: "Kimi For Coding",
      quota: "5h:42% wk:17% ↻2h13m",
    });
    expect(entries[2]).toEqual({ name: "GLM" });
  });

  it("initialIndex：记忆命中 GLM（DB 原序 index 2）→ 第二参 = 2", async () => {
    const deps = makeDeps({
      readLastProvider: vi.fn(async () => "GLM"),
      pickProvider: pickerSelectByName("GLM"),
    });
    // TUI 模式：print+记忆有效会走静默复用不弹菜单，测 initialIndex 须用总弹菜单路径
    await run([], deps);
    expect(deps.pickProvider.mock.calls[0][1]).toBe(2);
  });

  it("initialIndex：无记忆 → 0；记忆失配 → 0（静默）", async () => {
    const none = makeDeps({ pickProvider: pickerSelectByName("GLM") });
    await run(["-p", "hi"], none);
    expect(none.pickProvider.mock.calls[0][1]).toBe(0);

    const stale = makeDeps({
      readLastProvider: vi.fn(async () => "Gone Away"),
      pickProvider: pickerSelectByName("GLM"),
    });
    await run(["-p", "hi"], stale);
    expect(stale.pickProvider.mock.calls[0][1]).toBe(0);
    // 静默忽略：无警告、无报错（stderr 只有 spawn 侧输出或空）
    expect(stale.readLastProvider).toHaveBeenCalledTimes(1);
  });
});

// ----------------------------------------------------------------------------
// 验收点 3 — D3 触发矩阵
// ----------------------------------------------------------------------------

describe("D3 触发矩阵 // TUI 总弹 / print 静默 / --pick 强制", () => {
  it("TUI（无 -p，TTY）：记忆有效仍总弹菜单（恰 1 次），quota fetch 恰 1 次（C-Q4）", async () => {
    const deps = makeDeps({
      readLastProvider: vi.fn(async () => "GLM"),
      pickProvider: pickerSelectByName("GLM"),
    });
    await run([], deps);
    expect(deps.pickProvider).toHaveBeenCalledTimes(1);
    expect(deps.fetchProviderQuotas).toHaveBeenCalledTimes(1);
    expect(deps.runClaudeInteractive).toHaveBeenCalledTimes(1);
  });

  it("print+记忆有效+无 --pick：不弹菜单，静默注入+提示行逐字，quota fetch 0 次（C-Q4）", async () => {
    const deps = makeDeps({
      readLastProvider: vi.fn(async () => "Kimi For Coding"),
      pickProvider: pickerSelectByName("Kimi For Coding"),
    });
    const r = await run(["-p", "hi"], deps);
    expect(deps.pickProvider).toHaveBeenCalledTimes(0);
    expect(deps.fetchProviderQuotas).toHaveBeenCalledTimes(0);
    expect(r.stderr.trim()).toBe(
      "gcli: provider=Kimi For Coding（--pick 重选）",
    );
    expect(r.stderr).not.toContain("选择 cc-switch provider");
    const args = deps.runClaude.mock.calls[0][0] as string[];
    const env = settingsJsonOf(args).env;
    expect(env.ANTHROPIC_BASE_URL).toBe("https://api.kimi.com/coding/");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("kimi-token");
    expect(Object.hasOwn(env, "ANTHROPIC_MODEL")).toBe(true);
  });

  it("print+记忆有效：记忆不重写（writeLastProvider 0 次）", async () => {
    const deps = makeDeps({
      readLastProvider: vi.fn(async () => "Kimi For Coding"),
    });
    await run(["-p", "hi"], deps);
    expect(deps.writeLastProvider).toHaveBeenCalledTimes(0);
  });

  it("print+记忆无效/无记忆 → 弹菜单（1 次）", async () => {
    const noMem = makeDeps({ pickProvider: pickerSelectByName("GLM") });
    await run(["-p", "hi"], noMem);
    expect(noMem.pickProvider).toHaveBeenCalledTimes(1);

    const stale = makeDeps({
      readLastProvider: vi.fn(async () => "Not In DB"),
      pickProvider: pickerSelectByName("GLM"),
    });
    await run(["-p", "hi"], stale);
    expect(stale.pickProvider).toHaveBeenCalledTimes(1);
  });

  it("print+--pick+记忆有效 → 强制弹菜单，且无'重选'提示行，quota fetch 1 次", async () => {
    const deps = makeDeps({
      readLastProvider: vi.fn(async () => "Kimi For Coding"),
      pickProvider: pickerSelectByName("GLM"),
    });
    const r = await run(["--pick", "-p", "hi"], deps);
    expect(deps.pickProvider).toHaveBeenCalledTimes(1);
    expect(deps.fetchProviderQuotas).toHaveBeenCalledTimes(1);
    expect(r.stderr).not.toContain("--pick 重选");
  });

  it("菜单路径 stdout 纯净（picker 输出全走 stderr）", async () => {
    const deps = makeDeps({ pickProvider: pickerSelectByName("GLM") });
    const r = await run(["-p", "hi"], deps);
    expect(r.stdout).toBe("claude-ok");
    expect(r.stdout).not.toContain("provider");
  });
});

// ----------------------------------------------------------------------------
// 验收点 4 — 写记忆时机（C-P4）
// ----------------------------------------------------------------------------

describe("写记忆时机 // C-P4", () => {
  it("TUI 确认选中 → writeLastProvider 恰 1 次且入参 = entry.name", async () => {
    const deps = makeDeps({
      pickProvider: pickerSelectByName("Kimi For Coding"),
    });
    await run([], deps);
    expect(deps.writeLastProvider).toHaveBeenCalledTimes(1);
    expect(deps.writeLastProvider).toHaveBeenCalledWith("Kimi For Coding");
  });

  it("print 菜单确认同样写记忆（D2'确认后写'与模式无关）", async () => {
    const deps = makeDeps({ pickProvider: pickerSelectByName("Zeta Corp") });
    await run(["-p", "hi"], deps);
    expect(deps.writeLastProvider).toHaveBeenCalledWith("Zeta Corp");
  });

  it("skip（Esc/C-g/不切换）→ 0 次", async () => {
    const deps = makeDeps(); // 默认 fake 返回 {kind:"skip"}
    await run([], deps);
    expect(deps.writeLastProvider).toHaveBeenCalledTimes(0);
  });

  it("显式 --provider → read/write/pick/fetch 四接缝 0 次，原链路注入不回归", async () => {
    const deps = makeDeps();
    const r = await run(["-p", "hi", "--provider", "glm"], deps);
    expect(deps.pickProvider).toHaveBeenCalledTimes(0);
    expect(deps.readLastProvider).toHaveBeenCalledTimes(0);
    expect(deps.writeLastProvider).toHaveBeenCalledTimes(0);
    expect(deps.fetchProviderQuotas).toHaveBeenCalledTimes(0);
    expect(r.exitCode).toBe(0);
    const args = deps.runClaude.mock.calls[0][0] as string[];
    const env = settingsJsonOf(args).env;
    expect(env.ANTHROPIC_BASE_URL).toBe(
      "https://open.bigmodel.cn/api/anthropic",
    );
  });

  it("--model 与 picker 选中组合：ANTHROPIC_MODEL 被 --model 覆盖，其余 env 仍来自选中项", async () => {
    const deps = makeDeps({
      pickProvider: pickerSelectByName("Kimi For Coding"),
    });
    await run(["-p", "hi", "--model", "override-x"], deps);
    const args = deps.runClaude.mock.calls[0][0] as string[];
    const env = settingsJsonOf(args).env;
    expect(env.ANTHROPIC_MODEL).toBe("override-x");
    expect(env.ANTHROPIC_BASE_URL).toBe("https://api.kimi.com/coding/");
  });
});

// ----------------------------------------------------------------------------
// 验收点 5 — --pick 校验三条文案（C-P6）
// ----------------------------------------------------------------------------

describe("--pick 校验 // C-P6 三文案逐字", () => {
  it("--pick 与 --provider 同给 → exit 2 逐字文案，零 spawn 零菜单", async () => {
    const deps = makeDeps();
    const r = await run(["--pick", "--provider", "glm", "-p", "hi"], deps);
    expect(r.exitCode).toBe(2);
    expect(r.stderr.trim()).toBe(
      "gcli: --pick cannot be combined with --provider",
    );
    expect(deps.runClaude).toHaveBeenCalledTimes(0);
    expect(deps.pickProvider).toHaveBeenCalledTimes(0);
  });

  it("非 TTY + --pick → exit 2 逐字文案，五接缝全 0", async () => {
    const deps = makeDeps({ isInteractive: vi.fn(() => false) });
    const r = await run(["--pick", "-p", "hi"], deps);
    expect(r.exitCode).toBe(2);
    expect(r.stderr.trim()).toBe("gcli: --pick requires a TTY");
    expect(deps.pickProvider).toHaveBeenCalledTimes(0);
    expect(deps.readCcSwitchProvider).toHaveBeenCalledTimes(0);
    expect(deps.readLastProvider).toHaveBeenCalledTimes(0);
    expect(deps.writeLastProvider).toHaveBeenCalledTimes(0);
    expect(deps.fetchProviderQuotas).toHaveBeenCalledTimes(0);
  });

  it("agy 路径 --pick → exit 2 逐字文案，走 runAgy 拒绝分支", async () => {
    const deps = makeDeps();
    const r = await run(["agy", "--pick", "-p", "hi"], deps);
    expect(r.exitCode).toBe(2);
    expect(r.stderr.trim()).toBe("gcli: agy backend does not support --pick");
    expect(deps.runAgy).toHaveBeenCalledTimes(0);
  });
});

// ----------------------------------------------------------------------------
// 验收点 6 — 非 TTY 铁律（C-P9）
// ----------------------------------------------------------------------------

describe("非 TTY 铁律 // C-P9 四接缝零调用 + 行为与无该特性一致", () => {
  it("print 非 TTY（无 --provider）→ 五接缝 0 次，runClaude 无 --settings", async () => {
    const deps = makeDeps({ isInteractive: vi.fn(() => false) });
    const r = await run(["-p", "hi"], deps);
    expect(r.exitCode).toBe(0);
    expect(deps.readCcSwitchProvider).toHaveBeenCalledTimes(0);
    expect(deps.readLastProvider).toHaveBeenCalledTimes(0);
    expect(deps.writeLastProvider).toHaveBeenCalledTimes(0);
    expect(deps.pickProvider).toHaveBeenCalledTimes(0);
    expect(deps.fetchProviderQuotas).toHaveBeenCalledTimes(0);
    const args = deps.runClaude.mock.calls[0][0] as string[];
    expect(args).toContain("-p");
    expect(args).not.toContain("--settings");
  });

  it("非 TTY 无 -p → exit 2（TTY guard 语义不回归）", async () => {
    const deps = makeDeps({ isInteractive: vi.fn(() => false) });
    const r = await run([], deps);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("-p/--prompt is required");
  });

  it("显式 claude 子命令非 TTY → 同样零交互 IO", async () => {
    const deps = makeDeps({ isInteractive: vi.fn(() => false) });
    await run(["claude", "-p", "hi"], deps);
    expect(deps.pickProvider).toHaveBeenCalledTimes(0);
    expect(deps.readCcSwitchProvider).toHaveBeenCalledTimes(0);
    expect(deps.readLastProvider).toHaveBeenCalledTimes(0);
  });
});

// ----------------------------------------------------------------------------
// 验收点 7 — 顺序契约（C-P3 可观测投影）
// ----------------------------------------------------------------------------

describe("调用顺序契约 // C-P3 invocationCallOrder", () => {
  it("TUI 确认链：lookup < pick < write < spawn", async () => {
    const deps = makeDeps({ pickProvider: pickerSelectByName("GLM") });
    await run([], deps);
    // vitest 每个 mock 有全局可比的 invocationCallOrder（首次调用序号）
    const lookup = deps.readCcSwitchProvider.mock.invocationCallOrder[0];
    const pick = deps.pickProvider.mock.invocationCallOrder[0];
    const write = deps.writeLastProvider.mock.invocationCallOrder[0];
    const spawn = deps.runClaudeInteractive.mock.invocationCallOrder[0];
    expect(lookup).toBeLessThan(pick);
    expect(pick).toBeLessThan(write);
    expect(write).toBeLessThan(spawn);
  });

  it("print 静默链：read+lookup 均先于 runClaude", async () => {
    const deps = makeDeps({
      readLastProvider: vi.fn(async () => "Kimi For Coding"),
    });
    await run(["-p", "hi"], deps);
    const read = deps.readLastProvider.mock.invocationCallOrder[0];
    const lookup = deps.readCcSwitchProvider.mock.invocationCallOrder[0];
    const spawn = deps.runClaude.mock.invocationCallOrder[0];
    expect(read).toBeLessThan(spawn);
    expect(lookup).toBeLessThan(spawn);
  });
});

// ----------------------------------------------------------------------------
// 验收点 8 — 降级（C-P10 子集）
// ----------------------------------------------------------------------------

describe("降级 // lookup 失败/空列表软警告", () => {
  it("lookup !ok → stderr 警告 + 不弹菜单 + exit 跟随 spawn（成功 0 / 失败 1 双例）", async () => {
    const ok = makeDeps({
      readCcSwitchProvider: vi.fn(async () => ({
        ok: false as const,
        kind: "db-missing" as const,
        message: "cc-switch db error: no such file",
      })),
    });
    const rOk = await run(["-p", "hi"], ok);
    expect(rOk.stderr).toContain("provider picker unavailable");
    expect(rOk.stderr).toContain("cc-switch db error: no such file");
    expect(ok.pickProvider).toHaveBeenCalledTimes(0);
    expect(ok.fetchProviderQuotas).toHaveBeenCalledTimes(0);
    expect(rOk.exitCode).toBe(0);

    const bad = makeDeps({
      readCcSwitchProvider: vi.fn(async () => ({
        ok: false as const,
        kind: "sqlite-missing" as const,
        message: "sqlite3 binary not found on PATH",
      })),
      runClaude: vi.fn(
        async (): Promise<SpawnResult> => ({
          stdout: "",
          stderr: "boom",
          exitCode: 3,
        }),
      ),
    });
    const rBad = await run(["-p", "hi"], bad);
    expect(rBad.stderr).toContain("provider picker unavailable");
    expect(rBad.exitCode).toBe(1); // spawn 失败 → 1，不被降级吞掉
  });

  it("降级时不读记忆（CONTRACT_AMBIGUOUS 2 裁决：lookup 失败即返回）", async () => {
    const deps = makeDeps({
      readCcSwitchProvider: vi.fn(async () => ({
        ok: false as const,
        kind: "db-missing" as const,
        message: "gone",
      })),
    });
    await run(["-p", "hi"], deps);
    expect(deps.readLastProvider).toHaveBeenCalledTimes(0);
    expect(deps.writeLastProvider).toHaveBeenCalledTimes(0);
  });

  it("providers=[] → 'no cc-switch providers' 警告 + 不调 pickProvider（AMBIGUOUS 3）", async () => {
    const deps = makeDeps({
      readCcSwitchProvider: vi.fn(async () => ({
        ok: true as const,
        providers: [],
      })),
    });
    const r = await run(["-p", "hi"], deps);
    expect(r.stderr).toContain("no cc-switch providers");
    expect(deps.pickProvider).toHaveBeenCalledTimes(0);
    expect(r.exitCode).toBe(0);
  });
});

// ----------------------------------------------------------------------------
// 验收点 9 — HELP 与回归锚点（C-P10）
// ----------------------------------------------------------------------------

describe("HELP 与回归 // C-P10", () => {
  it("help 含 --pick 与 Emacs 键说明，不含旧文案「输入编号」", async () => {
    const deps = makeDeps();
    const r = await run(["--help"], deps);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("--pick");
    expect(r.stdout).toMatch(/C-n|↑↓/);
    expect(r.stdout).not.toContain("输入编号");
  });

  it("默认路径 --yolo → exit 2 逐字（回归锚点）", async () => {
    const deps = makeDeps();
    const r = await run(["--yolo", "-p", "hi"], deps);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain(
      "claude backend does not support --yolo/--sandbox",
    );
    expect(deps.pickProvider).toHaveBeenCalledTimes(0);
    expect(deps.readLastProvider).toHaveBeenCalledTimes(0);
  });

  it("TUI 确认 → runClaudeInteractive 收含 --settings 的 args 且无 -p", async () => {
    const deps = makeDeps({ pickProvider: pickerSelectByName("GLM") });
    await run([], deps);
    const args = deps.runClaudeInteractive.mock.calls[0][0] as string[];
    expect(args).not.toContain("-p");
    const env = settingsJsonOf(args).env;
    expect(env.ANTHROPIC_MODEL).toBe("glm-5.2");
  });
});

// ----------------------------------------------------------------------------
// 验收点 10 — quota 纯函数四件套（revise-3：C-Q1/C-Q2/C-Q3）
// ----------------------------------------------------------------------------

describe("buildQuotaRequest // C-Q1 三态判定与认证头", () => {
  it("kimi.com 域 → kimi kind，Bearer 前缀，路径 /coding/v1/usages", () => {
    const r = buildQuotaRequest({
      ANTHROPIC_BASE_URL: "https://api.kimi.com/coding/",
      ANTHROPIC_AUTH_TOKEN: "kimi-t",
    });
    expect(r).toEqual({
      kind: "kimi",
      url: "https://api.kimi.com/coding/v1/usages",
      authHeader: "Bearer kimi-t",
    });
  });

  it("moonshot 域 → kimi kind", () => {
    const r = buildQuotaRequest({
      ANTHROPIC_BASE_URL: "https://api.moonshot.cn/v1",
      ANTHROPIC_AUTH_TOKEN: "t",
    });
    expect(r?.kind).toBe("kimi");
    expect(r?.url).toBe("https://api.moonshot.cn/coding/v1/usages");
  });

  it("bigmodel 域 → glm kind，裸 token（无 Bearer）", () => {
    const r = buildQuotaRequest({
      ANTHROPIC_BASE_URL: "https://open.bigmodel.cn/api/anthropic",
      ANTHROPIC_AUTH_TOKEN: "glm-t",
    });
    expect(r).toEqual({
      kind: "glm",
      url: "https://open.bigmodel.cn/api/monitor/usage/quota/limit",
      authHeader: "glm-t",
    });
  });

  it("z.ai 域 → glm kind", () => {
    const r = buildQuotaRequest({
      ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic",
      ANTHROPIC_AUTH_TOKEN: "t",
    });
    expect(r?.kind).toBe("glm");
    expect(r?.url).toBe("https://api.z.ai/api/monitor/usage/quota/limit");
  });

  it("其他域（deepseek/packy/anthropic/zeta）→ null（零请求）", () => {
    for (const base of [
      "https://api.deepseek.com/anthropic",
      "https://www.packyapi.com",
      "https://api.anthropic.com",
      "https://api.zeta.dev/v1",
    ]) {
      expect(
        buildQuotaRequest({
          ANTHROPIC_BASE_URL: base,
          ANTHROPIC_AUTH_TOKEN: "t",
        }),
      ).toBeNull();
    }
  });

  it("缺 token / 缺 base / base 无 http 前缀 → null", () => {
    expect(
      buildQuotaRequest({ ANTHROPIC_BASE_URL: "https://api.kimi.com" }),
    ).toBeNull();
    expect(buildQuotaRequest({ ANTHROPIC_AUTH_TOKEN: "t" })).toBeNull();
    expect(
      buildQuotaRequest({
        ANTHROPIC_BASE_URL: "api.kimi.com/coding/",
        ANTHROPIC_AUTH_TOKEN: "t",
      }),
    ).toBeNull();
  });
});

describe("parseKimiUsages // C-Q2 字符串数值/缺 used/容错", () => {
  const RESET_SHORT = "2026-08-30T14:13:00Z"; // +2h13m
  const RESET_WEEK = "2026-09-01T12:00:00Z";

  it("完整响应：字符串数值 → short(5h窗)+weekly，pct=floor", () => {
    const body = {
      usage: {
        used: "170000",
        limit: "1000000",
        resetTime: RESET_WEEK,
      },
      limits: [
        {
          window: { duration: 300, timeUnit: "MINUTE" },
          detail: { used: "42111", limit: "100000", resetTime: RESET_SHORT },
        },
      ],
    };
    const q = parseKimiUsages(body);
    expect(q.short).toEqual({ pct: 42, resetIso: RESET_SHORT });
    expect(q.weekly).toEqual({ pct: 17, resetIso: RESET_WEEK });
  });

  it("used 缺失 → limit−remaining 兜底", () => {
    const body = {
      usage: { limit: "100", remaining: "80", resetTime: RESET_WEEK },
      limits: [
        {
          window: { duration: 300, timeUnit: "MINUTE" },
          detail: { limit: "100", remaining: "58", resetTime: RESET_SHORT },
        },
      ],
    };
    const q = parseKimiUsages(body);
    expect(q.short?.pct).toBe(42); // (100-58)/100
    expect(q.weekly?.pct).toBe(20); // (100-80)/100
  });

  it("非 5h 窗（duration≠300）不进 short；非对象/缺字段 → undefined 不 throw", () => {
    const withOther = parseKimiUsages({
      limits: [
        {
          window: { duration: 10080, timeUnit: "MINUTE" },
          detail: { used: "1", limit: "2", resetTime: RESET_WEEK },
        },
      ],
    });
    expect(withOther.short).toBeUndefined();
    expect(parseKimiUsages("nope")).toEqual({});
    expect(parseKimiUsages(null)).toEqual({});
    expect(parseKimiUsages({ usage: {} })).toEqual({});
    expect(() => parseKimiUsages({ limits: "x" })).not.toThrow();
  });
});

describe("parseGlmQuota // C-Q2 排序取首末", () => {
  // [auto-fix 运行时证据修订] 真实 GLM API 的 nextResetTime 是 epoch-ms 数字
  // （curl 实测 1788113075877），非 ISO 字符串——两形态都必须可解析。
  it("数值 epoch nextResetTime（真实 API 形态）→ 转 ISO 后照常排序取首末", () => {
    const SHORT = Date.parse("2026-08-30T14:00:00Z");
    const WEEK = Date.parse("2026-09-04T12:00:00Z");
    const q = parseGlmQuota({
      data: {
        limits: [
          { type: "TOKENS_LIMIT", percentage: 31, nextResetTime: WEEK },
          { type: "TOKENS_LIMIT", percentage: 38, nextResetTime: SHORT },
        ],
      },
    });
    expect(q.short).toEqual({
      pct: 38,
      resetIso: new Date(SHORT).toISOString(),
    });
    expect(q.weekly).toEqual({
      pct: 31,
      resetIso: new Date(WEEK).toISOString(),
    });
  });

  it("多项按 nextResetTime 字典序：首=short 末=weekly", () => {
    const body = {
      data: {
        limits: [
          { type: "TOKENS_LIMIT", percentage: 17, nextResetTime: "2026-09-01" },
          {
            type: "TOKENS_LIMIT",
            percentage: 42,
            nextResetTime: "2026-08-30T14:00:00Z",
          },
        ],
      },
    };
    const q = parseGlmQuota(body);
    expect(q.short).toEqual({ pct: 42, resetIso: "2026-08-30T14:00:00Z" });
    expect(q.weekly).toEqual({ pct: 17, resetIso: "2026-09-01" });
  });

  it("单项 → 仅 short；非 TOKENS_LIMIT 过滤；空/非对象 → 无窗", () => {
    expect(parseGlmQuota({ data: { limits: [] } })).toEqual({});
    expect(parseGlmQuota("x")).toEqual({});
    expect(parseGlmQuota(null)).toEqual({});
    const single = parseGlmQuota({
      data: {
        limits: [
          { type: "RATE_LIMIT", percentage: 1, nextResetTime: "x" },
          {
            type: "TOKENS_LIMIT",
            percentage: 7,
            nextResetTime: "2026-08-30T18:00:00Z",
          },
        ],
      },
    });
    expect(single.short?.pct).toBe(7);
    expect(single.weekly).toBeUndefined();
  });
});

describe("formatQuota // C-Q3 格式与相对时长", () => {
  const NOW = Date.parse("2026-08-30T12:00:00Z");
  const at = (offsetMin: number): string =>
    new Date(NOW + offsetMin * 60_000).toISOString();

  it("双窗：5h:P% wk:P% ↻<rel>（rel=短窗 reset）", () => {
    expect(
      formatQuota(
        {
          short: { pct: 42, resetIso: at(133) },
          weekly: { pct: 17, resetIso: at(3000) },
        },
        NOW,
      ),
    ).toBe("5h:42% wk:17% ↻2h13m");
  });

  it("仅短窗：5h:P% ↻<rel>", () => {
    expect(formatQuota({ short: { pct: 7, resetIso: at(240) } }, NOW)).toBe(
      "5h:7% ↻4h",
    );
  });

  it("仅周窗：wk:P% ↻<rel>（rel 用周窗 reset）", () => {
    expect(formatQuota({ weekly: { pct: 17, resetIso: at(90) } }, NOW)).toBe(
      "wk:17% ↻1h30m",
    );
  });

  it("rel 单位边界：Xm / Xh（0 分省 Ym）/ XhYm / Xd（0 时省 Yh）/ XdYh", () => {
    expect(formatQuota({ short: { pct: 1, resetIso: at(30) } }, NOW)).toBe(
      "5h:1% ↻30m",
    );
    expect(formatQuota({ short: { pct: 1, resetIso: at(300) } }, NOW)).toBe(
      "5h:1% ↻5h",
    );
    expect(formatQuota({ short: { pct: 1, resetIso: at(1560) } }, NOW)).toBe(
      "5h:1% ↻1d2h",
    );
    expect(formatQuota({ short: { pct: 1, resetIso: at(1440) } }, NOW)).toBe(
      "5h:1% ↻1d",
    );
  });

  it("reset 已过期/非法 → 省略 ↻；两窗全无 → 空串", () => {
    expect(formatQuota({ short: { pct: 1, resetIso: at(-5) } }, NOW)).toBe(
      "5h:1%",
    );
    expect(
      formatQuota({ short: { pct: 1, resetIso: "not-a-date" } }, NOW),
    ).toBe("5h:1%");
    expect(formatQuota({}, NOW)).toBe("");
  });
});

// ----------------------------------------------------------------------------
// 验收点 11 — quota 触发闭集与入参（revise-3：C-Q4）
// ----------------------------------------------------------------------------

describe("quota 触发闭集 // C-Q4 fetchProviderQuotas", () => {
  it("弹菜单路径：恰 1 次，入参=全部 providers 的 {name, env}（env 含各自 base/token）", async () => {
    const deps = makeDeps({ pickProvider: pickerSelectByName("GLM") });
    await run(["-p", "hi"], deps); // print 无记忆 → 弹菜单
    expect(deps.fetchProviderQuotas).toHaveBeenCalledTimes(1);
    const items = deps.fetchProviderQuotas.mock.calls[0][0] as QuotaItemLike[];
    expect(items.map((i) => i.name)).toEqual(DB_ORDER_NAMES);
    const kimi = items.find((i) => i.name === "Kimi For Coding");
    expect(kimi?.env.ANTHROPIC_BASE_URL).toBe("https://api.kimi.com/coding/");
    expect(kimi?.env.ANTHROPIC_AUTH_TOKEN).toBe("kimi-token");
  });

  it("fetch 在 pickProvider 之前（菜单打开即带数据）", async () => {
    const deps = makeDeps({ pickProvider: pickerSelectByName("GLM") });
    await run(["-p", "hi"], deps);
    const fetch = deps.fetchProviderQuotas.mock.invocationCallOrder[0];
    const pick = deps.pickProvider.mock.invocationCallOrder[0];
    expect(fetch).toBeLessThan(pick);
  });

  it("settings_config 损坏的 provider 不进 quota 入参（env 提取失败跳过）", async () => {
    const deps = makeDeps({
      readCcSwitchProvider: vi.fn(async () => ({
        ok: true as const,
        providers: [
          ZETA_RAW,
          { name: "Broken", settingsConfig: "not-json{" },
          GLM_RAW,
        ],
      })),
      pickProvider: pickerSelectByName("GLM"),
    });
    await run(["-p", "hi"], deps);
    const items = deps.fetchProviderQuotas.mock.calls[0][0] as QuotaItemLike[];
    expect(items.map((i) => i.name)).toEqual(["Zeta Corp", "GLM"]);
  });
});
