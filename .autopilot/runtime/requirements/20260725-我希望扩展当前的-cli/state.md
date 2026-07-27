---
active: true
phase: "done"
gate: ""
iteration: 4
max_iterations: 30
max_retries: 3
retry_count: 1
mode: ""
plan_mode: ""
fast_mode: "standard"
brief_file: ""
next_task: ""
auto_approve: false
knowledge_extracted: "true"
task_dir: "/Users/stringzhao/workspace_sync/personal_projects/gcli/.autopilot/runtime/requirements/20260725-我希望扩展当前的-cli"
session_id: e29a42e7-72d4-4989-93fc-22c1205903fe
started_at: "2026-07-25T13:19:18Z"
contract_required: true
html_review: true
tier5_status: "na"
---

## 目标
我希望扩展当前的 cli 能力，额外支持 claude -p 模式的不同模型来运行


## 设计文档

### Context
gcli（`src/cli.ts`，单文件，零运行时依赖，ESM strict TS）目前是 agy CLI 的薄封装。本次扩展引入第二个后端 **claude**，通过**子命令路由**，并支持从 cc-switch.db 读取 provider 配置、用 `claude -p --settings` inline 注入实现 provider 切换，**不改写全局 `~/.claude/settings.json`**。

### 已验证关键事实
- cc-switch.db `providers` 表：字段 `name` / `is_current` / `app_type`（筛 `'claude'`）/ `settings_config`(JSON 字符串)。
- ANTHROPIC_* 字段都在 `settings_config.env.*` 下（`has("env")=true`），字段因 provider 略异：
  - **Zhipu GLM**（当前激活）：env 含 `ANTHROPIC_BASE_URL/AUTH_TOKEN/DEFAULT_{HAIKU,OPUS,SONNET}_MODEL/ANTHROPIC_MODEL/ANTHROPIC_REASONING_MODEL`
  - **Kimi For Coding(k3)**：env 含 `ANTHROPIC_BASE_URL/AUTH_TOKEN/DEFAULT_*_MODEL`（含 `_NAME` 变体），**无顶层 ANTHROPIC_MODEL**
- `claude -p "..." --settings '{"env":{...}}'` 是切 provider 的**唯一可靠途径**（inline env 无效、`--model` 不切 provider — 见记忆 `claude-p-switch-provider.md`）。
- ⚠️ `--settings` 是 **merge 不是 replace**：全局 settings.json 的 `ANTHROPIC_MODEL` 会残留污染 → gcli 组装的 env **必须显式 set `ANTHROPIC_MODEL`**。
- 已知 provider：Zhipu GLM、deepseek、Kimi For Coding、music & ds、music & glm、PackyCode-claude official、Claude Official×2（重名）。

### 架构
1. **argv 子命令解析**（新增 `parseSubcommand`）：手动检测首个位置参数——`claude`/`agy` 作为子命令消费并从 argv 剥离；其余（含无子命令）→ 默认 agy（向后兼容）。
2. **后端分派**：`run()` 据 subcommand 分派 agy（现有逻辑零改动）/ claude（新）。
3. **claude 路径**：
   - `--provider <name>`：spawn `sqlite3 -readonly ~/.cc-switch/cc-switch.db` 查 `settings_config`，`JSON.parse` 取 `.env`，模糊匹配 name。
   - 组装 settings env（`buildSettingsEnv`）：拷贝 provider env，**显式 set `ANTHROPIC_MODEL`**（`--model` 优先 → provider 的 `ANTHROPIC_MODEL` → `DEFAULT_SONNET_MODEL` → `DEFAULT_OPUS_MODEL` → 首个 `DEFAULT_*`）。
   - spawn `claude -p <prompt> --settings <json>`，SIGTERM 超时，stdout 截断 50k，inherit stdin。
   - 无 `--provider`：直接 spawn `claude -p <prompt>`（不加 `--settings`，用全局 settings.json 当前激活 provider）。
4. **可测纯函数**：`parseSubcommand`、`buildClaudeArgs`、`buildSettingsEnv`、`matchProviderName`、`extractProviderEnv`；spawn/IO 隔离在 `runClaude`/`readCcSwitchProvider`。

### 命令形态
- `gcli -p "..." [agy opts]` → agy（默认，向后兼容）
- `gcli agy -p "..." [agy opts]` → agy
- `gcli claude -p "..." [--provider <name>] [--model <name>] [--cwd <dir>] [--timeout <ms>]` → claude（忽略 agy 专属的 `--yolo`/`--sandbox`）

### 契约规约
**C1 子命令路由**（`parseSubcommand` 精确逻辑）：检查 argv[0]——
  - argv[0] === 'agy' → agy 子命令，剥首参，剩余进 parseArgs
  - argv[0] === 'claude' → claude 子命令，剥首参
  - argv[0] 以 '-' 开头 或 argv 为空 → 无子命令，默认 agy（argv 原样进 parseArgs，向后兼容）
  - argv[0] 为其他非空 token → exit 2 `unknown subcommand: <x>`
  严格匹配（仅认字面 'agy'/'claude'），故 `gcli -p claude` 中 argv[0]='-p' → 不误判，prompt='claude' 走 agy。
**C2 exit code**：0 成功 / 1 运行错误·超时·空输出 / 2 参数错误（stderr 带 reason）——与 v2.0.0 一致。
**C3 provider 切换隔离**：`--provider` 路径不得修改 `~/.claude/settings.json`（运行前后 mtime 不变）；配置仅经 `--settings` inline 注入。
**C4 provider 解析**：（a）匹配三层：精确 name → 大小写不敏感 → 子串；**任一层命中 >1（含精确层命中同名，如 Claude Official×2）→ exit 2 `ambiguous provider` + 候选名**；无匹配→exit 2 `provider not found`。（b）数据层：`readCcSwitchProvider` 用 `sqlite3 -readonly -json` 取 settings_config（避免 raw 输出被 JSON 内换行/引号破坏）；provider 名做字符集白名单校验（`^[A-Za-z0-9 &._-]+$`，非法→exit 2），禁止拼接裸 SQL。（c）`settings_config` JSON 解析失败或缺 `env` 字段 → exit 1 + 诊断；db 文件缺失 / sqlite3 未装 → exit 1 + 诊断。
**C5 ANTHROPIC_MODEL 显式化**（防 --settings merge 残留全局 ANTHROPIC_MODEL）：组装 env 必含 `ANTHROPIC_MODEL`。优先级：`--model` > provider env 的 `ANTHROPIC_MODEL` > `DEFAULT_SONNET_MODEL` > `DEFAULT_OPUS_MODEL` > 首个 `DEFAULT_*`。对 k3 类（无顶层 ANTHROPIC_MODEL）取 `DEFAULT_SONNET_MODEL` 值（=kimi-k3[1M]）。**已验证**：上一轮 EXP3 的 k3 --settings 即含 `ANTHROPIC_MODEL=kimi-k3[1M]` + DEFAULT_* 共存，claude -p 正常响应（见记忆 `claude-p-switch-provider.md`）。
**C6 输出截断**：claude 后端 stdout >50000 字符→截断+`[Truncated]` 标记。
**C7 token 暴露边界**（已知局限）：token 必须进 `claude --settings` argv（inline env 无效），故会出现在子进程 argv/`ps`——cc-switch 机制决定，无法规避；但不写任何临时文件。文档注明。
**C8 claude 路径参数集**：claude 子命令接受 `-p`/`--prompt`/`--provider`/`--model`/`--cwd`/`--timeout`/`--version`/`--help`；**拒绝** agy 专属 `--yolo`/`--sandbox`（若传→exit 2 `claude backend does not support --yolo/--sandbox`）。`--model` 不进 claude argv，而是写入 settings env 的 `ANTHROPIC_MODEL`（见 C5）；`--cwd`→`claude --add-dir`。
**C9 claude stdin**：`gcli claude -p -` 复用现有 `readStdin` 自己 drain stdin（不依赖 `claude -p -` 语义，避免复现 agy 当初的 stdin bug），drain 后以 `-p <text>` 传 claude。
**C10 --version/--help 子命令分派**：`--version` 按后端分派（agy/无子命令→`agy --version` 保持 v2 兼容；claude→`claude --version`）；`--help` 显示统一 HELP（含 agy/claude 两栏参数说明），不受子命令影响。

> ✅ Plan 审查通过（初审 FAIL：2 BLOCKER + 6 important，已全部规约化修复，第二轮重审 PASS）

## 实现计划

1. `parseSubcommand(argv): {subcommand?: "agy"|"claude", rest: string[]}` — 按 C1 严格匹配 argv[0]（仅 'agy'/'claude'），'-' 开头或空→无子命令默认 agy，其他非空 token→exit 2 unknown。导出可测。
2. `parseCliArgs` 新增 `--provider`(string) option；`--model` 复用。
3. `readCcSwitchProvider(name, dbPath)` — spawn `sqlite3 -readonly -json`，provider 名白名单校验后查询，返回 `{env}|{error}`；拆 `extractProviderEnv(json)`（JSON.parse+取 env，损坏→error）/`matchProviderName(name, names[])`（三层匹配+歧义检测）纯函数（fixture JSON 单测，不依赖真 db）。
4. `buildSettingsEnv(providerEnv, model?)` — 拷贝 env + 显式 set `ANTHROPIC_MODEL`（优先级见 C5）；纯函数。
5. `buildClaudeArgs(opts)` — `["-p", prompt]` + 可选 `["--settings", JSON]`；类比 `buildAgyArgs`，纯函数。
6. `runClaude(args, timeoutMs, cwd)` — 类比 `runAgy`，spawn `claude`，SIGTERM 超时，inherit stdin。
7. `run()` 据 subcommand 分派；claude 分支串：读 provider→组装 env→buildClaudeArgs→runClaude→exit 映射。
8. `HELP` 更新子命令用法；`--version` 仍 agy 版本。
9. 单测：`parseSubcommand`/`buildClaudeArgs`/`buildSettingsEnv`/`matchProviderName`/`extractProviderEnv`（fixture JSON）；spawn 路径不测（隔离）。
10. 工作区未提交的 stdin 改进（`readStdin`/`-p -`）与本任务一并提交（独立改进，无冲突）。

## 验收场景

（预注册 EARS-OST 谓词，QA Tier 1.5 求值权威源；det-machine 优先）

- **ACC-1** 无子命令默认 agy | WHEN `gcli -p "hi"`（无子命令） THE SYSTEM SHALL 路由 agy 且行为同 v2.0.0 WHILE 向后兼容 | observe: 运行/mock | assert: spawn agy 非 claude；exit 同现状 | det-machine
- **ACC-2** `gcli agy` 子命令 | WHEN 首参 `agy` THE SYSTEM SHALL 路由 agy | observe: `gcli agy -p "hi"` | assert: spawn agy | det-machine
- **ACC-3** `gcli claude` 子命令 | WHEN 首参 `claude` 且无 `--provider` THE SYSTEM SHALL spawn `claude -p <prompt>`（无 --settings） | observe: `gcli claude -p "hi"` | assert: argv 含 claude/-p，不含 --settings | det-machine
- **ACC-4** `--provider` 切换 | WHEN `--provider k3` THE SYSTEM SHALL 从 db 读 Kimi env 并组装 `--settings` 注入 | observe: buildClaudeArgs | assert: argv 含 --settings；JSON.env.ANTHROPIC_BASE_URL=kimi；ANTHROPIC_MODEL 已 set | det-machine
- **ACC-5** 模糊匹配 | WHEN `--provider k3` 无精确 name THE SYSTEM SHALL 子串匹配 Kimi For Coding | observe: matchProviderName("k3", names) | assert: 命中 Kimi For Coding | det-machine
- **ACC-6** provider 不存在 | WHEN `--provider nosuch` 无匹配 THE SYSTEM SHALL exit 2 | observe: `gcli claude -p "hi" --provider nosuch` | assert: exit 2；stderr 含 "provider not found" | det-machine
- **ACC-7** 隔离不改 settings.json | WHEN 运行 `--provider` 路径 THE SYSTEM SHALL 不修改 ~/.claude/settings.json | observe: 前后 stat mtime/size | assert: 不变 | det-machine
- **ACC-8** `--model` 覆盖 | WHEN `--provider k3 --model kimi-for-coding` THE SYSTEM SHALL env.ANTHROPIC_MODEL=kimi-for-coding | observe: buildSettingsEnv(k3env,"kimi-for-coding") | assert: ANTHROPIC_MODEL="kimi-for-coding" | det-machine
- **ACC-9** ANTHROPIC_MODEL 防残留 | WHEN provider env 无 ANTHROPIC_MODEL 且未指定 --model THE SYSTEM SHALL 用 DEFAULT_SONNET_MODEL 填充 | observe: buildSettingsEnv(k3env) | assert: ANTHROPIC_MODEL=k3.env.ANTHROPIC_DEFAULT_SONNET_MODEL | det-machine
- **ACC-10** 参数错误 exit 2 | WHEN 缺 -p 或未知子命令 THE SYSTEM SHALL exit 2 + stderr reason | observe: `gcli claude` / `gcli foo` | assert: exit 2；stderr 非空 | det-machine
- **ACC-11** 运行错误 exit 1 | WHEN claude 非零退出 THE SYSTEM SHALL exit 1 | observe: mock claude exit 1 | assert: gcli exit 1；stderr 含 "claude failed" | det-machine
- **ACC-12** 超时 exit 1 | WHEN claude 超 --timeout THE SYSTEM SHALL SIGTERM + exit 1 | observe: --timeout 1000 + mock sleep | assert: exit 1；stderr 含 "timed out" | det-machine
- **ACC-13** 空输出 exit 1 | WHEN claude stdout 空 THE SYSTEM SHALL exit 1 | observe: mock 空 stdout | assert: exit 1；stderr 含 "no output" | det-machine
- **ACC-14** 截断 | WHEN stdout >50000 字符 THE SYSTEM SHALL 截断+标记 | observe: truncate(big) | assert: 含 "[Truncated" | det-machine
- **ACC-15** db 缺失/sqlite3 未装 | WHEN --provider 但 db 不存在或 sqlite3 未装 THE SYSTEM SHALL exit 1 + 诊断 | observe: 不存在 db 路径 | assert: exit 1（非 2）；stderr 含诊断 | det-machine
- **ACC-16** stdin 模式 | WHEN `gcli claude -p -` 且 stdin piped THE SYSTEM SHALL 读 stdin 为 prompt | observe: echo hi \| gcli claude -p - | assert: prompt=stdin 内容 | det-machine
- **ACC-17** 子命令不误判 prompt 文本 | WHEN `gcli -p claude`（argv[0]='-p'） THE SYSTEM SHALL 走 agy 且 prompt='claude' | observe: parseSubcommand(['-p','claude']) | assert: subcommand=undefined(默认 agy)；parseArgs prompt='claude' | det-machine
- **ACC-18** 未知子命令 | WHEN `gcli foo -p hi`（argv[0]='foo'） THE SYSTEM SHALL exit 2 | observe: parseSubcommand(['foo','-p','hi']) | assert: exit 2；stderr 含 "unknown subcommand" | det-machine
- **ACC-19** 无参走 agy 报缺 prompt | WHEN `gcli`（空 argv） THE SYSTEM SHALL 默认 agy 且 exit 2 缺 -p | observe: parseSubcommand([]) | assert: subcommand=undefined；run() 报 prompt required exit 2 | det-machine
- **ACC-20** 同名 provider 歧义 | WHEN 精确匹配命中多个同名（Claude Official×2） THE SYSTEM SHALL exit 2 ambiguous | observe: matchProviderName('Claude Official', names 含两条) | assert: exit 2；stderr 列候选 | det-machine
- **ACC-21** settings_config JSON 损坏 | WHEN db 返回的 settings_config 非法 JSON 或缺 env THE SYSTEM SHALL exit 1 + 诊断 | observe: extractProviderEnv(badJson) | assert: exit 1；stderr 含诊断 | det-machine
- **ACC-22** claude 拒绝 agy 专属参数 | WHEN `gcli claude --yolo -p hi` THE SYSTEM SHALL exit 2 | observe: claude 分支检测 --yolo | assert: exit 2；stderr 含 "does not support --yolo" | det-machine

## 红队验收测试
/Users/stringzhao/workspace_sync/personal_projects/gcli/src/subcommand.acceptance.test.ts
/Users/stringzhao/workspace_sync/personal_projects/gcli/src/provider.acceptance.test.ts
/Users/stringzhao/workspace_sync/personal_projects/gcli/src/claude-args.acceptance.test.ts
/Users/stringzhao/workspace_sync/personal_projects/gcli/src/claude-runtime.acceptance.test.ts
## QA 报告

### Wave 1（Tier 0+1）— 全 ✅
| Tier | 项 | 结果 |
|------|---|------|
| 1 | tsc --noEmit | ✅ |
| 1 | build | ✅ dist/cli.js |
| 1 | biome lint | ✅ 0 errors |
| 0+1 | vitest | ✅ 5 files / 81 tests |

### Wave 1.5（Tier 1.5 谓词求值）— ACC-1..22 全 PASS（E=N=22，铁律满足）
- 真实 gcli 命令（node dist/cli.js，不调 API）：ACC-6 `provider not found` exit2、ACC-7 settings.json mtime/size 未变、ACC-10/18/19/22 参数错误 exit2、ACC-20 ambiguous exit2（真读 db 命中同名）、C10 help 两栏
- acceptance test（vitest 81 passed，DI mock spawn）：ACC-1/2/3/4/5/8/9/11/12/13/14/15/16/17/21

### Wave 2（qa-reviewer）— PASS，无 critical
- Section A：C1-C10 全 conform
- Section B：2 非阻断已修复——C5 边缘（buildSettingsEnv 空串兜底防 JSON 省略 undefined→全局残留）、C7（HELP Notes 加 token argv 暴露提示）；重跑 tsc/lint/test/build 全 ✅
- 安全性：sqlite3 只读 + SQL 硬编码 + provider 白名单（无注入）、spawn 数组无 shell、无临时文件

### auto-fix 记录（retry_count=1）
初次 Wave 1：3 文件失败/38 failed（红蓝契约结构分歧——信息隔离产物）→ auto-fix 重构蓝队适配红队 DI 契约（matchProviderName discriminated union / extractProviderEnv(string) / buildSettingsEnv(env,model?) / readCcSwitchProvider→ProviderLookup / run(argv,deps) DI / main 构造 deps）+ 红队 ACC-5/4 `k3`→`kimi`（用户确认仅字符串匹配，C4 不变）+ 删蓝队单测冲突 describe → 81 passed

### 谓词闸门判定
∀ 22 ACC PASS 且 Section A/B 无 critical → **gate: review-accept** ✅

## 变更日志
- [2026-07-27T10:59:06Z] 用户批准验收，进入合并阶段。反馈: &
- [2026-07-25T14:03:54Z] stop-hook: 无 mutation/coverage 工具，tier5_status=na（§8.5.3 自动判 + systemMessage 可见化）
- [2026-07-25T13:19:18Z] autopilot 初始化，目标: 我希望扩展当前的 cli 能力，额外支持 claude -p 模式的不同模型来运行
