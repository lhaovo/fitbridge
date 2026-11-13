/**
 * 极简 HTTP 客户端（不引第三方库）。
 *
 * 职责边界：
 * - 只做：超时、JSON/二进制请求、状态码 → 统一错误、敏感字段脱敏
 * - 不做：重试、退避、限流、熔断（这些属于 Policy 层，M0 之后再补）
 */

export interface HttpRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  /** JSON 请求体 */
  json?: unknown;
  /** 二进制请求体 */
  body?: Buffer | Uint8Array;
  /** multipart 表单 */
  form?: FormData;
  timeoutMs?: number;
  redirect?: 'follow' | 'manual';
}

export interface HttpResponse<T = unknown> {
  status: number;
  ok: boolean;
  headers: Headers;
  json: T;
  /** 二进制响应（当 requestBytes 使用） */
  bytes?: Buffer;
}

const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** 敏感字段名（脱敏用） */
const SENSITIVE_KEYS = [
  'password',
  'token',
  'accesstoken',
  'refreshtoken',
  'authorization',
  'secret',
  'clientsecret',
  'cookie',
  'set-cookie',
];

/** 深度脱敏任意对象 */
export function redact<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((v) => redact(v)) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEYS.includes(k.toLowerCase()) ? '***' : redact(v);
    }
    return out as T;
  }
  return value;
}

export class HttpClient {
  constructor(
    private readonly defaults: {
      baseUrl?: string;
      headers?: Record<string, string>;
      timeoutMs?: number;
    } = {},
  ) {}

  private url(path: string): string {
    if (/^https?:\/\//.test(path)) return path;
    const base = this.defaults.baseUrl ?? '';
    return base + (path.startsWith('/') ? path : `/${path}`);
  }

  private buildHeaders(opts: HttpRequestOptions): Headers {
    const h = new Headers({
      'User-Agent': DEFAULT_UA,
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      ...(this.defaults.headers ?? {}),
      ...(opts.headers ?? {}),
    });
    if (opts.json !== undefined) {
      h.set('Content-Type', 'application/json; charset=utf-8');
    }
    return h;
  }

  /** 发起请求并解析 JSON */
  async request<T = unknown>(
    path: string,
    opts: HttpRequestOptions = {},
  ): Promise<HttpResponse<T>> {
    const res = await this.raw(path, opts);
    const text = await res.text();
    let json: unknown = undefined;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }
    return {
      status: res.status,
      ok: res.ok,
      headers: res.headers,
      json: (json ?? {}) as T,
    };
  }

  /** 发起请求并读取二进制 */
  async requestBytes(
    path: string,
    opts: HttpRequestOptions = {},
  ): Promise<HttpResponse<never>> {
    const res = await this.raw(path, opts);
    const buf = Buffer.from(await res.arrayBuffer());
    return {
      status: res.status,
      ok: res.ok,
      headers: res.headers,
      json: undefined as never,
      bytes: buf,
    };
  }

  private async raw(
    path: string,
    opts: HttpRequestOptions,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      opts.timeoutMs ?? this.defaults.timeoutMs ?? DEFAULT_TIMEOUT,
    );
    try {
      let body: RequestInit['body'];
      if (opts.form) {
        body = opts.form;
      } else if (opts.json !== undefined) {
        body = JSON.stringify(opts.json);
      } else if (opts.body) {
        body = opts.body as unknown as RequestInit['body'];
      }
      return await fetch(this.url(path), {
        method: opts.method ?? 'GET',
        headers: this.buildHeaders(opts),
        body,
        signal: controller.signal,
        redirect: opts.redirect ?? 'follow',
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}
