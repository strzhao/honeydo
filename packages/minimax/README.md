# minimax

CLI for the [MiniMax](https://www.minimax.io/) API, exposing the three capabilities little-bee actually uses: text-to-audio, voice cloning, and voice listing.

> Replaces the official `minimax-mcp-js` MCP server for this workflow. The MCP server exposes 10 tools whose schemas consumed context on every call; this CLI is invoked only when needed and covers the subset that matters (add more subcommands on demand).

## Prerequisites

- Node.js >= 18
- A MiniMax API key in `MINIMAX_API_KEY`

## Install

```bash
npm install
npm run build
npm link        # makes `minimax` available globally
```

Confirm: `which minimax && minimax --help`

## Usage

```bash
# text-to-audio
minimax tts "你好，世界" --voice xiaoxiong --output /tmp/hello.mp3

# clone a voice from an audio sample
minimax voice-clone --voice my-voice --audio /tmp/sample.wav --text "demo"

# list voices (JSON to stdout)
minimax voices --type system
```

### `tts`

| Flag | Default | Description |
|------|---------|-------------|
| `<text>` | *(required)* | Text to synthesize |
| `--voice <id>` | `male-qn-qingse` | Voice ID |
| `--model <name>` | `speech-02-hd` | Model |
| `--output <path>` | `./<voice>_<ts>.mp3` | Output file |
| `--speed` / `--vol` / `--pitch` | `1.0` / `1.0` / `0` | Voice parameters |
| `--emotion <name>` | `happy` | `happy\|sad\|angry\|fearful\|disgusted\|surprised\|neutral` |
| `--format <f>` | `mp3` | `mp3\|pcm\|flac\|wav` |
| `--sample-rate` / `--bitrate` / `--channel` | `32000` / `128000` / `1` | Audio settings |
| `--language-boost <l>` | `auto` | Language hint |

### `voice-clone`

| Flag | Description |
|------|-------------|
| `--voice <id>` | *(required)* Voice ID to create |
| `--audio <file>` | *(required)* Source audio (mp3/m4a/wav) |
| `--text <demo>` | Optional demo text (synthesizes a demo wav) |
| `--output <dir>` | Directory for the demo wav (default: cwd) |

### `voices`

| Flag | Description |
|------|-------------|
| `--type <t>` | `all` (default) \| `system` \| `voice_cloning` |

Outputs JSON: `{ system: [{voice_id, voice_name}], cloned: [...] }`.

### Exit codes

- `0` — success
- `1` — API error or `MINIMAX_API_KEY` not set (reason on stderr)
- `2` — bad arguments

## Develop

```bash
npm run dev        # tsx src/cli.ts
npm run build      # tsc → dist/
npm test           # vitest run
```

## Environment

- `MINIMAX_API_KEY` — *(required)* API key
- `MINIMAX_API_HOST` — default `https://api.minimax.chat`

## License

MIT
