import { readFileSync } from 'node:fs';
import { config } from './config.js';

/* ------------------------------------------------------------------ */
/*  类型                                                               */
/* ------------------------------------------------------------------ */

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string | VisionContent[];
}

export interface VisionContent {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: { url: string; detail?: string };
}

interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  max_tokens: number;
  temperature: number;
  stream: false;
}

/* ------------------------------------------------------------------ */
/*  通用 fetch 封装                                                    */
/* ------------------------------------------------------------------ */

async function apiFetch(
  path: string,
  options: { method?: string; body?: unknown; signal?: AbortSignal },
  timeoutMs: number = config.defaults.timeout,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const url = `${config.apiUrl}${path}`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.apiKey}`,
  };

  const init: Record<string, unknown> = { headers, signal: controller.signal };
  if (options.method) init.method = options.method;
  if (options.body !== undefined) {
    init.body = JSON.stringify(options.body);
  }

  try {
    const res = await fetch(url, init as RequestInit);
    clearTimeout(timer);
    return res;
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error(`请求超时 (${timeoutMs / 1000}s)`);
    }
    throw err;
  }
}

/* ------------------------------------------------------------------ */
/*  chatCompletions — 文本对话                                         */
/* ------------------------------------------------------------------ */

export async function chatCompletions(
  prompt: string,
  options: {
    maxTokens?: number;
    model?: string;
    temperature?: number;
  } = {},
): Promise<Record<string, unknown>> {
  const body: ChatCompletionRequest = {
    model: options.model ?? config.model,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: options.maxTokens ?? config.defaults.maxTokens,
    temperature: options.temperature ?? config.defaults.temperature,
    stream: false,
  };

  const res = await apiFetch('/v1/chat/completions', { method: 'POST', body });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let msg = `API 错误 (${res.status})`;
    try {
      const errJson = JSON.parse(text);
      if (errJson.error?.message) msg += `: ${errJson.error.message}`;
      else if (errJson.message) msg += `: ${errJson.message}`;
      else msg += `: ${text.slice(0, 200)}`;
    } catch {
      if (text) msg += `: ${text.slice(0, 200)}`;
    }
    throw new Error(msg);
  }

  return (await res.json()) as Record<string, unknown>;
}

/* ------------------------------------------------------------------ */
/*  visionCompletions — 图片识别                                       */
/* ------------------------------------------------------------------ */

async function imageToBase64(input: string): Promise<{ mime: string; data: string }> {
  // 检测是否是 URL
  if (/^https?:\/\//i.test(input)) {
    const res = await fetch(input);
    if (!res.ok) throw new Error(`下载图片失败 (${res.status})`);
    const contentType = res.headers.get('content-type') || 'image/png';
    const buffer = Buffer.from(await res.arrayBuffer());
    const mime = contentType.split(';')[0].trim();
    return { mime, data: buffer.toString('base64') };
  }

  // 本地文件
  const buffer = readFileSync(input);
  const ext = input.split('.').pop()?.toLowerCase();
  const mimeMap: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp',
  };
  const mime = mimeMap[ext ?? ''] ?? 'image/png';
  return { mime, data: buffer.toString('base64') };
}

export async function visionCompletions(
  imageInput: string,
  prompt: string,
  options: {
    maxTokens?: number;
    model?: string;
  } = {},
): Promise<Record<string, unknown>> {
  const { mime, data } = await imageToBase64(imageInput);
  const dataUri = `data:${mime};base64,${data}`;

  const content: VisionContent[] = [
    { type: 'text', text: prompt },
    { type: 'image_url', image_url: { url: dataUri } },
  ];

  const body: ChatCompletionRequest = {
    model: options.model ?? config.model,
    messages: [{ role: 'user', content }],
    max_tokens: options.maxTokens ?? config.defaults.visionMaxTokens,
    temperature: config.defaults.temperature,
    stream: false,
  };

  const res = await apiFetch('/v1/chat/completions', { method: 'POST', body });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let msg = `API 错误 (${res.status})`;
    try {
      const errJson = JSON.parse(text);
      if (errJson.error?.message) msg += `: ${errJson.error.message}`;
      else if (errJson.message) msg += `: ${errJson.message}`;
      else msg += `: ${text.slice(0, 200)}`;
    } catch {
      if (text) msg += `: ${text.slice(0, 200)}`;
    }
    throw new Error(msg);
  }

  return (await res.json()) as Record<string, unknown>;
}

/* ------------------------------------------------------------------ */
/*  healthCheck — 服务健康检查                                          */
/* ------------------------------------------------------------------ */

export interface HealthStatus {
  ok: boolean;
  health?: Record<string, unknown>;
  error?: string;
}

export interface ModelItem {
  id: string;
  object: string;
  created: number;
  owned_by: string;
}

export interface ModelsResult {
  ok: boolean;
  models?: ModelItem[];
  error?: string;
}

export async function healthCheck(): Promise<{ health: HealthStatus; models: ModelsResult }> {
  let health: HealthStatus = { ok: false, error: '未发起请求' };
  let models: ModelsResult = { ok: false, error: '未发起请求' };

  // GET /health
  try {
    const res = await apiFetch('/health', { method: 'GET' }, 10_000);
    if (res.ok) {
      health = { ok: true, health: (await res.json().catch(() => ({}))) as Record<string, unknown> };
    } else {
      health = { ok: false, error: `HTTP ${res.status}` };
    }
  } catch (err) {
    health = { ok: false, error: (err as Error).message };
  }

  // GET /v1/models
  try {
    const res = await apiFetch('/v1/models', { method: 'GET' }, 10_000);
    if (res.ok) {
      const data = (await res.json()) as { data?: ModelItem[] };
      models = { ok: true, models: data.data || [] };
    } else {
      models = { ok: false, error: `HTTP ${res.status}` };
    }
  } catch (err) {
    models = { ok: false, error: (err as Error).message };
  }

  return { health, models };
}
