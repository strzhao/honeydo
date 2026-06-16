# doubao

CLI wrapper around the Doubao (Volces Ark) image-generation API, exposed as the global `doubao` command. Formerly an MCP server (`doubao-image-mcp`); the MCP layer was removed in favor of a CLI.

## Commands

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript to dist/
npm start            # Run compiled CLI (node dist/cli.js)
npm run dev          # Run with tsx (no build needed)
npm test             # vitest run (unit tests for pure helpers)
```

## Architecture

Single-file CLI in `src/cli.ts`. Zero runtime dependencies (Node built-ins only: `fetch`, `node:util` parseArgs, `node:fs`).

### Key components
- `parseCliArgs()` — argv parsing (prompt as first positional, `--size`, `--output`)
- `normalizeSize()` / `resolveSizeForModel()` / `isModelNotOpenError()` — pure helpers (unit-tested)
- `generateImage()` — walks `MODEL_CANDIDATES`, calls the Ark API, downloads the image, writes the file

### Direct-invocation guard
`main()` runs only when invoked directly. Uses `realpathSync` (not `resolve`) so it holds under the npm-link symlink.

### Request flow
1. Prompt (required) + optional `--size`/`--output` parsed from argv
2. Missing `DOUBAO_API_KEY` → exit 1 with a clear stderr message
3. Try `MODEL_CANDIDATES` in order, falling back on `ModelNotOpen` (HTTP 404)
4. Download the returned image URL, save to `--output` or `./generated_images/<ts>_<prompt>.png`
5. On success, last stdout line is `Saved to: <absolute path>`

## Conventions

- ESM (`"type": "module"`), strict TypeScript
- Pure helpers exported for unit testing; network/IO isolated in `generateImage`
- Exit codes: `0` success, `1` API error / missing key, `2` bad args
