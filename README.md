# Custom MCP Server

A Model Context Protocol (MCP) server that exposes custom tools for Claude.

## Tools Available

**generate_image** - Generate images using Doubao AI and save to local file
  - **Parameters**:
    - `prompt` (string, required): Text description of the image to generate
    - `size` (string, optional): Output image size. Supported values: `2K`, `3K`, or `<width>x<height>` (for example `3072x2048`)
  - **Returns**: Generation details (model, requested/returned size) and path to the locally saved image file
  - **Default settings**:
    - Model (preferred): doubao-seedream-5-0-260128
    - Automatic fallbacks when the account has not activated the preferred model:
      - doubao-seedream-5-0-lite-260128
      - doubao-seedream-4-5-251128
    - Size: 2K
    - Sequential image generation: disabled
    - Response format: url
    - Watermark: false
    - Stream: false
  - **Requirements**: Set `DOUBAO_API_KEY` environment variable with your API key

## Setup and Installation

1. Install dependencies:
   ```bash
   npm install
   ```

2. Build the server:
   ```bash
   npm run build
   ```

3. Set up environment variable for Doubao API:
   ```bash
   export DOUBAO_API_KEY="your-api-key-here"
   ```
   Or add it to your shell profile (`.bashrc`, `.zshrc`, etc.).

4. Run the server:
   ```bash
   npm start
   ```

For development with auto-reload:
```bash
npm run dev
```

## Automated npm Publishing

This project publishes to npm automatically when a Git tag like `v0.2.1` is pushed.

This workflow uses npm Trusted Publishing (OIDC), so no `NPM_TOKEN` secret is required.

1. In npm package settings, configure **Trusted Publisher**:
   - Provider: `GitHub Actions`
   - Owner: `strzhao`
   - Repository: `doubao-image-mcp`
   - Workflow file: `npm-publish.yml`
   - Environment: leave empty
2. Ensure `package.json` version matches the tag (`v<version>`)
3. Push tag to trigger workflow:

```bash
git push origin v0.2.1
```

## Connecting to Claude Code

To use this MCP server with Claude Code, add it to your Claude Code configuration:

1. Edit your Claude Code config file (usually at `~/.claude/claude_desktop_config.json`)

2. Add the server configuration (recommended: run from npm package via `npx`):
```json
{
  "mcpServers": {
    "doubao-image-mcp": {
      "command": "npx",
      "args": ["-y", "doubao-image-mcp"]
    }
  }
}
```

Or if you want to run it from the local project directory:
```json
{
  "mcpServers": {
    "doubao-image-mcp": {
      "command": "npm",
      "args": ["start"],
      "cwd": "/absolute/path/to/this/project"
    }
  }
}
```

## Adding More Tools

To add more tools:

1. Add the tool definition to the `tools` array in `src/index.ts`
2. Add a new case in the `switch` statement in the `CallToolRequestSchema` handler
3. Rebuild and restart the server

## Development

- Write TypeScript code in the `src/` directory
- The project uses `tsx` for development with hot reload
- Build output goes to `dist/` directory

## License

MIT
