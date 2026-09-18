# gcli

Thin CLI wrapper around the `agy` and `claude` CLI backends, plus an `api` backend (pure HTTP) and a `hermes` subcommand (model/provider switcher for the hermes agent).

Adds value over calling the backends directly: subcommand routing (`agy` default, `claude` for cc-switch provider switching), prompt via argv or stdin, 50k-char output truncation, a hard timeout (spawn kill), explicit exit codes, and an interactive TUI mode. Exists so calling skills have a stable entry point even if the underlying CLIs are renamed.

## Prerequisites

- Node.js >= 18
- The `agy` CLI installed and authenticated (formerly `gemini`)
- For the `claude` backend: the `claude` CLI, [cc-switch] managing providers, and `sqlite3` on PATH
- For the `hermes` subcommand: the `hermes` CLI installed with `~/.hermes/` set up

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

### hermes subcommand (model/provider switcher)

```bash
# show current hermes model/provider + last switch record
gcli hermes status

# switch hermes to a cc-switch provider (TTY picker when the name is omitted)
gcli hermes kimi
gcli hermes "glm flash lastest" --model glm-5.3-flash

# preview the full plan without writing anything
gcli hermes kimi --dry-run

# roll back to the previous provider (toggles back and forth)
gcli hermes rollback
```

`gcli hermes <provider>` switches the hermes agent (`~/.hermes/`) end to end: backup `config.yaml` → rewrite the `model:`/`providers:` sections with a line-level YAML editor (unrecognized structure = error, zero writes — never a guess) → upsert the provider key into `.env` (0o600) → re-pin enabled cron jobs off the old provider → restart the gateway → verify with a `hermes -z` ping (60s hard gate) plus a best-effort state.db check. Any failure auto-rolls-back the whole chain unless `--keep-on-fail`. `--no-verify` skips the ping. Safety red lines: cc-switch.db is read-only, `~/.claude/settings.json` is never touched, and output only ever prints key names — never token values.

### Options

- **agy**: `-p/--prompt`, `--model`, `--yolo`, `--sandbox`, `--cwd`, `--timeout`, `--version`, `--help`
- **claude**: `-p/--prompt`, `--provider`, `--model`, `--cwd`, `--timeout`, `--version`, `--help` (`--yolo`/`--sandbox` are rejected)
- **hermes**: `<provider|status|rollback>`, `--model`, `--dry-run`, `--no-verify`, `--keep-on-fail`, `--help` (strict parsing — unknown flags are exit-2 errors, nothing is forwarded)

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

Output (print mode) is passed through unmodified — no size cap on stdout; quantity limits (max_tokens 等) are enforced by the endpoint, not gcli.

## Develop

```bash
npm run dev        # tsx watch
npm run build      # tsc
npm test           # vitest run
npm run lint       # biome check
```

## Changelog

- **v3.2** — Added the `hermes` subcommand: one-shot model/provider switcher for the hermes agent (`~/.hermes/`) — cc-switch facts → `config.yaml` line-level edit + `.env` upsert + cron re-pin + gateway restart + verify ping, with auto-rollback on failure; `status`/`rollback`/`--dry-run`/`--keep-on-fail`/`--no-verify`.
- **v2.1** — Interactive mode: omit `-p` in a TTY to launch the backend's interactive TUI; non-TTY/pipe without `-p` still errors (use `-p -` to pipe a prompt).
- **v2.0** — Added the `claude` backend (`gcli claude ...`) with cc-switch provider switching via `--provider`.
