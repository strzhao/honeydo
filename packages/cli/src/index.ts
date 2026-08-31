#!/usr/bin/env node
/**
 * honeydo — one CLI for every AI capability.
 *
 * Thin dispatcher: routes subcommands to the sibling capability packages'
 * built entries and forwards the exit code. Zero arg translation (except the
 * documented --backend / --engine intercepts) so behaviour stays identical
 * to the legacy bins (gcli / qwen / lmedia / doubao / minimax).
 *
 * Layout assumption (repo AND published tarball are identical):
 *   package.json
 *   packages/<pkg>/dist/<entry>
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url)); // packages/cli/dist

/** sibling package entry: gcli/doubao/minimax build to cli.js, qwen/lmedia to index.js */
const ENTRIES = {
  gcli: path.resolve(HERE, "../../gcli/dist/cli.js"),
  qwen: path.resolve(HERE, "../../qwen/dist/index.js"),
  lmedia: path.resolve(HERE, "../../lmedia/dist/index.js"),
  doubao: path.resolve(HERE, "../../doubao/dist/cli.js"),
  minimax: path.resolve(HERE, "../../minimax/dist/cli.js"),
} as const;

type Pkg = keyof typeof ENTRIES;

function forward(pkg: Pkg, args: string[]): number {
  const entry = ENTRIES[pkg];
  if (!fs.existsSync(entry)) {
    process.stderr.write(
      `honeydo: missing build for ${pkg} (${entry})\nrun \`npm run build\` in the honeydo repo first\n`,
    );
    return 1;
  }
  const r = spawnSync(process.execPath, [entry, ...args], { stdio: "inherit" });
  if (r.error) {
    process.stderr.write(
      `honeydo: failed to launch ${pkg}: ${r.error.message}\n`,
    );
    return 1;
  }
  if (r.signal) {
    process.stderr.write(`honeydo: ${pkg} killed by ${r.signal}\n`);
    return 1;
  }
  return r.status ?? 1;
}

/** pull a `--flag value` / `--flag=value` pair out of argv; returns [value, rest] */
function takeFlag(
  argv: string[],
  flag: string,
): [string | undefined, string[]] {
  const rest: string[] = [];
  let value: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === flag) {
      value = argv[++i];
    } else if (a.startsWith(`${flag}=`)) {
      value = a.slice(flag.length + 1);
    } else {
      rest.push(a);
    }
  }
  return [value, rest];
}

function version(): string {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.resolve(HERE, "../../../package.json"), "utf-8"),
    );
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const HELP = `honeydo — honey, do everything. One CLI for every AI capability.

Usage: honeydo <command> [args]   (alias: hd)

Chat & vision
  ask [args]                 LLM chat (default backend: claude; --backend agy|api|local)
  vision <prompt> -i <img>   vision understanding via local OpenAI-compatible endpoint
  models                     list local endpoint models
  status                     local endpoint health

Image / video / sound (local, Apple Silicon)
  image gen <prompt>         local image gen (--engine doubao → cloud fallback)
  image edit|upscale|serve   image edit / upscale / daemon
  video gen|setup|list-res   local video gen (mmh3turbo)
  sfx gen|batch|trim|...     sound-effect production line
  lora list|add              LoRA registry

Cloud media
  image gen --engine doubao  Doubao (Volcengine Ark) cloud image
  tts <text>                 MiniMax text-to-speech
  voice clone|list           MiniMax voice cloning / voice list

Misc
  doctor                     local media stack self-check
  --version                  print version
  help                       this help

Legacy bins still work: gcli, qwen (deprecated), lmedia, doubao, minimax.
Exit codes follow the routed package: 0 ok / 1 runtime error / 2 bad args.
Docs: https://github.com/strzhao/honeydo
`;

function route(cmd: string | undefined, rest: string[]): number {
  switch (cmd) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(HELP);
      return cmd === undefined ? 2 : 0;

    case "--version":
    case "-V":
    case "-v":
      process.stdout.write(`${version()}\n`);
      return 0;

    case "ask": {
      const [backend, args] = takeFlag(rest, "--backend");
      if (backend === undefined || backend === "claude")
        return forward("gcli", args);
      if (backend === "agy" || backend === "api")
        return forward("gcli", [backend, ...args]);
      if (backend === "local") return forward("qwen", ["ask", ...args]);
      process.stderr.write(
        `honeydo: unknown --backend "${backend}" (expected claude|agy|api|local)\n`,
      );
      return 2;
    }

    case "vision":
      return forward("qwen", ["vision", ...rest]);
    case "models":
      return forward("qwen", ["models", ...rest]);
    case "status":
      return forward("qwen", ["status", ...rest]);

    case "image": {
      if (rest[0] === "gen") {
        const [engine, args] = takeFlag(rest.slice(1), "--engine");
        if (engine === undefined || engine === "local")
          return forward("lmedia", ["image", "gen", ...args]);
        if (engine === "doubao") return forward("doubao", args);
        process.stderr.write(
          `honeydo: unknown --engine "${engine}" (expected local|doubao)\n`,
        );
        return 2;
      }
      return forward("lmedia", ["image", ...rest]);
    }
    case "video":
      return forward("lmedia", ["video", ...rest]);
    case "sfx":
      return forward("lmedia", ["sfx", ...rest]);
    case "lora":
      return forward("lmedia", ["lora", ...rest]);

    case "tts":
      return forward("minimax", ["tts", ...rest]);
    case "voice": {
      const sub = rest[0];
      if (sub === "clone")
        return forward("minimax", ["voice-clone", ...rest.slice(1)]);
      if (sub === "list")
        return forward("minimax", ["voices", ...rest.slice(1)]);
      process.stderr.write("honeydo: voice expects subcommand clone|list\n");
      return 2;
    }

    case "doubao":
      return forward("doubao", rest);
    case "doctor":
      return forward("lmedia", ["doctor", ...rest]);

    default:
      process.stderr.write(`honeydo: unknown command "${cmd}"\n\n${HELP}`);
      return 2;
  }
}

process.exit(route(process.argv[2], process.argv.slice(3)));
