import { randomUUID } from 'node:crypto';
import type { AuthInput, AuthOutput } from '@fitbridge/core';
import { MYWHOOSH_LOGIN_URL, MyWhooshClient } from './client.js';

interface MyWhooshLoginResponse {
  Success?: boolean;
  AccessToken?: string;
  WhooshId?: string;
  RefreshToken?: string;
  Message?: string;
}

/**
 * 登录：POST https://services.mywhoosh.com/http-service/api/login
 *
 * body: {Username, Password, Platform:"Android", Action:1001,
 *        CorrelationId(uuid), DeviceId(uuid), Authorization:""}
 * 响应: {Success, AccessToken, WhooshId, RefreshToken, Message?}
 */
export async function login(
  client: MyWhooshClient,
  input: AuthInput,
): Promise<AuthOutput> {
  if (!input.account || !input.password) {
    throw new Error('MyWhoosh 登录需要账号与密码');
  }

  const res = await client.http.request<MyWhooshLoginResponse>(
    MYWHOOSH_LOGIN_URL,
    {
      method: 'POST',
      json: {
        Username: input.account,
        Password: input.password,
        Platform: 'Android',
        Action: 1001,
        // CorrelationId 每次请求都换；DeviceId 必须稳定（token 可能与设备绑定）
        CorrelationId: randomUUID(),
        DeviceId: input.deviceId ?? randomUUID(),
        Authorization: '',
      },
    },
  );

  if (!res.ok) {
    throw new Error('MyWhoosh 登录 HTTP ' + res.status);
  }
  const body = res.json ?? {};
  if (!body.Success) {
    throw new Error('MyWhoosh 登录失败: ' + (body.Message ?? '未知原因'));
  }
  if (!body.AccessToken) {
    throw new Error('MyWhoosh 登录未返回 AccessToken');
  }

  return {
    secret: {
      accessToken: body.AccessToken,
      ...(body.RefreshToken ? { refreshToken: body.RefreshToken } : {}),
      account: input.account,
    },
    meta: {
      whooshId: body.WhooshId ?? '',
      hasRefreshToken: Boolean(body.RefreshToken),
    },
  };
}

/** 校验：调一次最小列表请求，HTTP 200 即有效 */
export async function validate(
  client: MyWhooshClient,
  secret: Record<string, unknown>,
  meta: Record<string, unknown> | undefined,
): Promise<boolean> {
  const token = String(secret.accessToken ?? '');
  if (!token) return false;
  try {
    const res = await client.api('/activities', token, {
      page: 1,
      limit: 1,
      sortDate: 'DESC',
    });
    return res.ok;
  } catch {
    return false;
  }
}
