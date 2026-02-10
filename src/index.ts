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

      // Get API key from environment variable
      const apiKey = process.env.DOUBAO_API_KEY;
      if (!apiKey) {
        throw new Error("DOUBAO_API_KEY environment variable is not set");
      }

      // Prepare request body with default values
      const requestBody = {
        model: "doubao-seedream-4-5-251128",
        prompt: args.prompt,
        sequential_image_generation: "disabled",
        response_format: "url",
        size: "2K",
        stream: false,
        watermark: false,
      };

      try {
        // Call Doubao API
        const response = await fetch("https://ark.cn-beijing.volces.com/api/v3/images/generations", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`,
          },
          body: JSON.stringify(requestBody),
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Doubao API error: ${response.status} ${response.statusText} - ${errorText}`);
        }

        const result = await response.json();

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

        // Save image to file
        await writeFile(filePath, Buffer.from(imageBuffer));

        return {
          content: [
            {
              type: "text",
              text: `Image generated successfully! Saved to: ${filePath}`,
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