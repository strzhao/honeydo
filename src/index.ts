#!/usr/bin/env node

/**
 * MCP Server wrapping Google Gemini CLI.
 * Allows other AI models to call Gemini through the Model Context Protocol.
 */

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// Constants
export const DEFAULT_TIMEOUT_MS = 120_000; // 2 minutes
export const CHARACTER_LIMIT = 50_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface GeminiResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export function runGemini(
  args: string[],
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  cwd?: string,
): Promise<GeminiResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("gemini", args, {
      cwd,
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Gemini CLI timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`Failed to spawn gemini CLI: ${err.message}`));
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code });
    });

    // Close stdin immediately – we use -p flag, not stdin piping
    child.stdin.end();
  });
}

export function truncate(text: string): string {
  if (text.length <= CHARACTER_LIMIT) return text;
  return (
    text.slice(0, CHARACTER_LIMIT) +
    `\n\n[Truncated — response exceeded ${CHARACTER_LIMIT} characters]`
  );
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "gemini-mcp-server",
  version: "1.0.0",
});

// ---------------------------------------------------------------------------
// Tool: gemini_prompt
// ---------------------------------------------------------------------------

const GeminiPromptSchema = z
  .object({
    prompt: z
      .string()
      .min(1, "Prompt must not be empty")
      .describe("The prompt to send to Google Gemini"),
    model: z
      .string()
      .optional()
      .describe(
        "Gemini model to use (e.g. 'gemini-2.5-pro'). Omit for the default model.",
      ),
    sandbox: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "Run Gemini in sandbox mode (restricted environment, safer for untrusted prompts)",
      ),
    yolo: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "Auto-approve all tool actions that Gemini wants to perform (use with caution)",
      ),
    cwd: z
      .string()
      .optional()
      .describe(
        "Working directory for Gemini CLI. Gemini can read/write files relative to this directory.",
      ),
    timeout_ms: z
      .number()
      .int()
      .min(5000)
      .max(600_000)
      .optional()
      .default(DEFAULT_TIMEOUT_MS)
      .describe("Timeout in milliseconds (default: 120000, max: 600000)"),
    output_format: z
      .enum(["text", "json", "stream-json"])
      .optional()
      .default("text")
      .describe("Output format from Gemini CLI"),
  })
  .strict();

server.registerTool(
  "gemini_prompt",
  {
    title: "Gemini Prompt",
    description: `Send a prompt to Google Gemini CLI and get the response.

This tool invokes the Gemini CLI in non-interactive (headless) mode. Gemini has access to its own built-in tools including file operations, shell commands, web search, and more.

Args:
  - prompt (string, required): The prompt text to send to Gemini
  - model (string, optional): Which Gemini model to use (e.g. 'gemini-2.5-pro')
  - sandbox (boolean, optional): Run in sandbox mode for safety (default: false)
  - yolo (boolean, optional): Auto-approve all Gemini tool actions (default: false)
  - cwd (string, optional): Working directory for file operations
  - timeout_ms (number, optional): Max time to wait in ms (default: 120000)
  - output_format (string, optional): 'text', 'json', or 'stream-json' (default: 'text')

Returns:
  The text response from Gemini CLI. If output_format is 'json', returns Gemini's structured JSON output.

Examples:
  - "Explain how async/await works in JavaScript"
  - "Read main.py and suggest improvements" (with cwd set)
  - "Search the web for the latest Node.js release"`,
    inputSchema: GeminiPromptSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async (params) => {
    const args: string[] = ["-p", params.prompt];

    if (params.model) {
      args.push("-m", params.model);
    }
    if (params.sandbox) {
      args.push("--sandbox");
    }
    if (params.yolo) {
      args.push("-y");
    }
    if (params.output_format !== "text") {
      args.push("-o", params.output_format);
    }

    const cwd = params.cwd ? resolve(params.cwd) : undefined;

    try {
      const result = await runGemini(args, params.timeout_ms, cwd);

      if (result.exitCode !== 0 && result.exitCode !== null) {
        const errorInfo = result.stderr || result.stdout || "Unknown error";
        return {
          content: [
            {
              type: "text" as const,
              text: `Gemini CLI exited with code ${result.exitCode}.\n\nError output:\n${truncate(errorInfo)}`,
            },
          ],
          isError: true,
        };
      }

      const output = result.stdout.trim();
      if (!output) {
        return {
          content: [
            {
              type: "text" as const,
              text: result.stderr
                ? `Gemini returned no output. Stderr: ${truncate(result.stderr)}`
                : "Gemini returned no output.",
            },
          ],
        };
      }

      return {
        content: [{ type: "text" as const, text: truncate(output) }],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// ---------------------------------------------------------------------------
// Tool: gemini_version
// ---------------------------------------------------------------------------

server.registerTool(
  "gemini_version",
  {
    title: "Gemini CLI Version",
    description: `Get the installed Gemini CLI version. Useful for checking that Gemini CLI is properly installed and accessible.`,
    inputSchema: {},
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async () => {
    try {
      const result = await runGemini(["--version"], 10_000);
      return {
        content: [
          {
            type: "text" as const,
            text:
              result.stdout.trim() || result.stderr.trim() || "Unknown version",
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("gemini-mcp-server running via stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
