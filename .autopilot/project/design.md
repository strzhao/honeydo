# 项目设计：lsplat — honeydo 高斯泼溅能力包（M0→M2）

| | |
|---|---|
| **项目** | `lsplat` |
| **创建** | 2026-09-13 |
| **上游** | `docs/handoff-gaussian-splat.md`（调研 handoff）+ 同轮 brainstorm（用户四项拍板） |
| **任务** | `001-lsplat-core`、`002-lsplat-compress` |

---

## Context

relight（个人照片应用）的每日精选 Hero 页目前是一张静态 `<img>`。目标是让它变成可交互的 3D 场景。调研确认 Apple SHARP 能用单张照片本地生成 3D 高斯泼溅，其 ±15–30° 视域对「Hero 微微换个角度」恰好够用。

**本项目范围**：把这件事做成 honeydo 的独立能力包并通过 CLI 暴露，交付到「能实测出关键数值」为止（M0→M2）。**relight 侧的 demo 页（M3）不在本项目内**。

**为什么独立能力包、不塞进 lmedia**：relight 已通过 `spawn honeydo` 消费视频能力（`HONEYDO_CLI_PATH` + stdout JSON + 退出码契约）；lmedia 的 venv 是 diffusers/mflux 系而 SHARP 要 torch 2.8 + gsplat，两者栈完全不同；仓规明确「别在能力包里加对兄弟包的 import」。

**为什么拆两轮**：M2 的出口是**实测数值**（`.sog` 真实体积），它直接决定路线是否成立。先花小成本拿数字，再决定 M3 值不值得做。且 relight 是独立 git 仓，autopilot 的 state/commit/QA 全部以单仓为根。

---

## 整体架构设计

### 组件与数据流

```
                      ┌──────────────── honeydo 主壳（零依赖转发器）─────────────┐
  图片 ──┐             │  packages/cli/src/index.ts                            │
         │             │    ENTRIES.splat → ../../lsplat/dist/index.js         │
         │             │    case "splat": forward("splat", rest)               │
         │             └───────────────────┬───────────────────────────────────┘
         ▼                                 ▼
  ┌────────────────── packages/lsplat/（TypeScript 壳）──────────────────┐
  │  src/index.ts         commander 入口（含 exitOverride）+ registerX    │
  │  src/commands/        setup | doctor | predict | compress | gen       │
  │  src/lib/runtime.ts   三级运行时解析 + 各路径解析                     │
  │  src/lib/run-python.ts  spawn python + 末行 JSON（**带超时**）        │
  │  src/lib/splat-transform.ts  定位/调用第三方工具 + --stats 解析       │
  │  src/lib/errors.ts    13 个错误枚举 + 统一失败出口                    │
  │  python/predict.py    驱动 SHARP（argv[1]=JSON payload）              │
  └───────┬──────────────────────────────────────┬───────────────────────┘
          │ spawn venv python                    │ spawn splat-transform
          ▼                                      ▼
  ┌──────────────── 仓外本地栈（runtime root）─────────────────┐
  │  <root>/ml-sharp/                 SHARP 源码（git clone，  │
  │                                   editable 安装 -e .）      │
  │  <root>/.venv-sharp/bin/python    Python 3.13 + torch 2.8  │
  │                                   + gsplat 1.5.3 + SHARP   │
  │  <root>/node_modules/.bin/splat-transform  44.5 MB, node>=22│
  │  <root>/torch/hub/checkpoints/    SHARP 权重 2.62 GiB       │
  │      sharp_2572gikvuh.pt          （TORCH_HOME 重定向至此） │
  │  <root>/runs/<runId>/             每次运行的中间产物目录    │
  └────────────────────────────────────────────────────────────┘
```

### 推理→产物全过程

```
照片 ──predict──> 全量 .ply（1,179,648 点 / 56 B/点 / ≈63 MiB）
                  ↓  compress 第一步（`-d` 必须是最后一个 action，输出必须 .ply）
       splat-transform <in.ply> -N -F [-V opacity,gt,<阈值>] [--decimate-adaptive] -d <N> <tmp.pruned.ply> --stats json
                  ↓  pruned.ply（150k × 56 B ≈ 8.4 MB）
       compress 第二步
       splat-transform <tmp.pruned.ply> <out.sog> [-g cpu|<n>] [--max-workers <n>]
                  ↓
               <out.sog>（目标 1.7–3 MB，**M2 实测**）
```

### 关键技术决策与权衡

| # | 决策 | 理由 / 权衡 |
|---|---|---|
| A1 | **compress 走纯 Node（splat-transform），不走 python** | `@playcanvas/splat-transform` 3.4.2（MIT、纯 Node、仅 `webgpu`+`@adobe/spz` 两个依赖）一步做完「清理 + 抽稀 + 格式转换」，handoff 原本悬而未决的「压缩工具链」问题彻底解除 |
| A2 | **压缩必须两次调用** | 上游硬约束：`-d/--decimate` 必须是最后一个 action 且输出必须 `.ply`。中间产物同时成了天然排查抓手 |
| A3 | **`--decimate-adaptive` 作为默认抽稀策略** | README 原文 *"much better on mixed-scale content such as skies"*——照片场景必然有大片天空，对症于 handoff R1 的「等距抽稀会在低不透明度区域留洞」 |
| A4 | **splat-transform 装进 runtime 目录，不进 npm dependencies**（用户决策） | 44.5 MB + 两个依赖 + node>=22 要求，而 honeydo 根包声明 >=18。装进 runtime 让全局安装保持轻量，与 lmedia「重栈在仓外」一致 |
| A5 | **权重落 `<root>/torch/hub/checkpoints/`；spawn python 时注入 `TORCH_HOME=<root>/torch`** | 不由 plan-reviewer B4 修正。初稿用上游默认的 `~/.cache/torch/...`，但与验收谓词冲突（场景5/6 要求权重在「运行时目录」内，场景6.P2 断言该目录 `fileCount == 0`——绑到全局缓存就要清空它，会连坐用户其它模型）。**代价**：不再与手工 `sharp predict` 共享缓存（最坏重下 2.62 GiB）。✅ **已实测确认 `TORCH_HOME` 重定向生效**（`torch.hub.get_dir()` → `<TORCH_HOME>/hub`；权重恰好落在 `<root>/torch/hub/checkpoints/`） |
| A6 | **venv 在 runtime root 之内**（`<root>/.venv-sharp`） | 跟随 lmedia 惯例（`<root>/.venv-*`），doctor 路径解析因此与 lmedia 同构 |
| A7 | **`packages/lsplat/package.json` 声明 `engines: {node: ">=22"}`；根 package.json 保持 `>=18`；compress/gen 另做运行时 preflight** | 包级声明如实反映压缩工具下限；根包保持 >=18 因为主壳与其他能力包在 node 18 正常。**真正保护用户的是运行时 preflight**——lsplat `private: true` 不单独发布，包级 engines 不进 tarball。⚠️ 场景11.P3 的求值对象 = `packages/lsplat/package.json` |
| A8 | **AMLR 许可门禁**（用户决策） | `setup` 必须显式传 `--accept-research-license` 才下载权重。★ 配套：`predict` **绝不**触发 SHARP 自动下载——权重缺失报 `WeightsMissingError` 并指引 setup，否则用户绕过门禁拿到权重 |
| A9 | **lsplat 自带超时**（lmedia 的 `run-python.ts` 没有） | 照抄 relight `spawnHoneydoVideo` 的 SIGTERM → 5s → SIGKILL。⚠️ **kill 对象必须是子进程树（进程组）**，否则 python 派生的孙进程成孤儿 |
| A10 | **CI 不为 lsplat 准备在线栈** | 2.62 GiB 权重 + ~3 GB venv 在 CI 上不可行。python 依赖用例一律 `skipIf` 门控；纯 Node 侧用**假 splat-transform shell 脚本**测试（对齐 relight `wallpaper-video-spawn.test.ts` 模式） |

### 已证伪 / 已确认的技术风险

**✅ SHARP 的 PLY 属性名是标准 3DGS 命名**（直读 `apple/ml-sharp` 的 `src/sharp/utils/gaussians.py` 核实）：

```python
dtype_full = [
    (attribute, "f4")
    for attribute in ["x", "y", "z"]
    + [f"f_dc_{i}" for i in range(3)]
    + ["opacity"]
    + [f"scale_{i}" for i in range(3)]
    + [f"rot_{i}" for i in range(4)]
]
```

→ 14 × float32 = 56 B/点，与 handoff §2.1 逐字一致。**splat-transform 可原生读取，不需要转换垫片。** 同处确认 SHARP 导出时强制 linearRGB → sRGB。

**🆕 SHARP 的 PLY 是多 element 文件**：除 `vertex` 外还有 `extrinsic`/`intrinsic`/`color_space`/`image_size` 四个 supplement element。splat-transform 文档只提列级兼容 → **M2 先跑 `splat-transform <sharp.ply> --info`** 确认能解析出 1,179,648 点。若失败则在 python 侧剥离 supplement（代价：前端丢相机内参，demo 可用默认轨道相机兜底，非阻塞）。

**其余待实测项**：MPS 单张耗时 · `.ply→.sog` 真实体积（**决定路线生死**）· SOG 压缩的 WebGPU 依赖（macOS + Node）· `-d` 实际精度 · 抽稀画质。

**handoff 中已解除的风险**：~~磁盘不足~~（实测 228 GB 可用）· ~~压缩工具链未定~~ · ~~`import gsplat` 在 macOS 不可装~~。

### 任务 DAG

| ID | 任务 | 依赖 | 复杂度 |
|----|------|------|--------|
| `001-lsplat-core` | 包骨架 + runtime + setup + doctor + predict；主壳注册；根 package.json；文档登记 | - | L |
| `002-lsplat-compress` | compress + gen（两步 splat-transform 编排）+ 抽稀调参 + `MEASUREMENTS.md` | `001-lsplat-core` | M |

**拆分理由**：001 的出口是「能实测单张推理耗时 / PLY 体积 / 点数」，002 的出口是「能实测 `.sog` 体积与抽稀画质」。两者失败模式完全不同（前者是环境与权重，后者是压缩参数），且 002 需要 001 真实产出的 `.ply` 作为输入，拆开后不必重跑几分钟推理。若 001 在环境层面失败（如 macOS MPS 跑不通），002 根本不该启动。

### 跨任务设计约束

1. `src/lib/runtime.ts` 是共享接口：002 只能**新增**路径导出，**不得修改** 001 已定的三级解析语义
2. `src/lib/run-python.ts` 的超时封装在 001 定稿，002 复用
3. 错误类型与退出码在 001 定稿，002 沿用，不得新增语义重叠的错误类型
4. stdout JSON 的已有字段名不得更名：002 只能**追加**字段
5. 中间产物目录约定 `<runtime>/runs/<runId>/` 在 001 定稿
6. 两任务都必须遵守：退出码 0/1/2 契约、stdout 只放机读 JSON、产物回传绝对路径、不 import 兄弟包
7. 002 不得修改 001 的测试文件；反之亦然

### Handoff 策略

`001` → `002` 必须传递：① **一个真实产出的 `.ply` 绝对路径**（让 002 不必重跑推理）② 实测数值（MPS 耗时 / PLY 字节数 / 点数）③ runtime 真实路径与 splat-transform 版本 ④ `runtime.ts` / `run-python.ts` 的实际导出签名 ⑤ 偏差说明。

`002` 回传：实测 `.sog` 体积 · 抽稀前后画质对比结论 · `--max-gaussians` 默认值及依据 · WebGPU 可用性与 `-g cpu` 兜底结论。

---

## 契约规约

> `contract_required: true`。任务类型 = **CLI / 脚本**。

### 命令签名（invariant）

```
lsplat setup    [--accept-research-license] [--python <version>] [--force]
lsplat doctor
lsplat predict  <image> -o <out.ply>   [--device <cuda|mps|cpu>] [--timeout-ms <n>]
lsplat compress <in.ply> -o <out.sog>  [--max-gaussians <n>] [--min-opacity <f>] [--no-adaptive] [--gpu <n|cpu>] [--timeout-ms <n>]
lsplat gen      <image> -o <out.sog>   [--max-gaussians <n>] [--device <cuda|mps|cpu>] [--gpu <n|cpu>] [--timeout-ms <n>]
```

上层转发：`honeydo splat <rest...>` ≡ `lsplat <rest...>`（主壳零参数翻译）

### 参数边界（DbC）

| 参数 | 适用 | 默认 | 边界 |
|---|---|---|---|
| `-o, --out <path>` | predict/compress/gen | 必填 | 非空字符串（缺失 → 2） |
| `--device <cuda\|mps\|cpu>` | predict/gen | `auto` | 枚举外 → 2 |
| `--max-gaussians <n>` | compress/gen | `150000`（**M2 定稿**） | `1000 ≤ n ≤ 1179648`，整数，越界 → 2 |
| `--min-opacity <f>` | compress | `0` | `0 ≤ f < 1`，越界 → 2 |
| `--no-adaptive` | compress/gen | 默认启用 adaptive | 布尔 |
| `--gpu <n\|cpu>` | compress/gen | `auto` | 非负整数或 `cpu`，否则 → 2 |
| `--timeout-ms <n>` | 子进程命令 | predict/gen `1500000`；compress `600000` | 正整数，≤0 → 2 |
| `--accept-research-license` | setup | `false` | 布尔 |
| `--python <version>` | setup | `3.13` | 非空字符串 |
| `--force` | setup | `false` | 布尔（重建 venv） |

> **无 `--keep-ply` 开关**：`gen` **始终**保留 `<runDir>/full.ply`（全量）与 `<runDir>/pruned.ply`。

### 退出码（invariant）

| 码 | 语义 | 触发 |
|---|---|---|
| `0` | 成功 | 命令完成且产物存在 |
| `1` | 运行错误 | 环境缺失、**输入不存在/不可读**、子进程失败、超时、产物缺失 |
| `2` | 参数错误 | 参数**语法/取值**非法（未知选项、必填缺失、枚举外、越界） |

★ **必须实现 `program.exitOverride()`**（含子树）+ 顶层 `catch (CommanderError)`，把 `unknownOption`/`missingArgument`/`optionMissingArgument`/`unknownCommand`/`excessArguments` 映射为 `BadOptionError`(2)，`helpDisplayed`/`version` 保持 0。
**原因**：commander 默认对未知选项/缺必填 **exit 1**，与契约的 2 冲突；参照物 lmedia 全仓无 `exitOverride`，该类错误从未被覆盖（实测 commander 13.1.0：`gen --bogus` → exit 1）。

### stdout 格式（invariant）

- `predict` / `compress` / `gen`：stdout **只**输出**一行**机读 JSON；进度一律 stderr
- `setup` / `doctor`：stdout 人读结果（对齐 lmedia），进度走 stderr

```jsonc
// predict -o /abs/x.ply
{"ok":true,"out":"/abs/x.ply","gaussians":1179648,"bytes":66061086,"ms":2100,"device":"mps","runDir":"/abs/runs/..."}
// compress -o /abs/x.sog
{"ok":true,"out":"/abs/x.sog","gaussians":150000,"bytes":3145728,"ms":800,"source":{"gaussians":1179648,"bytes":66061086},"runDir":"/abs/runs/..."}
// gen -o /abs/x.sog
{"ok":true,"out":"/abs/x.sog","gaussians":150000,"bytes":3145728,"ms":2900,"source":{"gaussians":1179648,"bytes":66061086},"ply":"/abs/runs/.../full.ply","predictMs":2100,"compressMs":800,"device":"mps","runDir":"/abs/runs/..."}
```

| 字段 | 类型 | 边界 |
|---|---|---|
| `ok` | `true` | 成功路径恒 true（失败不走 stdout） |
| `out` | `string` | 绝对路径；文件存在；`statSync(out).size === bytes` |
| `gaussians` | `number` | 整数 ≥ 1；compress/gen 时 `≤ ceil(maxGaussians × 1.05)`（目标值非精确值） |
| `bytes` | `number` | 整数 ≥ 1，等于产物实际字节数 |
| `ms` | `number` | 整数 ≥ 0；gen 时 `ms == predictMs + compressMs` |
| `device` | `string` | ∈ `{cuda,mps,cpu}`（predict/gen） |
| `runDir` | `string` | 绝对路径且存在 |
| `source` | `object` | compress **与 gen**：`{gaussians, bytes}` = **全量** `.ply` 的点数与字节数 |
| `ply` | `string` | gen 专有，**恒在**：`runDir/full.ply` 绝对路径 |
| `predictMs`/`compressMs` | `number` | gen 专有，整数 ≥ 0 |

### 错误契约（invariant）

| 错误类型 | 触发 | exit |
|---|---|---|
| `BadOptionError` | 参数语法/取值非法 | `2` |
| `InputNotFoundError` | `<image>`/`<in.ply>` 不存在或不可读 | `1` |
| `RuntimeNotFoundError` | runtime root 不存在 | `1` |
| `VenvMissingError` | `<root>/.venv-sharp/bin/python` 不存在 | `1` |
| `SharpSourceMissingError` | `<root>/ml-sharp` 不存在或未完成 editable 安装（`import sharp` 失败） | `1` |
| `SplatTransformMissingError` | `<root>/node_modules/.bin/splat-transform` 不存在 | `1` |
| `LicenseNotAcceptedError` | `setup` 未传许可标志且无 `.license-accepted` | `1` |
| `WeightsMissingError` | 权重不存在（predict/gen 路径上） | `1` |
| `NodeVersionError` | compress/gen 且 node 主版本 < 22 | `1` |
| `PythonFailedError` | venv python 非零退出 | `1` |
| `TransformFailedError` | splat-transform 非零退出 | `1` |
| `TimeoutError` | 超时（SIGTERM → 5s → SIGKILL，kill 子进程树） | `1` |
| `OutputMissingError` | 子进程成功但 `-o` 产物不存在 | `1` |

环境类错误必须附**可复制的修复命令**（对齐 lmedia 引导风格）。

### 副作用清单

- `setup` 写：`<root>/.venv-sharp/`、**`<root>/ml-sharp/`**（SHARP 源码 clone，editable 安装）、`<root>/node_modules/`、`<root>/torch/`（含 `torch/hub/checkpoints/sharp_2572gikvuh.pt`）、`<root>/.license-accepted`
- `setup` **不写**：用户 shell 配置、`~/.claude/`、系统 Python
- `predict`/`compress`/`gen` 写：`<root>/runs/<runId>/`、`-o` 指定的产物
- **所有命令不写仓内任何文件**（构建产物除外）
- `<runId>` 格式：`YYYYMMDD-HHmmss-<6位小写字母数字>`
- `<root>/.license-accepted`：纯文本，内容 = 接受时间 ISO 8601 + 换行 + `Apple AMLR (ml-sharp)`。存在即视为已接受

---

## 验收场景（SSOT）

完整列表见 `.autopilot/runtime/requirements/20260914-开始实现/state.md` 的 `## 验收场景` 区域（场景 1–11 由信息隔离的生成器产出并冻结；场景 12 为编排器为补齐契约闭集缺口而追加）。共 **12 个场景 / 50+ 条预注册谓词**，QA 阶段逐条对真实产物求值。

覆盖映射：

| 场景 | 归属 |
|---|---|
| 4、5、6、7、8、11、12(P1/P2/P5/P7/P9) | `001-lsplat-core` |
| 1、2、3、9、10、12(P3/P4/P6/P8/P10) | `002-lsplat-compress` |

---

## 不在本项目内（明确不做）

- relight 侧接入：demo 页 / Spark.js / size-limit / 每日流水线（新队列、`dailyPicks` 加列、COS 上传、`syncDayToGallery`）—— 独立 git 仓，待本项目实测数据出来后另起一轮
- `lsplat view` 命令（`splat-transform <ply> <html>` 已可即时目视，包装收益低于维护成本）
- 多图 → splat、历史日期回填、`apps/mac` 壁纸接入
- 2.5D 深度图视差路线
