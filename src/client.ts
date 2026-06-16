/**
 * Minimal MiniMax API client: fetch + Bearer auth + base URL.
 * Zero runtime deps. `post` sends JSON; `postMultipart` sends a FormData
 * (fetch sets the multipart boundary — do not set Content-Type manually).
 */

export interface ClientOptions {
  apiKey: string;
  host: string;
}

export interface MiniMaxClient {
  post<T = unknown>(path: string, data: unknown): Promise<T>;
  postMultipart<T = unknown>(path: string, formData: FormData): Promise<T>;
}

export class MiniMaxApiError extends Error {
  constructor(
    public status: number,
    public statusText: string,
    public body: unknown,
  ) {
    const bodyText =
      typeof body === "string" ? body : JSON.stringify(body);
    super(`MiniMax API error: ${status} ${statusText} - ${bodyText}`);
    this.name = "MiniMaxApiError";
  }
}

export function createClient(opts: ClientOptions): MiniMaxClient {
  const base = opts.host.replace(/\/+$/, "");

  async function request<T>(path: string, init: RequestInit): Promise<T> {
    const res = await fetch(`${base}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        ...(init.headers || {}),
      },
    });
    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : "";
    } catch {
      body = text;
    }
    if (!res.ok) {
      throw new MiniMaxApiError(res.status, res.statusText, body);
    }
    return body as T;
  }

  return {
    post(path, data) {
      return request(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
    },
    postMultipart(path, formData) {
      return request(path, { method: "POST", body: formData });
    },
  };
}
