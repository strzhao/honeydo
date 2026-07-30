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
