#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { writeFile, mkdir } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const DEFAULT_MODEL = "doubao-seedream-5-0-260128";
const FALLBACK_MODELS = [
  "doubao-seedream-5-0-lite-260128",
  "doubao-seedream-4-5-251128",
];
const MODEL_CANDIDATES = [DEFAULT_MODEL, ...FALLBACK_MODELS];
const DEFAULT_SIZE = "2K";
const PRESET_SIZES = new Set(["2K", "3K"]);
const PIXEL_SIZE_PATTERN = /^(\d{2,5})x(\d{2,5})$/i;

function normalizeSize(sizeInput: string): string {
  const trimmedSize = sizeInput.trim();
  const upperSize = trimmedSize.toUpperCase();

  if (PRESET_SIZES.has(upperSize)) {
    return upperSize;
  }

  const sizeMatch = PIXEL_SIZE_PATTERN.exec(trimmedSize);
  if (sizeMatch) {
    return `${sizeMatch[1]}x${sizeMatch[2]}`;
  }

  throw new Error('Invalid size. Supported values: "2K", "3K", or "<width>x<height>" (for example "3072x2048").');
}

function isModelNotOpenError(status: number, errorText: string): boolean {
  return status === 404 && errorText.includes("ModelNotOpen");
}

function resolveSizeForModel(size: string, model: string): string {
  // 3K shorthand is available in 5.0 models; map it to explicit pixels for older fallbacks.
  if (size === "3K" && !model.startsWith("doubao-seedream-5-0")) {
    return "3072x3072";
  }

  return size;
}

// Create server instance
const server = new Server(
  {
    name: "doubao-image-mcp",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Define tools
const tools = [
  {
    name: "generate_image",
    description: "Generate images using Doubao AI and save to local file",
    inputSchema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "Text description of the image to generate",
        },
        size: {
          type: "string",
          description: 'Optional output image size. Supported values: "2K", "3K", or "<width>x<height>" (for example "3072x2048").',
        },
      },
      required: ["prompt"],
    },
  },
];

// Handle list tools request
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools,
  };
});

// Handle tool execution
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case "generate_image":
      if (!args || typeof args.prompt !== "string") {
        throw new Error("Invalid arguments for generate_image: prompt is required and must be a string");
      }

      if (args.size !== undefined && typeof args.size !== "string") {
        throw new Error("Invalid arguments for generate_image: size must be a string when provided");
      }

      const normalizedSize = args.size ? normalizeSize(args.size) : DEFAULT_SIZE;

      // Get API key from environment variable
      const apiKey = process.env.DOUBAO_API_KEY;
      if (!apiKey) {
        throw new Error("DOUBAO_API_KEY environment variable is not set");
      }

      try {
        let result: any = null;
        let modelUsed = DEFAULT_MODEL;
        let sizeUsed = normalizedSize;
        let lastModelNotOpenError = "";

        // Try latest model first, then gracefully fallback if the account has not activated it.
        for (const candidateModel of MODEL_CANDIDATES) {
          const candidateSize = resolveSizeForModel(normalizedSize, candidateModel);
          const requestBody = {
            model: candidateModel,
            prompt: args.prompt,
            sequential_image_generation: "disabled",
            response_format: "url",
            size: candidateSize,
            stream: false,
            watermark: false,
          };

          const response = await fetch("https://ark.cn-beijing.volces.com/api/v3/images/generations", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${apiKey}`,
            },
            body: JSON.stringify(requestBody),
          });

          if (response.ok) {
            result = await response.json();
            modelUsed = candidateModel;
            sizeUsed = candidateSize;
            break;
          }

          const errorText = await response.text();
          if (isModelNotOpenError(response.status, errorText)) {
            lastModelNotOpenError = `Doubao API error: ${response.status} ${response.statusText} - ${errorText}`;
            continue;
          }

          throw new Error(`Doubao API error: ${response.status} ${response.statusText} - ${errorText}`);
        }

        if (!result) {
          throw new Error(
            `No available model for this account. Tried: ${MODEL_CANDIDATES.join(", ")}. Last error: ${lastModelNotOpenError}`
          );
        }

        // Check if we have a URL in the response
        if (!result.data || !result.data[0] || !result.data[0].url) {
          throw new Error("No image URL in response from Doubao API");
        }

        const imageUrl = result.data[0].url;

        // Download image
        const imageResponse = await fetch(imageUrl);
        if (!imageResponse.ok) {
          throw new Error(`Failed to download image from ${imageUrl}: ${imageResponse.status} ${imageResponse.statusText}`);
        }

        const imageBuffer = await imageResponse.arrayBuffer();

        // Create images directory if it doesn't exist
        const __filename = fileURLToPath(import.meta.url);
        const __dirname = dirname(__filename);
        const imagesDir = join(__dirname, "..", "generated_images");
        await mkdir(imagesDir, { recursive: true });

        // Generate filename
        const timestamp = Date.now();
        const sanitizedPrompt = args.prompt.substring(0, 50).replace(/[^a-z0-9]/gi, '_').toLowerCase();
        const filename = `${timestamp}_${sanitizedPrompt}.png`;
        const filePath = join(imagesDir, filename);
        const outputSize = typeof result.data[0].size === "string" ? result.data[0].size : "unknown";
        const outputModel = typeof result.model === "string" ? result.model : modelUsed;

        // Save image to file
        await writeFile(filePath, Buffer.from(imageBuffer));

        return {
          content: [
            {
              type: "text",
              text: [
                "Image generated successfully!",
                `Model: ${outputModel}`,
                `Requested size: ${normalizedSize}`,
                `Applied size: ${sizeUsed}`,
                `Returned size: ${outputSize}`,
                `Saved to: ${filePath}`,
              ].join("\n"),
            },
          ],
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text",
              text: `Error generating image: ${errorMessage}`,
            },
          ],
          isError: true,
        };
      }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

// Start server with stdio transport
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("MCP server running on stdio");
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
