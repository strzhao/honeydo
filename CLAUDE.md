# gemini-mcp

MCP server that wraps the Google Gemini CLI, enabling other AI models to call Gemini through the Model Context Protocol.

## Architecture

Single-file MCP server (`src/index.ts`) using `@modelcontextprotocol/sdk`. Communicates via stdio transport.

### Key components
- `runGemini()` — spawns `gemini` CLI process with given args, handles timeout
- `truncate()` — caps output at 50,000 characters
- `gemini_prompt` tool — main tool, sends prompts to Gemini CLI
- `gemini_version` tool — returns installed Gemini CLI version

## Development commands

```bash
npm run dev        # Start dev server with hot reload (tsx watch)
npm run build      # Compile TypeScript (tsc)
npm run start      # Run compiled server
npm run test       # Run tests (vitest)
npm run lint       # Check code with Biome
npm run lint:fix   # Auto-fix lint issues
npm run format     # Format code with Biome
npm run clean      # Remove dist/
```

## Tech stack

- **Runtime**: Node.js >= 18
- **Language**: TypeScript (strict mode)
- **MCP SDK**: `@modelcontextprotocol/sdk`
- **Validation**: Zod
- **Testing**: Vitest
- **Linting/Formatting**: Biome

## Code conventions

- ESM modules (`"type": "module"`)
- Strict TypeScript (no `any`, no `@ts-ignore`)
- Functions exported for testability
- Error handling returns `isError: true` in MCP response, never throws to caller
