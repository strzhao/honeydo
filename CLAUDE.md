# gcli

Thin CLI wrapper around the `agy` and `claude` CLI backends, exposing a single global `gcli` command. Supersedes the old MCP server — the MCP layer was removed because its tool schema consumed context on every call, while a CLI is invoked only when needed.

gcli routes to either backend via a leading subcommand (`agy` default, `claude` explicit), adds a hard timeout (spawn SIGTERM), 50k-char output truncation, explicit exit codes, stdin piping (`-p -`), and an interactive TUI mode. For the claude backend it also handles cc-switch provider switching inline via `claude ... --settings`, without ever rewriting `~/.claude/settings.json`.

## Architecture

Single-file CLI (`src/cli.ts`). No runtime dependencies (Node built-ins only).

### Subcommand routing
- `parseSubcommand(argv)` — strict: argv[0] must be `agy`, `claude`, a `-`-prefixed flag, or empty. Any other leading token is an error (`unknown subcommand: <x>`). `gcli -p claude` stays on the default agy path (argv[0]=`-p`) with prompt="claude" — the subcommand must literally lead.
- `run(argv, deps)` — the DI entry point: parseSubcommand → parseCliArgs → dispatch to `runAgyBackend` / `runClaudeBackend`. Returns `{exitCode, stdout, stderr}`; `main()` owns `process.exit`.

### Key components
- `parseCliArgs()` — argv parsing (`node:util` parseArgs, **`strict:false` + `tokens:true`**). Known options are consumed; unknown flags and bare positionals are auto-forwarded to the backend (passthrough). `--` forwards everything after it unconditionally. Validates `--timeout` range.
- `buildAgyArgs()` / `buildClaudeArgs()` — translate gcli options into backend argv. `--cwd` becomes `--add-dir` on both; timeout is NOT passed (enforced by spawn kill). prompt is optional on both — when undefined, no `-p` is emitted (interactive mode).
- `matchProviderName()` — three-layer provider match (exact → case-insensitive → substring); returns `{matched}` / `{ambiguous:[]}` / `{none}`.
- `extractProviderEnv()` / `buildSettingsEnv()` — parse a cc-switch provider's `settings_config` env block; `buildSettingsEnv` always pins `ANTHROPIC_MODEL` explicitly (empty string when nothing resolves) because `claude --settings` is a *merge*, not replace — a stale global value would otherwise leak through.
- `readCcSwitchProvider()` — `sqlite3 -readonly -json` query against `~/.cc-switch/cc-switch.db`; errors are classified (`sqlite-missing` / `db-missing` / `parse`).
- `runAgy()` / `runClaude()` — print-mode spawn: inherit stdin, pipe stdout/stderr, SIGTERM on timeout.
- `spawnInteractive()` / `runAgyInteractive()` / `runClaudeInteractive()` — interactive TUI spawn: fully inherited stdio, no timeout/truncation; child exit code passed through (signal → 128+signo).
- `truncate()` — caps stdout at 50,000 characters (print mode only).
- `mapSpawnResult()` — normalizes a backend `SpawnResult` into a gcli `RunOutcome` (timeout / non-zero / empty / success).
- `main()` — wires production deps (`RunDeps`), invokes `run()`, writes stdout/stderr, exits.

### Direct-invocation guard
`main()` runs only when the file is invoked directly. The guard uses `realpathSync` (not `resolve`) so it holds under the npm-link symlink — `resolve()` does not follow symlinks and silently skipped `main()` when run via the global bin.

### Dependency injection (testability)
All spawn / IO / cc-switch access is funneled through the `RunDeps` interface (`runAgy`, `runClaude`, `runAgyInteractive`, `runClaudeInteractive`, `readCcSwitchProvider`, `readStdin`, `isInteractive`). `main()` wires the production impls; tests inject fakes so acceptance tests never depend on the real `agy`/`claude`/`sqlite3` binaries.

## Develop commands

```bash
npm run dev        # tsx watch src/cli.ts
npm run build      # tsc → dist/
npm run test       # vitest run (src only, dist excluded)
npm run lint       # biome check src
npm run lint:fix   # biome check --write src
```

## Tech stack

- **Runtime**: Node.js >= 18 (zero runtime deps)
- **Language**: TypeScript (strict mode)
- **Testing**: Vitest
- **Linting/Formatting**: Biome

## Code conventions

- ESM modules (`"type": "module"`)
- Strict TypeScript (no `any`, no `@ts-ignore`)
- Pure helpers exported for unit testing; spawn/IO isolated behind `RunDeps`
- Exit codes: `0` success, `1` backend error/timeout/empty, `2` bad args (stderr always carries the reason); interactive mode passes the child's exit code through unchanged (e.g. `130` for SIGINT)

## Testing conventions

- `cli.test.ts` — unit tests for pure helpers (`parseSubcommand`, `buildAgyArgs`, `buildClaudeArgs`, `parseCliArgs`, `matchProviderName`, `extractProviderEnv`, `buildSettingsEnv`, `truncate`).
- `*.acceptance.test.ts` — red-team acceptance tests via `RunDeps` mocks:
  - `subcommand.acceptance.test.ts` — argv routing (`agy` / `claude` / unknown / default)
  - `claude-args.acceptance.test.ts` — claude argv shape across provider/model/passthrough combos
  - `claude-runtime.acceptance.test.ts` — end-to-end claude flows (provider lookup, TTY guard, version, empty output, --yolo/--sandbox rejection)
  - `provider.acceptance.test.ts` — cc-switch provider matching, env extraction, model pinning
- No acceptance test spawns a real binary — everything goes through fakes.

## Backend flag differences

agy renamed several flags from the old gemini CLI; gcli hides this from callers. claude's `--model` is NOT passed as a flag — it is injected via `--settings` env (see `buildSettingsEnv`).

| gcli flag | agy flag | claude handling | old gemini flag |
|-----------|----------|-----------------|-----------------|
| `--yolo` | `--dangerously-skip-permissions` | **rejected** (agy-only) | `-y` / `--yolo` |
| `--sandbox` | `--sandbox` | **rejected** (agy-only) | *(n/a)* |
| `--cwd <dir>` | `--add-dir <abs>` | `--add-dir <abs>` | spawn `cwd` |
| `--model <name>` | `--model <name>` | `--settings` env `ANTHROPIC_MODEL` | `-m` |
| `--provider <name>` | *(n/a)* | cc-switch lookup → `--settings` env | *(n/a)* |
| `--timeout <ms>` | *(spawn kill)* | *(spawn kill)* | *(spawn kill)* |
| unknown flag | forwarded verbatim | forwarded verbatim | *(n/a)* |

### Interactive vs print mode
- **Print mode** (`-p <text>` or `-p -`): stdout/stderr captured, 50k-char truncation, hard timeout, exit codes 0/1/2.
- **Interactive mode** (TTY, no `-p`): stdio fully inherited, no timeout/truncation, child exit code passed through. Non-TTY without `-p` is an error (use `-p -` for piped stdin).
