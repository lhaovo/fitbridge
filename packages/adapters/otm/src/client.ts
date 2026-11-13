import { HttpClient, type HttpResponse } from '@fitbridge/core';

export const OTM_BASE = 'https://otm.onelap.cn';

export interface OtmEnvelope<T = unknown> {
  code?: number;
  message?: string;
  msg?: string;
  data?: T;
}

/**
 * 顽鹿 OTM 客户端。
 *
 * 鉴权：登录返回 JWT，之后所有请求带 Authorization 头（不带 Bearer 前缀）。
 * 浏览器端请求还会带 Origin/Referer，上传接口尤其需要。
 */
export class OtmClient {
  readonly http: HttpClient;

  constructor() {
    this.http = new HttpClient({
      baseUrl: OTM_BASE,
      headers: {
        Origin: OTM_BASE,
        Referer: OTM_BASE + '/',
      },
    });
  }

  /** 带 token 的请求 */
  async request<T = unknown>(
    path: string,
    token: string,
    opts: {
      method?: 'GET' | 'POST';
      json?: unknown;
      form?: FormData;
      timeoutMs?: number;
    } = {},
  ): Promise<HttpResponse<OtmEnvelope<T>>> {
    const res = await this.http.request<OtmEnvelope<T>>(path, {
      method: opts.method ?? 'GET',
      json: opts.json,
      form: opts.form,
      timeoutMs: opts.timeoutMs,
      headers: {
        Authorization: token,
        ...(opts.form ? {} : { 'Content-Type': 'application/json; charset=utf-8' }),
      },
    });
    return res;
  }

  /** 平台业务码检查：HTTP 200 但 code != 200 也算失败 */
  static assertOk<T = unknown>(
    res: HttpResponse<OtmEnvelope<T>>,
    what: string,
  ): OtmEnvelope<T> {
    const env = (res.json ?? {}) as OtmEnvelope<T>;
    if (!res.ok) {
      throw new Error(what + ' HTTP ' + res.status);
    }
    if (typeof env.code === 'number' && env.code !== 200) {
      throw new Error(
        what +
          ' 失败: code=' +
          env.code +
          ' ' +
          (env.message ?? env.msg ?? ''),
      );
    }
    return env;
  }
}
