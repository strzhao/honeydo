export const config = {
  apiUrl: process.env.QWEN_API_URL || 'http://127.0.0.1:8001',
  apiKey: process.env.QWEN_API_KEY || 'qwen-local-key',
  model: process.env.QWEN_MODEL || 'qwen3.6-35b',
  defaults: {
    maxTokens: 1000,
    visionMaxTokens: 3000,
    temperature: 0.7,
    timeout: 120_000,
  },
} as const;
