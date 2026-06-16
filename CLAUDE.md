# minimax

CLI for the MiniMax API (TTS, voice clone, voice list), exposed as the global `minimax` command. Replaces the `minimax-mcp-js` MCP server for this workflow.

## Commands

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript to dist/
npm start            # Run compiled CLI (node dist/cli.js)
npm run dev          # Run with tsx (no build needed)
npm test             # vitest run (pure-helper unit tests)
```

## Architecture

Zero runtime dependencies (Node built-ins: `fetch`, `node:util` parseArgs, `node:fs`).

```
src/
  cli.ts         entry + subcommand dispatch (tts/voice-clone/voices) + arg parsers
  client.ts      MiniMax API client (fetch + Bearer auth + base URL; post / postMultipart)
  validate.ts    pure parameter validators (model/format/emotion/sample-rate/...) + removeUndefined
  tts.ts         /v1/t2a_v2 (buildTtsRequestData + generateSpeech; decodes hex audio)
  voice-clone.ts /v1/files/upload (multipart) + /v1/voice_clone (buildClonePayload + cloneVoice)
  voices.ts      /v1/get_voice → structured { system, cloned }
```

### Direct-invocation guard
`main()` runs only when invoked directly. Uses `realpathSync` (not `resolve`) so it holds under the npm-link symlink.

### Key behaviors
- TTS response audio is **hex-encoded** (`response.data.audio`); decoded with `Buffer.from(hex, 'hex')`.
- voice-clone uploads via **multipart/form-data** (`file` blob + `purpose=voice_clone`), then clones, then downloads the demo audio.
- `voices` returns a stable `{ system, cloned }` schema (not the raw `system_voice`/`voice_cloning` field names).
- Validators never throw on bad input — they fall back to defaults; the API's own enum validation is the final authority.

## Conventions

- ESM (`"type": "module"`), strict TypeScript
- Pure helpers (parsers, validators, `buildTtsRequestData`, `buildClonePayload`) exported for unit testing; network/IO isolated in `generateSpeech`/`cloneVoice`/`listVoices`
- Exit codes: `0` success, `1` API error / missing key, `2` bad args
