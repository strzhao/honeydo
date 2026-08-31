# honeydo 开源运营计划

## 定位一句话

**One CLI for every AI capability — built for AI agents.** 对中文社区：「给 agent 配了个 honeydo：喊话就出图/出视频/出声音」。

## 核心叙事（三个钩子，按渠道选用）

1. **CLI > MCP**：MCP server 的 tool schema 每次调用都吃 agent 上下文；honeydo 从 5 个 MCP server 迁徙而来，常驻成本归零。配数字对比图最有效（MCP schema tokens vs CLI 0 tokens）。
2. **全媒体覆盖**：llm/simonw 只有文本；honeydo 有对话+视觉+图+视频+音效+TTS，且云端（Doubao/MiniMax）与本地（Apple Silicon Qwen-Image/mmh3turbo）双轨。
3. **中国 AI 服务统一入口**：Doubao/ MiniMax/ Qwen 海外工具基本不支持；拼音品牌出海的下一站是「能力聚合层」。

## 渠道与节奏

| 波次 | 渠道 | 形式 | 文案 |
|---|---|---|---|
| 1 | Hacker News | Show HN（英文） | 见下 |
| 1 | Reddit r/ClaudeAI + r/LocalLLaMA | 帖子（英文） | 见下 |
| 2 | V2EX 分享创造 / 掘金 / 即刻 | 中文帖 | 见下 |
| 2 | awesome-claude-code / awesome-cli | PR 收录 | 一句话描述 + 徽章 |
| 3 | X/Twitter + 即刻 | demo GIF 三连（image gen / tts / ask） | 短文案 + 录屏 |

发布时间建议：HN 周二-周四美西早上（北京时间晚 10 点后）；中文社区晚 8-10 点。

---

## HN 投稿（Show HN）

**Title**: Show HN: Honeydo – one CLI for every AI capability (chat, vision, image, video, audio)

**Text**:

> I kept adding MCP servers to my Claude Code setup until I counted the context cost: five servers, dozens of tool schemas, injected on every call whether used or not. So I migrated them all into a single CLI instead.
>
> honeydo does LLM chat (Claude/Gemini/any OpenAI-compatible local endpoint), vision understanding, image gen (local Qwen-Image on Apple Silicon, or Volcengine cloud), text-to-video, sound effects, and TTS/voice cloning (MiniMax) — with uniform exit codes, stdout/stderr discipline, and JSON output where it matters, so agents (and shell scripts) can consume it reliably.
>
> Named after the honey-do list: you ask, it does. `npm i -g honeydo`, or `hd` for short.
>
> GitHub: https://github.com/strzhao/honeydo — MIT, feedback welcome.

## Reddit r/ClaudeAI

**Title**: I replaced 5 MCP servers with one CLI (context tax is real)

正文同 HN 内容，加一节 before/after：

> Before: gemini-mcp + doubao-image-mcp + minimax-mcp + … ≈ N tool schemas in every system prompt.
> After: zero standing cost; the agent runs `hd image gen "…"` only when it needs an image.

## 中文社区（V2EX / 掘金 / 即刻）

**标题**：「给 agent 配了个 honeydo：一个命令干所有 AI 的活」

> 起因是 MCP 的上下文税：每挂一个 MCP server，它的工具 schema 每次调用都占上下文，用不用都收税。我把 5 个 MCP 全迁成了 CLI——常驻成本归零，只在需要时调用。
>
> 顺手把手上散落的 AI 命令行工具合成了一个开源产品 honeydo（蜂蜜+干活，你喊 honey 它就 do）：
> - 对话/视觉理解：本地 OpenAI 兼容端点（llama.cpp/vLLM 都行）
> - 生图：本地 Qwen-Image（Apple Silicon，零 API 成本）或火山方舟云端兜底
> - 视频/音效/TTS/声音克隆：mmh3turbo 本地 + MiniMax 云端
> - 统一退出码、stdout/stderr 纪律、JSON 输出——agent 和 shell 脚本都能稳定消费
>
> `npm i -g honeydo`，MIT。求 star 求拍砖：https://github.com/strzhao/honeydo

## awesome 收录 PR 要点

- awesome-claude-code：投 Tooling 类目，一句话：*"honeydo — one CLI giving Claude Code every AI capability (chat/vision/image/video/audio) without MCP context tax"*
- 确保仓库有：MIT LICENSE ✓、EN README ✓、demo（v1.0 前补 GIF）、topics: `claude-code` `ai-cli` `llm` `image-generation` `tts`
