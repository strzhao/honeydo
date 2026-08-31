# honeydo

> Honey, do everything. 🍯

一个 CLI 打通所有 AI 能力——**对话、视觉理解、生图、视频、音效、TTS**——云端与本地兼有，为 AI agent 设计。

```bash
npm i -g honeydo

honeydo ask "解释这段代码"              # LLM 对话（claude / gemini / 任意 OpenAI 兼容端点）
honeydo vision "图里有几只鸭子？" -i a.png
honeydo image gen "樱花下的猫"          # 本地生图（Apple Silicon）
honeydo image gen "logo" --engine doubao   # 云端生图（火山方舟）
honeydo video gen "黄昏的海浪" --seconds 5
honeydo tts "你好世界"                  # MiniMax TTS
honeydo sfx gen "雨打铁皮屋顶"
hd ask "hi"                            # 短别名，同一个命令
```

名字来自英语家庭梗 **honey-do list**：「honey, do this / honey, do that」——你喊 honey，它就 do。🐝

## 为什么是 CLI 而不是 MCP？

MCP server 的工具 schema **每次调用都占用 agent 上下文**——10 个用不到的工具也照吃不误。CLI **只在需要时被调用**，常驻上下文成本为零。honeydo 正是从 5 个 MCP server（Gemini、豆包、MiniMax……）迁徙而来的实战产物。

agent 友好契约：

- **统一退出码**：`0` 成功 / `1` 运行错误 / `2` 参数错误
- **stdout/stderr 纪律**：结果走 stdout，进度和给人看的信息走 stderr，管道永远干净
- 关键命令支持 **JSON 输出**（对话/视觉 `--json`，媒体生成结构化结果）

## 能力矩阵

| 命令 | 能力 | 引擎 |
|---|---|---|
| `honeydo ask` | LLM 对话 | Claude Code CLI / Gemini (agy) / Anthropic 协议直连 HTTP（`--backend agy\|api`） |
| `honeydo ask --backend local` | 本地 OpenAI 兼容端点对话 | llama.cpp、vLLM、Ollama…… |
| `honeydo vision` | 图像理解 | 本地端点（Qwen-VL 系） |
| `honeydo image gen/edit/upscale/serve` | 生图、图像编辑、2x 超分、常驻 daemon | Qwen-Image-2512 本地（bf16，Apple Silicon） |
| `honeydo image gen --engine doubao` | 云端生图 | 火山方舟（seedream，模型 fallback 链） |
| `honeydo video gen/setup` | 文生视频、首帧条件 | mmh3turbo（MiniMax-H3 GGUF）本地 |
| `honeydo sfx gen/batch/trim/...` | 音效产线全链 | Dasheng-AudioGen 本地 |
| `honeydo lora list/add` | LoRA 注册表（风格/角色/加速） | 本地 Qwen-Image LoRA |
| `honeydo tts` | TTS，字级时间戳字幕 | MiniMax speech-02 |
| `honeydo voice clone/list` | 声音克隆 / 音色列表 | MiniMax |
| `honeydo doctor` | 本地栈自检 | — |

## 安装与配置

```bash
npm i -g honeydo
```

云端能力通过环境变量读 key（honeydo 自身不落盘）：

| 环境变量 | 用于 |
|---|---|
| `DOUBAO_API_KEY` | `image gen --engine doubao`（火山方舟） |
| `MINIMAX_API_KEY` | `tts` / `voice`（`MINIMAX_API_HOST` 可换端点） |
| `QWEN_API_URL` / `QWEN_MODEL` / `QWEN_API_KEY` | `ask --backend local` / `vision`（默认 `http://127.0.0.1:8001`） |

`honeydo ask`（claude 后端）可选读取 [cc-switch](https://github.com/farion1231/cc-switch) 的 provider 库；没有 cc-switch 时直接用 `claude` CLI 的登录态即可。

### 本地媒体栈（Apple Silicon）

`image` / `video` / `sfx` 完全本地推理（diffusers + torch MPS，全量图像+编辑权重约 110GB）。运行：

```bash
honeydo doctor    # 打印哪些就绪、缺什么、怎么补
```

## 安全说明

- API key 只从环境变量读取，honeydo 不写任何密钥到磁盘。
- claude 后端会把选中的 provider token 通过子进程 argv（`--settings`）传给 `claude`——调用期间 `ps` 可见。介意的话用 `api` 后端（纯 HTTPS，无子进程）。
- 本地推理不出本机。

## 旧命令兼容

独立工具的旧 bin 仍然可用：`gcli`、`lmedia`、`doubao`、`minimax`。（`qwen` 已废弃——与阿里官方 qwen CLI 冲突；请改用 `honeydo vision` / `honeydo ask --backend local`。）

## 路线图

见 [ROADMAP.md](./ROADMAP.md)——统一配置文件、全局 `--json`、本地栈一键 setup、i18n、brew tap。

## License

[MIT](./LICENSE)
