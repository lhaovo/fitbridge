import { HttpClient } from '@fitbridge/core';

export const MYWHOOSH_LOGIN_URL =
  'https://services.mywhoosh.com/http-service/api/login';
export const MYWHOOSH_API_BASE =
  'https://service14.mywhoosh.com/v2/rider/profile';

/** MyWhoosh 客户端官方 App 的 UA */
const MYWHOOSH_UA = 'MyWhoosh-Python-Client/1.0';

export class MyWhooshClient {
  readonly http = new HttpClient({
    headers: {
      'User-Agent': MYWHOOSH_UA,
      'Content-Type': 'application/json; charset=utf-8',
    },
  });

  /** Bearer 鉴权的 API 请求 */
  async api<T = unknown>(
    path: string,
    token: string,
    body: unknown,
  ): Promise<{ status: number; ok: boolean; json: T }> {
    const res = await this.http.request<T>(MYWHOOSH_API_BASE + path, {
      method: 'POST',
      json: body,
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json; charset=utf-8',
      },
    });
    return { status: res.status, ok: res.ok, json: res.json };
  }
}
