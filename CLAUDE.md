# gcli

CLI wrapper around the `agy` CLI (formerly `gemini`), exposing it as the global `gcli` command. Supersedes the old MCP server — the MCP layer was removed because its tool schema consumed context on every call, while a CLI is invoked only when needed.

## Architecture

Single-file CLI (`src/cli.ts`). No runtime dependencies (uses Node built-ins only).

### Key components
- `parseCliArgs()` — argv parsing (`node:util` parseArgs), validates `--timeout` range
- `buildAgyArgs()` — translates gcli options into agy argv (`--yolo`→`--dangerously-skip-permissions`, `--cwd`→`--add-dir`; timeout is NOT passed to agy)
- `runAgy()` — spawns `agy`, enforces timeout via SIGTERM, inherits stdin so `agy -p -` reads a piped prompt
- `truncate()` — caps stdout at 50,000 characters
- `main()` — orchestrates parse → spawn → exit-code mapping

### Direct-invocation guard
`main()` runs only when the file is invoked directly. The guard uses `realpathSync` (not `resolve`) so it holds under the npm-link symlink — `resolve()` does not follow symlinks and silently skipped `main()` when run via the global bin.

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
- Pure helpers exported for unit testing; spawn/IO isolated in `runAgy`
- Exit codes: `0` success, `1` agy error/timeout/empty, `2` bad args (stderr always carries the reason)

## agy vs old gemini CLI flag differences

agy renamed several flags — gcli hides this from callers:

| gcli flag | agy flag | old gemini flag |
|-----------|----------|-----------------|
| `--yolo` | `--dangerously-skip-permissions` | `-y` / `--yolo` |
| `--cwd` | `--add-dir` | spawn `cwd` |
| `--model` | `--model` | `-m` |
| `--timeout` | *(spawn kill)* | *(spawn kill)* |
| *(removed)* | *(none)* | `-o text/json/stream-json` |
