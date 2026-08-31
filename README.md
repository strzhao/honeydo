# honeydo

> Honey, do everything. 🍯

One CLI for every AI capability — **chat, vision, image, video, sound effects, TTS** — cloud and local, built for AI agents.

```bash
npm i -g honeydo

honeydo ask "explain this code"              # LLM chat (claude / gemini / any OpenAI-compatible)
honeydo vision "how many ducks?" -i a.png    # vision understanding
honeydo image gen "a cat under sakura"       # local image gen (Apple Silicon)
honeydo image gen "logo" --engine doubao     # cloud image gen (Volcengine)
honeydo video gen "waves at dusk" --seconds 5
honeydo tts "你好世界"                        # MiniMax TTS
honeydo sfx gen "rain on a tin roof"
hd ask "hi"                                  # short alias, same thing
```

Named after the **honey-do list** — *"honey, do this, honey, do that."* You ask, it does. 🐝

## Why a CLI, not MCP?

MCP servers inject their tool schemas into the agent's context **on every single call** — 10 tools you'll never use still cost tokens. A CLI is invoked **only when needed**, with zero standing context cost. honeydo was born from migrating five MCP servers (Gemini, Doubao, MiniMax, …) off MCP into plain commands.

Agent-friendly by contract:

- **Unified exit codes**: `0` ok / `1` runtime error / `2` bad args
- **stdout/stderr discipline**: results on stdout, progress/humans on stderr — pipes stay clean
- **JSON output** where it matters (`--json` on chat/vision, structured results on media gen)

## Capabilities

| Command | What | Engine |
|---|---|---|
| `honeydo ask` | LLM chat | Claude Code CLI / Gemini (agy) / direct Anthropic-compatible HTTP (`--backend agy\|api`) |
| `honeydo ask --backend local` | chat against any local OpenAI-compatible endpoint | llama.cpp, vLLM, Ollama… |
| `honeydo vision` | image understanding | same local endpoint (Qwen-VL style) |
| `honeydo image gen/edit/upscale/serve` | image generation, editing, 2x upscale, daemon | Qwen-Image-2512 local (bf16, Apple Silicon) |
| `honeydo image gen --engine doubao` | cloud image gen | Volcengine Ark (seedream) with model fallback chain |
| `honeydo video gen/setup` | text-to-video, first-frame conditioning | mmh3turbo (MiniMax-H3 GGUF) local |
| `honeydo sfx gen/batch/trim/normalize/...` | full SFX production line | Dasheng-AudioGen local |
| `honeydo lora list/add` | LoRA registry (style/character/speed) | local Qwen-Image LoRAs |
| `honeydo tts` | text-to-speech, word-level subtitle timestamps | MiniMax speech-02 |
| `honeydo voice clone/list` | voice cloning / voice inventory | MiniMax |
| `honeydo doctor` | local stack self-check | — |

## Install & configure

```bash
npm i -g honeydo
```

Cloud capabilities need API keys via env (nothing is stored by honeydo itself):

| Env var | Used by |
|---|---|
| `DOUBAO_API_KEY` | `image gen --engine doubao` (Volcengine Ark) |
| `MINIMAX_API_KEY` | `tts` / `voice` (`MINIMAX_API_HOST` to override endpoint) |
| `QWEN_API_URL` / `QWEN_MODEL` / `QWEN_API_KEY` | `ask --backend local` / `vision` (default `http://127.0.0.1:8001`) |

`honeydo ask` (claude backend) can optionally read providers from [cc-switch](https://github.com/farion1231/cc-switch)'s database when present — but works fine with a plain `claude` CLI login too.

### Local media stack (Apple Silicon)

`image` / `video` / `sfx` run fully local via a Python inference stack (diffusers + torch MPS, ~110GB of model weights for the full image+edit setup). Run:

```bash
honeydo doctor    # prints what's ready, what's missing, and how to set it up
```

## Security notes

- API keys are read from env vars only; honeydo never writes them anywhere.
- For the claude backend, the selected provider token is passed to the `claude` child process via argv (`--settings`) — visible in `ps` while the call runs. Prefer the `api` backend (pure HTTPS, no child process) if that matters to you.
- Local inference never leaves your machine.

## Legacy bins

If you used the standalone tools, they still exist and remain compatible: `gcli`, `lmedia`, `doubao`, `minimax`. (`qwen` is deprecated — it collides with Alibaba's official qwen CLI; use `honeydo vision` / `honeydo ask --backend local`.)

## Roadmap

See [ROADMAP.md](./ROADMAP.md) — unified config file, global `--json`, one-command local stack setup, i18n, brew tap.

中文文档：[README.zh-CN.md](./README.zh-CN.md)

## License

[MIT](./LICENSE)
