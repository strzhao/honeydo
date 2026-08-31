export const config = {
  apiUrl: process.env.QWEN_API_URL || 'http://127.0.0.1:8001',
  apiKey: process.env.QWEN_API_KEY || 'qwen-local-key',
  model: process.env.QWEN_MODEL || 'qwen3.6-35b',
  defaults: {
    maxTokens: 1000,
    visionMaxTokens: 3000,
    temperature: 0.7,
    // QWEN_TIMEOUT_MS 可覆盖：vision 长输出（-t 10000 实测 90-150s+）会撞默认 120s
    timeout: Number(process.env.QWEN_TIMEOUT_MS) || 120_000,
  },
} as const;
