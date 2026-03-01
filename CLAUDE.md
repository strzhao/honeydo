# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript to dist/
npm start            # Run compiled server (node dist/index.js)
npm run dev          # Run with tsx (no build needed, for development)
```

There are no tests in this project.

## Publishing to npm

Publishing is automated via GitHub Actions when a version tag is pushed. The tag must match `package.json` version:

```bash
# Update version in package.json first, then:
git tag v0.2.5
git push origin v0.2.5
```

The workflow uses npm Trusted Publishing (OIDC) — no `NPM_TOKEN` secret needed, but the GitHub repo must be configured as a Trusted Publisher in the npm package settings.

## Architecture

This is a single-file MCP (Model Context Protocol) server in `src/index.ts`. It communicates over stdio using `@modelcontextprotocol/sdk` and exposes one tool: `generate_image`.

**Request flow:**
1. Claude calls `generate_image` with a `prompt` (required) and optional `size`
2. Server tries `MODEL_CANDIDATES` in order, falling back on `ModelNotOpen` (HTTP 404) errors
3. On success, downloads the image URL returned by the Doubao API and saves it to `generated_images/` relative to `dist/`
4. Returns the local file path to Claude

**Model fallback chain** (tried in order):
- `doubao-seedream-5-0-260128` (preferred)
- `doubao-seedream-5-0-lite-260128`
- `doubao-seedream-4-5-251128`

**Size handling:** The `3K` preset is only valid for 5.0 models; for older fallback models it is remapped to `3072x3072`. Custom pixel sizes use the format `<width>x<height>`.

**Adding tools:** Add a definition to the `tools` array and a `case` to the `CallToolRequestSchema` handler in `src/index.ts`.

## Environment

Requires `DOUBAO_API_KEY` environment variable (Volcano Engine / ByteDance ARK platform API key). The API endpoint is `https://ark.cn-beijing.volces.com/api/v3/images/generations`.
