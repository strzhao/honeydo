/**
 * 从 API response 提取文本 content。
 * 优先取 message.content；若为空则 fallback 到 reasoning_content（thinking 模型）。
 */
export function extractContent(data: Record<string, unknown>): string {
  try {
    const choices = data.choices as Array<Record<string, unknown>>;
    if (!choices || !choices[0]) return '[无响应内容]';

    const message = choices[0].message as Record<string, string> | undefined;
    if (!message) return '[无 message 字段]';

    // 优先取 content，可能为空字符串
    if (message.content && message.content.trim()) {
      return message.content;
    }

    // fallback: thinking 模型的推理链
    const reasoning = message.reasoning_content as string | undefined;
    if (reasoning && reasoning.trim()) {
      return `[推理链]\n${reasoning}`;
    }

    // 最后尝试全量转为字符串
    return JSON.stringify(message, null, 2);
  } catch {
    return '[解析响应失败]';
  }
}

/** JSON.stringify 美化 */
export function formatJson(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

/** 错误信息友好化 */
export function formatError(err: unknown): string {
  if (err instanceof Error) {
    const msg = err.message;

    // 网络错误 / 连接拒绝
    if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) {
      return `无法连接到 Qwen 服务（${
        process.env.QWEN_API_URL || 'http://127.0.0.1:8001'
      }）。请确认服务已启动。`;
    }

    // 超时
    if (msg.includes('timeout') || msg.includes('ETIMEDOUT') || msg.includes('aborted')) {
      return '请求超时。vision 模式可能需要较长时间，建议检查服务状态。';
    }

    // DNS / 域名解析
    if (msg.includes('ENOTFOUND') || msg.includes('getaddrinfo')) {
      return `无法解析 Qwen 服务地址。请检查 QWEN_API_URL 环境变量。`;
    }

    return `错误: ${msg}`;
  }

  return `未知错误: ${String(err)}`;
}
