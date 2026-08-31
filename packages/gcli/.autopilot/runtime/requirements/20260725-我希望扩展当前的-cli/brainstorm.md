# brainstorm — gcli 扩展 claude -p 后端

## 探索的目的与约束

**目标**：在现有 agy 封装基础上，额外支持通过 `claude -p` 模式运行，并能在多个 provider（GLM/k3/kimi 等）间切换。

**项目上下文关键发现**：
- gcli 是单文件 CLI（`src/cli.ts`），agy 薄封装，零运行时依赖，纯函数（`truncate`/`buildAgyArgs`/`parseCliArgs`）有单测，spawn/IO 隔离在 `runAgy`。ESM + strict TS。exit code 0/1/2。
- 已发布 v2.0.0，bin=gcli，**向后兼容是硬约束**。
- 工作区有未提交的 stdin 改进（`readStdin` + `-p -`），独立于本任务，可单独提交。

**关键硬事实（上一轮 k3 dry-run 验证，见记忆 `claude-p-switch-provider.md`）**：
- `claude -p` 切 provider **必须**用 `--settings '{"env":{...}}'` 整包覆盖 base_url+token+模型映射；inline env 无效（settings.json 的 env 优先级更高）；`--model` 只改模型名不切 provider。
- provider 配置全在 `~/.cc-switch/cc-switch.db`（SQLite），表 `providers.settings_config`(JSON) 存每个 provider 的 env；cc-switch 切换时改写 `~/.claude/settings.json`。

**硬约束**：
- 零运行时依赖（读 SQLite 只能 spawn 系统 `sqlite3`）。
- 不改写 `~/.claude/settings.json`（用 `--settings` inline，不污染全局 provider、不影响交互会话）。
- token 不落盘（不写临时文件）。
- 纯函数可测，spawn/IO 隔离，延续现有测试模式。
- 向后兼容（agy 用法不变）。

## 候选方案与权衡

### 维度一：后端架构
- **选定：agy + claude 并存**
- 备选（排除）：废弃 agy 纯 claude——破坏性变更，违背"额外支持"措辞，已发布 v2.0.0 功能不应无故移除。

### 维度二：provider 配置来源
- **选定：spawn sqlite3 读 `~/.cc-switch/cc-switch.db`，`--provider <name>` 选用**
- 备选（排除）：gcli 自维护配置（重复维护两份）/ 命令行显式传（token 落 shell 历史，违反 token 不落盘）/ 只读 settings.json（无主动切换能力，违背"不同模型"诉求）。

### 维度三：命令 UI
- **选定：子命令风格 `gcli claude` / `gcli agy`，无子命令默认 agy**
- 备选（排除）：flag 风格 `--backend`——用户偏好子命令语义清晰，接受 argv 解析重构代价。

## 选择与理由

**综合方案：多后端子命令架构**

- `gcli agy -p "..."` 或 `gcli -p "..."`（无子命令，默认 agy，向后兼容）→ 现有 agy 路径，零改动
- `gcli claude -p "..." [--provider <name>] [--model <name>]` → claude -p 路径
  - `--provider` 指定：spawn `sqlite3 -readonly` 从 cc-switch.db 读该 provider 的 `settings_config`，组装成 `--settings` inline JSON 注入 `claude -p`（含 base_url+token+模型映射），不动全局 settings.json
  - `--provider` 不指定：不加 `--settings`，`claude -p` 直接用当前 `~/.claude/settings.json`（即 cc-switch 当前激活 provider）
  - `--model` 可选覆盖（默认用该 provider 的 SONNET 档）
  - provider 名模糊匹配（`k3` → Kimi For Coding）

**选择理由**：复用用户已有 cc-switch provider（免重复维护），零依赖（spawn sqlite3），隔离（`--settings` inline 不污染全局），向后兼容（默认 agy）。

## 待主 SKILL 接力的设计决策

需在设计文档深化：
1. **子命令 argv 解析**：首个位置参数 `agy`/`claude` 当子命令消费，否则默认 agy。`parseArgs`(`node:util`) 不直接支持子命令，需手动剥离首参后再 parseArgs。
2. **cc-switch.db 读取**：spawn `sqlite3 -readonly` 查询（`SELECT settings_config FROM providers WHERE app_type='claude' AND ...`），JSON 解析，错误处理三态（db 不存在 / provider 找不到 / sqlite3 未装）。
3. **`--settings` inline JSON 组装**：从 `settings_config` 提取 env，显式写全 `ANTHROPIC_MODEL` + 三档 `DEFAULT_*`（规避 merge 残留——上轮验证的坑）。
4. **provider 模糊匹配规则**：精确 name → 大小写不敏感 → 子串/别名（`k3`→Kimi）。
5. **新增可测纯函数**：`parseSubcommand`、`buildClaudeArgs`（类比 `buildAgyArgs`）、`buildSettingsJson`、`matchProvider`；spawn 隔离在 `runClaude`/`readCcSwitchProvider`。
6. **`--provider` 不指定时**用全局 settings.json（直接 spawn claude，不加 --settings）——需文档化此 fallback。
7. **测试**：延续纯函数单测；spawn/IO 隔离；cc-switch.db 读取用 fixture JSON 而非真 db。
8. **契约**：exit code 0/1/2 不变；`--help` 更新子命令用法；向后兼容（无子命令=agy）。
