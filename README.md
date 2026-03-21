# gemini-mcp-server

MCP server that wraps the [Google Gemini CLI](https://github.com/google-gemini/gemini-cli), letting other AI models (Claude, GPT, etc.) call Gemini through the Model Context Protocol.

## Prerequisites

- Node.js >= 18
- Gemini CLI installed and authenticated: `npm install -g @google/gemini-cli`

## Install & Build

```bash
npm install
npm run build
```

## Usage with Claude Code

Add to your Claude Code MCP settings (`~/.claude/settings.json` or project `.claude/settings.json`):

```json
{
  "mcpServers": {
    "gemini": {
      "command": "node",
      "args": ["/absolute/path/to/gemini-mcp/dist/index.js"]
    }
  }
}
```

## Tools

### `gemini_prompt`

Send a prompt to Gemini CLI in non-interactive mode.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `prompt` | string | *(required)* | The prompt to send |
| `model` | string | CLI default | Gemini model (e.g. `gemini-2.5-pro`) |
| `sandbox` | boolean | `false` | Run in sandbox mode |
| `yolo` | boolean | `false` | Auto-approve all tool actions |
| `cwd` | string | server cwd | Working directory |
| `timeout_ms` | number | `120000` | Timeout in ms |
| `output_format` | string | `text` | `text`, `json`, or `stream-json` |

### `gemini_version`

Returns the installed Gemini CLI version.
