# gcli 项目决策与模式

<!-- tags: typescript, cli, node, parseArgs, passthrough -->
## parseArgs tokens 模式做通用 flag 透传

**场景**：CLI wrapper 需把自身未识别的 flag 透传给底层命令（如 gcli 把 claude/agy 的原生 flag `--dangerously-skip-permissions` 等透传），且不想逐个声明。

**做法**：`node:util` 的 `parseArgs` 用 `strict: false, tokens: true`。遍历 tokens：
- known option → 进 `values`（wrapper 自己消费）
- unknown option → reconstruct 成 argv 元素（用 token 的 `rawName`；若 `inlineValue` 则拼 `${rawName}=${value}`）
- positional → 直接透传 value

**避坑**：
- `strict:false` 下 `values` 类型变 `string | boolean | undefined`，构造强类型返回时用 `typeof === "string"` / `=== true` narrow（满足 strict TS）。
- reconstruct 透传时**不要追加 `--`**——会让后端把 flag 当 positional，flag 失效。直接 `args.push(...passthrough)`。
- unknown option 在 `strict:false` 下按 boolean 处理（不消费下一个 value），所以 `--unknown value` 会拆成两个 token，透传顺序仍正确。
- 反例：用 `allowPositionals:true` + positionals 当透传——bare positional（手误）也会被吞。tokens 模式更可控（可决定 positional 是否透传）。

**参考**：`src/cli.ts` 的 `parseCliArgs`（gcli v2.1）。

<!-- tags: cli, api, http, sse, thinking, kimi, cc-switch, agent -->
## gcli api 后端：纯 HTTP 绕过 claude agent 的 thinking 放大

**场景**：调用方（如 add-hanzi skill）要 k3 的创意/SVG 能力，但 `gcli claude`（claude code agent）慢到不可用（单字 Scene 53 分钟）。

**实测对比**（同模型 k3 / 同后端 api.kimi.com）：
- agent 模式：**53min/单字**，thinking 19.8 万字符 / 19 blocks；多轮工具循环（10 Read + 9 Edit + 17 Bash）每轮触发一轮 thinking，累积爆炸
- 纯 API（`gcli api`）：**~45s/单字**，thinking 768 字符 / 单 block；单轮聚焦任务 thinking 自然受控
- 差距：耗时 **70×**、thinking **259×**

**根因**：慢的不是 k3 模型，是 claude code agent 框架——它让 k3 读参考 + 写完整工程代码 + 自跑 tsc/lint + 反复修，每一步叠加一轮 thinking。纯 API 单轮调用，thinking 受任务复杂度自然约束。

**做法**：gcli `api` 后端直接打 anthropic 兼容 `/v1/messages`（Node 18+ 内置 `fetch` + `TextDecoder` 解析 SSE，零新增依赖），无 agent / 无文件访问 / 无子进程。复用 cc-switch provider 解析（与 claude 后端同源）。流式聚合 + idle 超时（不假死、不误杀）。`RunDeps.runApi` DI 可 mock（守 acceptance test 全 mock 文化）。

**避坑**：
- cc-switch 存 `ANTHROPIC_MODEL: "k3[1M]"`（context 标记），claude agent 认、**纯 API 不认**（HTTP 401 "model id does not exist, recognized as other:k3[1M]"）。须剥 `[...]` 后缀 → `k3`（`resolveApiProviderEnv` 里 `rawModel.replace(/\[[^\]]*\]$/, "")`）。
- **不要** `thinking:{type:"disabled"}`——thinking 是 k3 质量来源，纯 API 单轮已自然受控；用足够 `--max-tokens`（默认 80000）覆盖 thinking+正文即可。
- agent 自主 `Write` 会污染目标仓库——纯 API 无文件操作，根治此问题。
- 红队 mock 的 provider env 要含 `ANTHROPIC_MODEL`（或 fallback 到 `ANTHROPIC_DEFAULT_SONNET_MODEL`），否则 `resolveApiProviderEnv` 空 model → exit 1 不调 runApi。

**职责切分**：k3 只产「创意方案 + SVG 资产」（45s），工程组装（写完整 Scene TSX + HC 合规）回归调用方编排器（确定性工程，不消耗 k3 创造力）。

**参考**：`src/cli.ts` 的 `runApiBackend` / `buildApiBody` / `resolveApiProviderEnv`；add-hanzi skill `phase-workflow.md` Phase 1.2-1.3。

<!-- tags: cli, tty, interactive, picker, di -->
## 交互式 CLI wrapper 的 TTY 硬门控（picker/prompt 类交互）

**场景**：CLI wrapper 主要被 skills/CI 非交互调用（stdin 是管道），但要给人工 TTY 使用加交互能力（如编号菜单选择 provider）。任何交互 prompt 若在非 TTY 触发，脚本管道直接挂死。

**做法**：
- 交互触发用**闭集条件**：`无显式参数 && isInteractive() && 非短路分支（如 --version）`；非 TTY 下零 prompt、零外部读取（DB/网络），行为与无该特性时逐字节一致。
- 交互 UI 全写 **stderr**，stdout 保持管道纯净（print 模式下调用方只解析 stdout）。
- 零依赖手写选择器：`node:readline` + `terminal:false`（避开 raw-mode 恢复问题），spawn 子进程前 `rl.close()` 让后端 TUI 干净接管 stdin；无效输入重问、空输入=默认项、EOF=跳过。
- 降级走软警告（stderr 一行 + exit code 不变）；只有显式参数的失败才硬失败。
- 输入解析抽成纯函数 + DI 接缝注入交互动作，验收测试全程 fake，无真实 TTY 依赖。

**参考**：`src/cli.ts` 的 `pickProviderInteractive` / `parsePickerChoice` / `runClaudeBackend` picker 分支（核对锚点：2026-08-30 源码版本）。

<!-- tags: testing, tty, pty, qa, macos -->
## pty 驱动 TTY 交互 CLI 的真实场景验证（零 API 成本）

**场景**：QA Tier 1.5 需验证"仅 TTY 触发"的交互流程（如 picker 菜单），但编排器/CI 无真实终端，且不应为验证付出真实后端调用成本。

**做法**：macOS 用 BSD `script` 分配伪终端：`printf '<输入>\n' | script -q /dev/null <cmd>`——子进程看到 TTY stdin，script 把管道输入转发进 pty，stdout/stderr 合并记录可断言。配合后端自身的快速短路命令（如透传 `--version`）做 spawn 后的断言锚点，整条交互链路验证零 API 成本。

**避坑**：
- 断言菜单文本时容忍 pty 回显控制符（`^D` 等），匹配关键子串而非整行。
- 短路 flag 若被 wrapper 自身消费，用 `-- --flag` 透传让它落到后端（经 wrapper 的 passthrough 通道）。

**参考**：gcli QA 谓词 P4（2026-08-30）：`printf '0\n' | script -q /dev/null node dist/cli.js -- --version` 驱动真实 picker 菜单后 spawn `claude --version` 成功（核对锚点：2026-08-30 源码版本）。

<!-- tags: api, quota, runtime-verification, anthropic-compatible, cc-switch -->
## anthropic 兼容生态辅助 API 的字段类型必须 curl 实测，不可从工具源码推断

**场景**：集成 cc-switch provider 生态的辅助端点（quota/usage 类，如 kimi `/coding/v1/usages`、GLM `/api/monitor/usage/quota/limit`），参考实现是 jq/shell 工具（如 statusline-sage）时。

**教训**：字段名相同 ≠ 字段类型相同。jq 管道只做排序/取值不做类型解析，会掩盖类型差异——GLM 的 `nextResetTime` 是 **epoch-ms 数字**，而同名语义的 kimi `resetTime` 是 ISO 字符串；从 statusline-sage 源码看两者都"像"字符串。解析器按臆断类型写（`typeof === "string"`）会静默丢数据（表现为 UI 子项缺失而非报错）。**集成前用真实 token curl 一次端点**，把响应样例直接写成测试 fixture；解析入口做类型归一化（number|string → 统一形态），而不是拒绝非预期类型。

**证据**：(2026-08-30) gcli quota 副标题首版按 ISO 字符串解析 → pty 实测 glm 两 provider 均无副标题（缓存 ok:false）；curl 探针返回 HTTP 200 且 `nextResetTime: 1788113075877`（数字）→ `toResetIso` 归一化修复后三家 provider 实时数据全渲染。同族前例：cc-switch 存 `ANTHROPIC_MODEL: "k3[1M]"`，claude agent 认、纯 API 不认（见 api 后端条目）。

**参考**：`src/cli.ts` 的 `toResetIso` / `buildQuotaRequest`（核对锚点：2026-08-30 源码版本）。
