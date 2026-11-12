---
id: "001-lsplat-core"
depends_on: []
---

## 目标

在 honeydo 仓新增独立能力包 `packages/lsplat/`，交付 `setup` / `doctor` / `predict` 三个命令，并被主壳 `honeydo splat <...>` 零翻译转发。**出口 = 实测出单张推理的关键数值**（handoff 的 M0/M1）。

`compress` / `gen` **不属于本任务**（属 `002-lsplat-compress`），但本任务要为其铺好共享底座。

## 架构上下文

**要照抄的范式**：`packages/lmedia/`（全仓已验证的能力包形状）——tsup 构建 → `dist/index.js`；每个命令文件导出 `registerX(program: Command): void`；`index.ts` 只注册不路由；`program.parse()` 不接 argv。

**仓外本地栈（三级解析）**：`LSPLAT_RUNTIME` env > `~/.lsplat/runtime`（symlink，`realpathSync` 解析）> 默认目录。**「不校验的 `resolveRuntimeRoot()`」与「校验并抛错的 `resolveRuntime()`」必须分开导出**——这是 doctor 能永远不崩的原因（照抄 `packages/lmedia/src/lib/runtime.ts:47-56` 的形状与错误文案风格）。

**运行时目录布局**（全部仓外）：

```
<root>/.venv-sharp/bin/python              Python 3.13 + torch 2.8 + gsplat 1.5.3 + SHARP
<root>/ml-sharp/                          SHARP 源码（git clone，editable 安装 -e .）
<root>/node_modules/.bin/splat-transform   第三方压缩工具（002 用，本任务负责装）
<root>/torch/hub/checkpoints/sharp_2572gikvuh.pt   SHARP 权重 2.62 GiB（TORCH_HOME 重定向至此）
<root>/runs/<runId>/                       每次运行的中间产物目录
```

★ **权重必须落在 `<root>/torch/` 内**：spawn python 时注入 `TORCH_HOME=<root>/torch`。不要用上游默认的 `~/.cache/torch/hub/checkpoints/`——验收谓词要求权重在「运行时目录」内，且有一条谓词断言权重目录可被清空而不连坐用户其它模型。✅ **`TORCH_HOME` 重定向已实测确认生效**。

★ **SHARP 源码落 `<root>/ml-sharp/`**：`setup` 必须 `git clone --depth 1 https://github.com/apple/ml-sharp <root>/ml-sharp` 并 `uv pip install -p <python> -r <root>/ml-sharp/requirements.txt`（首行是 `-e .`，须在源码目录内执行）。⚠️ **绝不能走 PyPI**——PyPI 上的 `sharp` 是**完全无关的另一个包**（libsharp 球谐 wrapper），装了会静默错库且 `import sharp` 还会"成功"。

**python 驱动目录定位**：`dist/../python` 与 `src/lib/../../python` 两个候选 + **哨兵文件**（用 `predict.py`）。源码在 `packages/lsplat/python/predict.py`，随包发布（`files: ["dist","python"]`）。

**主壳注册三处**（`packages/cli/src/index.ts`，缺一不可）：① `ENTRIES` 加 `splat: path.resolve(HERE, "../../lsplat/dist/index.js")`；② `switch` 加 `case "splat": return forward("splat", rest)`；③ **`HELP` 文本加一行**（它是手写模板串，最容易漏）。

**根 `package.json`**：`files` 数组加 `packages/lsplat/dist` + `packages/lsplat/python`。

## 输入/输出契约

### 命令签名

```
lsplat setup    [--accept-research-license] [--python <version>] [--force]
lsplat doctor
lsplat predict  <image> -o <out.ply> [--device <cuda|mps|cpu>] [--timeout-ms <n>]
lsplat compress <in.ply> -o <out.sog> [--max-gaussians <n>] [--min-opacity <f>] [--no-adaptive] [--gpu <n|cpu>] [--timeout-ms <n>]   ← 002
lsplat gen      <image> -o <out.sog>  [...]                                                                                          ← 002
```

### 退出码（全仓统一）

`0` 成功 / `1` 运行错误 / `2` **仅**参数语法与取值错误（未知选项、必填缺失、枚举外、越界）。

★ **必须实现 `program.exitOverride()`**（含各子树）+ 顶层 `catch (CommanderError)`，把 `commander.unknownOption` / `missingArgument` / `optionMissingArgument` / `unknownCommand` / `excessArguments` 映射为 `BadOptionError`(exit 2)，`commander.helpDisplayed` / `version` 保持 exit 0。
**原因**：commander **默认对未知选项/缺必填 exit 1**，与契约的 `2` 冲突；参照物 lmedia 全仓无 `exitOverride`，该类错误从未被覆盖（已实测 commander 13.1.0：`gen --bogus` → exit 1）。**不做这一步，退出码契约的谓词必然失败。**

### stdout 纪律

- `predict`：stdout **只**输出**一行**机读 JSON；人读进度一律 stderr
- `setup` / `doctor`：stdout 输出人读结果（对齐 lmedia），进度走 stderr

```jsonc
// predict -o /abs/x.ply
{"ok":true,"out":"/abs/x.ply","gaussians":1179648,"bytes":66061086,
 "ms":2100,"device":"mps","runDir":"/abs/runs/20260914-101530-ab12cd"}
```

字段边界：`out` 为绝对路径且文件存在、`statSync(out).size === bytes`；`gaussians` 整数 ≥ 1；`bytes` 整数 ≥ 1；`ms` 整数 ≥ 0；`device` ∈ `{cuda,mps,cpu}`；`runDir` 绝对路径且存在。

### 参数边界（DbC）

| 参数 | 默认 | 边界 |
|---|---|---|
| `-o, --out` | 必填 | 非空字符串（缺失 → `BadOptionError`/2） |
| `--device` | `auto`（SHARP 内部 cuda→mps→cpu） | 枚举外 → 2 |
| `--timeout-ms` | `1500000` | 正整数，≤ 0 → 2 |
| `--accept-research-license` | `false` | 布尔 |
| `--python` | `3.13` | 非空字符串 |
| `--force` | `false` | 布尔（重建 venv） |

### 错误契约（本任务相关部分）

| 错误类型 | 触发 | exit |
|---|---|---|
| `BadOptionError` | 参数语法/取值非法 | `2` |
| `InputNotFoundError` | `<image>` 不存在或不可读 | `1` |
| `RuntimeNotFoundError` | runtime root 不存在 | `1` |
| `VenvMissingError` | `<root>/.venv-sharp/bin/python` 不存在 | `1` |
| `SharpSourceMissingError` | `<root>/ml-sharp` 不存在或未完成 editable 安装（`import sharp` 失败） | `1` |
| `SplatTransformMissingError` | `<root>/node_modules/.bin/splat-transform` 不存在 | `1` |
| `LicenseNotAcceptedError` | `setup` 未传许可标志且无 `.license-accepted` | `1` |
| `WeightsMissingError` | 权重不存在（predict 路径上） | `1` |
| `PythonFailedError` | venv python 非零退出 | `1` |
| `TimeoutError` | 超时（SIGTERM → 5s → SIGKILL，**kill 对象须为子进程树/进程组**） | `1` |
| `OutputMissingError` | 子进程成功但产物不存在 | `1` |

环境类错误**必须附可复制的修复命令**（对齐 lmedia 引导风格）。

★ **`WeightsMissingError` 是许可门禁的关键**：`predict` **绝不**触发 SHARP 的自动下载——权重缺失必须报错并指引 `lsplat setup --accept-research-license`，否则用户会绕过 AMLR 门禁拿到权重。

### 副作用

- `setup` 写：`<root>/.venv-sharp/`、**`<root>/ml-sharp/`**（SHARP 源码 clone）、`<root>/node_modules/`、`<root>/torch/`、`<root>/.license-accepted`（内容 = 接受时间 ISO 8601 + 换行 + `Apple AMLR (ml-sharp)`）
- `setup` **不写**：用户 shell 配置、`~/.claude/`、系统 Python
- **所有命令不写仓内任何文件**（构建产物除外）
- `runId` 格式：`YYYYMMDD-HHmmss-<6位小写字母数字>`

### doctor 硬要求

检查 runtime root / venv / splat-transform / 权重（**打印绝对路径**）/ node 版本 / MPS 可用性 / 磁盘余量；输出 `✓` / `✗ … 缺失 → 修复` 句式；失败 `exit 1`。

★ **必须零副作用**：若用 venv python 探 MPS（`import torch`），在 `__pycache__` 缺失时会新建 `.pyc` 而改变运行时目录的文件计数，破坏「doctor 前后文件计数一致」的验收谓词 → 探针**必须带 `PYTHONDONTWRITEBYTECODE=1`**，且不触发任何下载或重建。

### 超时实现

lmedia 的 `run-python.ts` **没有超时**（不是照抄对象）。照抄 relight 的 `spawnHoneydoVideo` 形状：`setTimeout` → `SIGTERM` → 5s 未退再 `SIGKILL`；**kill 对象须为子进程树（进程组）**，否则 python 侧派生的孙进程会成孤儿。

## 验收标准

取自项目 `## 验收场景`（SSOT，逐条对真实产物求值）：

1. **场景 4**（doctor 报告仓外栈状态、零副作用）—— P1/P2/P3
2. **场景 5**（setup 一键安装 + 许可显式接受）—— P1/P2/P3/P4
3. **场景 6**（未接受许可时拒绝下载）+ **场景 12.P9**（严格 exit 1，非 `!= 0`）
4. **场景 7**（参数错误统一 exit 2）—— P1/P2/P3/P4
5. **场景 8**（运行期错误统一 exit 1）—— P1/P2/P3/P4
6. **场景 11**（构建新鲜度 + 打包后可安装）—— P1/P2/P3/P4
7. **场景 12.P1/P2/P5/P7/P9**（runtime/venv 缺失、产物缺失、001 侧可选参数与 runId 格式、退出码收紧）
8. **场景 2**（上层聚合 CLI 正确转发）—— P1/P2/P3/P4

**出口条件（M0/M1）**：`lsplat setup --accept-research-license` 在 M4 Max 上跑通；`lsplat doctor` 全绿；`lsplat predict <真实照片>` 产出 `.ply`，**实测**文件体积 / MPS 耗时 / 点数并与 handoff §2.1 表格（63 MiB / 1,179,648 点）对账。

## 文档与登记（全局规范「防建完就丢」硬要求）

包内 `README.md` / `USAGE.md`（含 **AMLR 许可约束显著声明**）；根 `README.md` / `README.zh-CN.md` 的命令清单各加 `splat` 一节（两者均在 npm tarball 内发布，是用户实际看到的命令面）；honeydo 根 `CLAUDE.md` 结构表加 `lsplat/` 一行 + 边界节补 AMLR 说明；`~/.claude/CLAUDE.md` 加「何时用 + 指针」。

## 测试

照抄 lmedia 双命名：`tests/*.test.ts` + `tests/*.acceptance.test.ts`（`vitest.config.ts` 的 `include: ['tests/**/*.test.ts']` 天然匹配两者）。

- **黑盒铁律**：绝不 import 实现模块，观测通道只有 CLI spawn / 文件系统
- **HOME 隔离**：`mkdtempSync` 当 HOME + 显式删除 `LSPLAT_RUNTIME` 等噪声 env
- **真推理用 `skipIf` 门控**（如 `LSPLAT_SMOKE=1`）——CI 上不可能准备 2.62 GiB 权重
- **假 python / 假 splat-transform shell 脚本**测试参数拼装与 stdout 契约（对齐 relight `wallpaper-video-spawn.test.ts` 模式）
