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

## Connecting to Claude Code

To use this MCP server with Claude Code, add it to your Claude Code configuration:

1. Edit your Claude Code config file (usually at `~/.claude/claude_desktop_config.json`)

2. Add the server configuration:
```json
{
  "mcpServers": {
    "doubao-image-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/this/project/dist/index.js"]
    }
  }
}
```

Or if you want to run it from the project directory:
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
