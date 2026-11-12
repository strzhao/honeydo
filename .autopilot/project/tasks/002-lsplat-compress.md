---
id: "002-lsplat-compress"
depends_on: ["001-lsplat-core"]
---

## 目标

在 `packages/lsplat/`（001 已建好）上新增 `compress` 与 `gen` 两个命令，并交付 **M2 的实测结论**——`.sog` 的真实体积是 handoff §8 认定的「决定整条路线生死」的数字。

**先读 `tasks/001-lsplat-core.handoff.md`**：它给出一个真实产出的 `.ply` 绝对路径（**直接用它，不要重跑几分钟的 MPS 推理**）、实测数值、runtime 真实路径、以及 `runtime.ts` / `run-python.ts` 的实际导出签名。

## 架构上下文

**压缩链路是纯 Node，不走 python**（本次调研的重大发现）：`@playcanvas/splat-transform` 3.4.2（MIT、纯 Node、仅 2 个依赖 `webgpu` + `@adobe/spz`）一步做完「清理 + 抽稀 + 格式转换」。它由 001 的 `setup` 装进 `<root>/node_modules/`。

★ **必须两次调用**（上游硬约束，README 原文：*"Must be the final action, and the output must be .ply (write a decimated PLY first, then convert in a second invocation)"*）：

```bash
# 第一步：清理 + 抽稀（输出必须 .ply）
splat-transform <in.ply> -N -F [-V opacity,gt,<阈值>] [--decimate-adaptive] -d <N> <tmp.pruned.ply> --stats json
# 第二步：转网页格式
splat-transform <tmp.pruned.ply> <out.sog> [-g cpu|<n>] [-i <sh-iterations>] [--max-workers <n>]
```

★ **默认启用 `--decimate-adaptive`**：README 原文 *"allocates removal by local error instead: much better on mixed-scale content such as skies"*——照片场景必然有大片天空，这是对症的（`-d` 的等距抽稀会在低不透明度区域留洞）。

★ **`--stats json` 是机读的**，`compress`/`gen` 应解析它拿到实际点数与体积。

**中间产物全部落 `<runDir>/`**（`<root>/runs/<runId>/`，格式 `YYYYMMDD-HHmmss-<6位>`），**默认保留**：
- `full.ply` —— **全量**产物（≈63 MiB / 1,179,648 点）。★ **`gen` 必须保留它**：验收谓词场景1.P8 直接断言裸 `gen` 跑完后该文件存在且体积落在 **[52,428,800, 83,886,080]** 字节
- `pruned.ply` —— 抽稀后（目标 ~150k 点 ≈ 8.4 MB）

（初稿曾设 `--keep-ply` 开关且默认删除——**该开关已从契约中删除**，`gen` 恒保留。）

**WebGPU**：SOG 压缩默认走 GPU（WebGPU），`-g cpu` 可禁用。⚠️ macOS + Node `webgpu@0.4.0` 的可用性**未验证**，是 M2 的必测项；`-g cpu` 的兜底性能与画质影响同样要测。

## 输入/输出契约

### 命令签名

```
lsplat compress <in.ply> -o <out.sog> [--max-gaussians <n>] [--min-opacity <f>] [--no-adaptive] [--gpu <n|cpu>] [--timeout-ms <n>]
lsplat gen      <image> -o <out.sog>  [--max-gaussians <n>] [--device <cuda|mps|cpu>] [--gpu <n|cpu>] [--timeout-ms <n>]
```

### 参数边界（DbC）

| 参数 | 默认 | 边界 |
|---|---|---|
| `--max-gaussians <n>` | `150000`（**实测后定稿**） | `1000 ≤ n ≤ 1179648`，整数；`999`/`2000000` → `BadOptionError`/2 |
| `--min-opacity <f>` | `0` | `0 ≤ f < 1`；`1` / `-0.1` → 2 |
| `--no-adaptive` | 默认**启用** adaptive | 布尔开关 |
| `--gpu <n\|cpu>` | `auto` | 非负整数或 `cpu`；`abc` → 2 |
| `--timeout-ms <n>` | compress `600000` / gen `1500000` | 正整数；`0` → 2 |

### stdout JSON（**只一行**，进度走 stderr）

```jsonc
// compress -o /abs/x.sog
{"ok":true,"out":"/abs/x.sog","gaussians":150000,"bytes":3145728,"ms":800,
 "source":{"gaussians":1179648,"bytes":66061086},"runDir":"/abs/runs/..."}

// gen -o /abs/x.sog
{"ok":true,"out":"/abs/x.sog","gaussians":150000,"bytes":3145728,"ms":2900,
 "source":{"gaussians":1179648,"bytes":66061086},
 "ply":"/abs/runs/20260914-101530-ab12cd/full.ply",
 "predictMs":2100,"compressMs":800,"device":"mps","runDir":"/abs/runs/20260914-101530-ab12cd"}
```

★ `source:{gaussians,bytes}` = **全量** `.ply` 的点数与字节数，**compress 与 gen 共用**（`gen` 缺它会导致「回传中间点数」「读回点数 == JSON 中间点数」两条谓词失败）。
★ `ply` 字段**恒在**，指向 `runDir/full.ply`。
★ `gaussians ≤ ceil(maxGaussians × 1.05)`（`-d` 是**目标值**，实际精度实测后定稿）。

### 错误契约（本任务新增部分）

| 错误类型 | 触发 | exit |
|---|---|---|
| `SplatTransformMissingError` | `<root>/node_modules/.bin/splat-transform` 不存在 | `1` |
| `NodeVersionError` | node 主版本 < 22 | `1` |
| `TransformFailedError` | splat-transform 非零退出 | `1` |
| `OutputMissingError` | 子进程成功但 `-o` 产物不存在 | `1` |
| `TimeoutError` | 超时（SIGTERM → 5s → SIGKILL，**kill 子进程树**） | `1` |

★ **实际保护用户的是运行时 preflight**（`packages/lsplat/package.json` 虽声明 `engines: {node: ">=22"}`，但它 `private: true` 不单独发布、不进 npm tarball）。

## 验收标准

取自项目 `## 验收场景`（SSOT）：

1. **场景 1**（端到端产出 `.sog`）—— P1…P10 全部。注意 P6 要求 JSON 同时回传中间与最终点数、P8 断言全量 `.ply` 存在且 ∈ [50MB, 80MB]、P10 要求产物可被第三方工具读回且点数一致
2. **场景 9**（中间产物保留 + 抽稀前后对比）—— P1/P2/P3/P4；P2 要求 `sog_bytes / ply_bytes ≤ 0.25`
3. **场景 10**（`.sog` 可被浏览器渲染器加载并交互）—— P1…P4。**驱动源限 `splat-transform <ply> <html>` 生成的自包含 viewer**（Spark/relight 属 M3，不在本项目）
   - ★ **P2 缺可观测句柄**：现成 viewer 不暴露全局 `loadedCount`。须明确观测通道（读 viewer DOM 属性 / 用 `--unbundled` 产出 / 自建最小 viewer 页），否则该谓词不可执行
4. **场景 3**（实测数值记录与真机自洽）—— P1…P4
5. **场景 12.P3/P4/P6/P8/P10**（Node 版本、超时无孤儿进程、参数边界、工具非零退出、002 侧可选参数含 `--gpu cpu`→exit 0）

**出口条件（M2）**：`.ply → .sog` 跑通；**实测 `.sog` 真实体积**；目视对比抽稀前后画质；定出 `--max-gaussians` 默认值；`MEASUREMENTS.md` 落盘且与真机复跑值自洽。

## ★ 必交付物：`packages/lsplat/MEASUREMENTS.md`

（这是目标里「实测并如实记录」的落点，初稿曾遗漏）

- **四项指标**：单张 MPS 推理耗时 / 抽稀前 PLY 体积 / 最终 `.sog` 体积 / 抽稀前后画质差异
- **`--max-gaussians` 默认值的依据**
- **WebGPU 与 `-g cpu` 兜底结论**
- 画质差异必须是 **≥2 条可二值判定**的清单项（如「无可见空洞」「主体边缘可见连续」），**不是形容词**——验收谓词直接断言该文档的结构
- 包 `README.md` 链接之

目视对比的即时工具：`splat-transform <ply> <html>` 直接出自包含 viewer。

## 已知风险（M2 的实测对象）

| 风险 | 状态 / 处置 |
|---|---|
| 🔴 **`.sog` 真实体积未知** | 本任务的核心实测对象，决定路线生死 |
| 🆕 **SHARP 的 PLY 是多 element 文件**（除 `vertex` 外还有 `extrinsic`/`intrinsic`/`color_space`/`image_size`） | splat-transform 文档只提列级兼容 → **先跑 `splat-transform <sharp.ply> --info`** 确认能正确解析 1,179,648 点。若失败，在 python 侧剥离 supplement element（代价：前端丢失相机内参，demo 可用默认轨道相机兜底，非阻塞） |
| 🟠 SOG 压缩的 WebGPU 依赖 | 实测；`-g cpu` 兜底 |
| 🟠 抽稀画质（`-F` / `-V opacity` / `--decimate-adaptive` 各自影响） | 目视对比，定默认值 |

**已确认无风险**：SHARP 的 PLY 属性名**就是标准 3DGS 命名**（`x,y,z,f_dc_0..2,opacity,scale_0..2,rot_0..3` = 14×float32 = 56 B/点，经直读 `apple/ml-sharp` 的 `utils/gaussians.py` 核实），splat-transform 可原生读取，**不需要转换垫片**。SHARP 导出时已强制 linearRGB → sRGB。

## 约束

- **不得修改** 001 已定的 `runtime.ts` 三级解析语义、`errors.ts` 的错误枚举、`run-python.ts` 的超时封装、`runs/<runId>/` 约定——只能**新增**（如 `lib/splat-transform.ts` 的定位函数）
- **不得修改 001 的测试文件**
- stdout JSON 的**已有字段名不得更名**，只能追加
