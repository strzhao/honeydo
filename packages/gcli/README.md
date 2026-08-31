# gcli

Thin CLI wrapper around the `agy` and `claude` CLI backends.

Adds value over calling the backends directly: subcommand routing (`agy` default, `claude` for cc-switch provider switching), prompt via argv or stdin, 50k-char output truncation, a hard timeout (spawn kill), explicit exit codes, and an interactive TUI mode. Exists so calling skills have a stable entry point even if the underlying CLIs are renamed.

## Prerequisites

- Node.js >= 18
- The `agy` CLI installed and authenticated (formerly `gemini`)
- For the `claude` backend: the `claude` CLI, [cc-switch] managing providers, and `sqlite3` on PATH

## Install

```bash
npm install
npm run build
npm link        # makes `gcli` available globally
```

Confirm: `which gcli && gcli --version`

## Usage

### agy backend (default)

```bash
# print mode: prompt as argument
gcli -p "Explain async/await" --yolo --cwd .

# interactive TUI (no -p, requires a TTY)
gcli

# long prompt via stdin
echo "$(cat prompt.md)" | gcli -p -

# pick a model / hard timeout
gcli -p "..." --model gemini-2.5-pro --timeout 300000
```

### claude backend

```bash
# interactive TUI with the current ~/.claude/settings.json provider
gcli claude

# interactive TUI switched to a cc-switch provider (e.g. Kimi)
gcli claude --provider kimi

# print mode (one-shot)
gcli claude -p "summarize this" --provider kimi
```

`--provider <name>` is matched by exact / case-insensitive / substring against the provider names in `~/.cc-switch/cc-switch.db`. The switch happens via `claude ... --settings '{"env":{...}}'` — gcli **never** rewrites `~/.claude/settings.json`. The provider token travels in the child's argv (visible in `ps`); cc-switch's mechanism offers no sealed alternative.

### Options

- **agy**: `-p/--prompt`, `--model`, `--yolo`, `--sandbox`, `--cwd`, `--timeout`, `--version`, `--help`
- **claude**: `-p/--prompt`, `--provider`, `--model`, `--cwd`, `--timeout`, `--version`, `--help` (`--yolo`/`--sandbox` are rejected)

Omit `-p` in a TTY to launch the backend's interactive TUI (inherited stdio; no timeout/truncation; the child's exit code is passed through). Piping into gcli without `-p` is an error — use `-p -` to pipe a prompt.

### Passing flags through to the backend

Unknown flags and bare args are forwarded verbatim to the backend (agy/claude), so you can use any native flag gcli doesn't model — e.g. claude's bypass mode. No `--` needed (but `--` forces everything after it through):

```bash
gcli claude --dangerously-skip-permissions                  # claude TUI, bypass permissions
gcli claude --provider kimi --dangerously-skip-permissions  # kimi TUI, bypass
gcli claude -p "hi" --verbose --any-claude-flag value       # print + pass-through
```

### Exit codes

- `0` — success
- `1` — backend error / timeout / empty output (message on stderr)
- `2` — bad arguments (also: no `-p` in a non-TTY)
- `N` — interactive mode: the child's exit code is passed through unchanged (e.g. `130` for Ctrl-C)

Output (print mode) is truncated to 50,000 characters (a `[Truncated]` marker is appended).

## Develop

```bash
npm run dev        # tsx watch
npm run build      # tsc
npm test           # vitest run
npm run lint       # biome check
```

## Changelog

- **v2.1** — Interactive mode: omit `-p` in a TTY to launch the backend's interactive TUI; non-TTY/pipe without `-p` still errors (use `-p -` to pipe a prompt).
- **v2.0** — Added the `claude` backend (`gcli claude ...`) with cc-switch provider switching via `--provider`.
