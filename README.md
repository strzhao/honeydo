# doubao

CLI for generating images via the [Doubao / Volces Ark](https://www.volcengine.com/product/doubao) image-generation API.

Generates an image from a text prompt, walks a model fallback chain when the preferred model isn't activated for the account, downloads the result, and saves it to a file. The last line of stdout is always `Saved to: <absolute path>` so scripts can grep it.

> Formerly an MCP server (`doubao-image-mcp`). The MCP layer was removed because its tool schema consumed context on every call; a CLI is invoked only when needed.

## Prerequisites

- Node.js >= 18
- A Doubao (Volces Ark) API key in the `DOUBAO_API_KEY` environment variable

## Install

```bash
npm install
npm run build
npm link        # makes `doubao` available globally
```

Confirm: `which doubao`

## Usage

```bash
# default size (2K), output to ./generated_images/<ts>_<prompt>.png
doubao "a red apple on a white background, no text"

# pick a size and an explicit output path
doubao "children book illustration, an apple" --size 3K --output /tmp/apple.png
```

### Options

| Arg | Default | Description |
|-----|---------|-------------|
| `"<prompt>"` | *(required)* | Text description of the image |
| `--size <s>` | `2K` | `2K`, `3K`, or `<width>x<height>` (e.g. `3072x2048`) |
| `--output <path>` | `./generated_images/<ts>_<prompt>.png` | Output file path |
| `--help` | | Show help |

### Exit codes

- `0` — success (image saved)
- `1` — API error or `DOUBAO_API_KEY` not set (reason on stderr)
- `2` — bad arguments

### Model fallback

Tried in order until one succeeds (skips on `ModelNotOpen` 404):
1. `doubao-seedream-5-0-260128` (preferred)
2. `doubao-seedream-5-0-lite-260128`
3. `doubao-seedream-4-5-251128`

The `3K` preset is only valid for 5.0 models; for older fallbacks it is remapped to `3072x3072`.

## Develop

```bash
npm run dev        # tsx src/cli.ts
npm run build      # tsc → dist/
npm test           # vitest run
```

## Environment

`DOUBAO_API_KEY` — Volces Ark platform API key. Endpoint: `https://ark.cn-beijing.volces.com/api/v3/images/generations`.

## License

MIT
