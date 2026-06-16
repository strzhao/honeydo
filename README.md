# gcli

Thin CLI wrapper around the [`agy`](https://github.com/google-gemini/gemini-cli) CLI (formerly `gemini`).

Adds value over calling `agy` directly: prompt via argv **or** stdin, 50k-char output truncation, a hard timeout (spawn kill), explicit exit codes, and empty-output detection. Exists so calling skills have a stable entry point even if the underlying CLI is renamed again.

## Prerequisites

- Node.js >= 18
- The `agy` CLI installed and authenticated (formerly `gemini`)

## Install

```bash
npm install
npm run build
npm link        # makes `gcli` available globally
```

Confirm: `which gcli && gcli --version`

## Usage

```bash
# prompt as argument
gcli -p "Explain async/await" --yolo --cwd .

# long prompt via stdin
echo "$(cat prompt.md)" | gcli -p -

# pick a model
gcli -p "..." --model gemini-2.5-pro

# hard timeout (ms)
gcli -p "..." --timeout 300000
```

### Options

| Flag | Default | Description |
|------|---------|-------------|
| `-p, --prompt <text\|->` | *(required)* | Prompt text, or `-` to read from stdin |
| `--model <name>` | agy default | agy model (e.g. `gemini-2.5-pro`) |
| `--yolo` | off | Auto-approve tool actions (`--dangerously-skip-permissions`) |
| `--sandbox` | off | Run agy in sandbox mode |
| `--cwd <dir>` | process cwd | Working directory (added via agy `--add-dir`) |
| `--timeout <ms>` | `300000` | Hard timeout in ms (max `600000`) |
| `--version` | | Print the agy version |
| `--help` | | Show help |

### Exit codes

- `0` — success
- `1` — agy error / timeout / empty output (message on stderr)
- `2` — bad arguments

Output is truncated to 50,000 characters (a `[Truncated]` marker is appended).

## Develop

```bash
npm run dev        # tsx watch
npm run build      # tsc
npm test           # vitest run
npm run lint       # biome check
```
