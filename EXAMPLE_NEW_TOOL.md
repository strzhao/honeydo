# Adding a New Tool to the MCP Server

## Step 1: Define the Tool

Add a new tool definition to the `tools` array in `src/index.ts`:

```typescript
const tools = [
  // ... existing tools ...
  {
    name: "your_tool_name",
    description: "Description of what your tool does",
    inputSchema: {
      type: "object",
      properties: {
        parameter1: {
          type: "string", // or "number", "boolean", "array", "object"
          description: "Description of parameter1",
        },
        parameter2: {
          type: "number",
          description: "Description of parameter2",
        },
      },
      required: ["parameter1"], // List required parameters
    },
  },
];
```

## Step 2: Implement Tool Logic

Add a new case in the `switch` statement in the `CallToolRequestSchema` handler:

```typescript
case "your_tool_name":
  if (!args || typeof args.parameter1 !== "string") {
    throw new Error("Invalid arguments for your_tool_name");
  }

  // Your tool logic here
  const result = `Processed: ${args.parameter1}`;

  return {
    content: [
      {
        type: "text",
        text: result,
      },
    ],
  };
```

## Step 3: Rebuild and Restart

```bash
npm run build
npm start
```

Or for development:
```bash
npm run dev
```

## Example: Weather Tool

Here's a complete example of a weather tool that takes a city name:

```typescript
// In tools array:
{
  name: "get_weather",
  description: "Get weather information for a city",
  inputSchema: {
    type: "object",
    properties: {
      city: {
        type: "string",
        description: "City name",
      },
      units: {
        type: "string",
        description: "Temperature units: 'celsius' or 'fahrenheit'",
        enum: ["celsius", "fahrenheit"],
        default: "celsius",
      },
    },
    required: ["city"],
  },
}

// In switch statement:
case "get_weather":
  if (!args || typeof args.city !== "string") {
    throw new Error("Invalid arguments for get_weather");
  }

  const units = args.units || "celsius";
  // In a real implementation, you would call a weather API here
  const weatherInfo = `Weather in ${args.city}: Sunny, 25°${units === "celsius" ? "C" : "F"}`;

  return {
    content: [
      {
        type: "text",
        text: weatherInfo,
      },
    ],
  };
```

## Tool Response Formats

You can return different types of content:

```typescript
// Text response
return {
  content: [
    {
      type: "text",
      text: "Your result here",
    },
  ],
};

// Multiple content items
return {
  content: [
    {
      type: "text",
      text: "First piece of information",
    },
    {
      type: "text",
      text: "Second piece of information",
    },
  ],
};

// Error handling
try {
  // Your logic
} catch (error) {
  return {
    content: [
      {
        type: "text",
        text: `Error: ${error.message}`,
      },
    ],
    isError: true,
  };
}
```