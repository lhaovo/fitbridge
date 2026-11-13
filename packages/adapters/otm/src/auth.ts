import { createHash } from 'node:crypto';
import type { AuthInput, AuthOutput } from '@fitbridge/core';
import { OtmClient } from './client.js';

/** 迈金登录要求密码 MD5 */
export function md5(input: string): string {
  return createHash('md5').update(input, 'utf8').digest('hex');
}

interface OtmLoginData {
  token?: string;
  refresh_token?: string;
  refreshToken?: string;
}

/**
 * 登录：POST /api/login
 * body {account, password: MD5(password)}
 * 响应 data[0].token（JWT）+ data[0].refresh_token
 */
export async function login(
  client: OtmClient,
  input: AuthInput,
): Promise<AuthOutput> {
  if (!input.account || !input.password) {
    throw new Error('迈金登录需要账号与密码');
  }
  const res = await client.request<OtmLoginData[]>('/api/login', '', {
    method: 'POST',
    json: {
      account: input.account,
      password: md5(input.password),
    },
  });
  const env = OtmClient.assertOk<OtmLoginData[]>(res, '迈金登录');
  const first = Array.isArray(env.data) ? env.data[0] : env.data;
  const token = first?.token;
  if (!token) {
    throw new Error('迈金登录未返回 token: ' + (env.message ?? env.msg ?? ''));
  }
  const refreshToken = first?.refresh_token ?? first?.refreshToken;
  return {
    secret: {
      token,
      ...(refreshToken ? { refreshToken } : {}),
      // 明文密码不落库；需要重新登录时由用户重新提供
      account: input.account,
    },
    meta: {
      hasRefreshToken: Boolean(refreshToken),
    },
  };
}

/**
 * 刷新 token：POST /api/token
 * body {token, from: "web", to: "web"}
 */
export async function refresh(
  client: OtmClient,
  secret: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const token = String(secret.token ?? '');
  const res = await client.request<OtmLoginData>('/api/token', '', {
    method: 'POST',
    json: { token, from: 'web', to: 'web' },
  });
  const env = OtmClient.assertOk<OtmLoginData>(res, '迈金 token 刷新');
  const data = env.data;
  const newToken = data?.token ?? token;
  const newRefresh = data?.refresh_token ?? data?.refreshToken;
  return {
    ...secret,
    token: newToken,
    ...(newRefresh ? { refreshToken: newRefresh } : {}),
  };
}

/**
 * 校验 token 有效性：调一次最小列表请求，code==200 即有效。
 */
export async function validate(
  client: OtmClient,
  secret: Record<string, unknown>,
): Promise<boolean> {
  const token = String(secret.token ?? '');
  if (!token) return false;
  try {
    const res = await client.request('/api/otm/ride_record/list', token, {
      method: 'POST',
      json: { page: 1, limit: 1 },
    });
    return res.ok && (res.json?.code ?? 200) === 200;
  } catch {
    return false;
  }
}
