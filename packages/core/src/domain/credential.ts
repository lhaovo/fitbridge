import { createHash } from 'node:crypto';
import type { Credential, PlatformAdapter } from '../ports/adapter.js';

/**
 * 凭证的登录信息（与平台 secret 一起加密存储）。
 *
 * 为什么存密码：平台 token 过期后需要重新登录。
 * 如果不存，服务端就卡死了，只能让用户回来手输 —— 这对"无人值守的服务器同步"不可接受。
 *
 * 安全说明：账号密码与 token 存在**同一个** AES-256-GCM 密文里，
 * 用的是同一个 master.key。它没有引入新的攻击面：
 * 能拿到密文的人本来就同时持有 master.key（同一个数据目录）。
 */
export interface LoginCredentials {
  account?: string;
  password?: string;
}

/**
 * 派生的稳定设备标识。
 *
 * 用途：MyWhoosh 这类 App 的登录请求带 DeviceId，部分实现会把 token 绑定设备 ID。
 * 在服务器上每次登录都换 DeviceId 容易被判定为异常客户端。
 *
 * 派生方式：sha256(masterKey + platformId + account) → 取前 32 hex → 拼成 UUID 形态。
 * 因为 masterKey 每个安装实例唯一，所以：
 *   - 同一台机器 + 同一账号 → 每次登录都是同一个 DeviceId
 *   - 不同机器 / 不同账号 → 不同 DeviceId
 */
export function deriveDeviceId(
  masterKey: Buffer,
  platformId: string,
  account?: string,
): string {
  const h = createHash('sha256')
    .update(masterKey)
    .update('\u0000')
    .update(platformId)
    .update('\u0000')
    .update(account ?? '')
    .digest('hex')
    .slice(0, 32);
  return (
    h.slice(0, 8) +
    '-' +
    h.slice(8, 12) +
    '-' +
    h.slice(12, 16) +
    '-' +
    h.slice(16, 20) +
    '-' +
    h.slice(20, 32)
  );
}

/**
 * 重新登录：用保存的账号密码换一个全新的平台 token。
 *
 * 引擎在遇到 AUTH_EXPIRED 时调用一次，成功后重试原请求。
 */
export async function relogin(
  adapter: PlatformAdapter,
  cred: Credential,
): Promise<Credential> {
  const account = cred.credentials?.account;
  const password = cred.credentials?.password;
  if (!account || !password) {
    throw new Error(
      '平台 ' +
        adapter.manifest.id +
        ' 凭证已过期，但没有保存账号密码用于自动重新登录',
    );
  }
  const out = await adapter.auth({ account, password });
  return {
    ...cred,
    secret: out.secret,
    meta: { ...(cred.meta ?? {}), ...(out.meta ?? {}) },
    expiresAt: out.expiresAt,
  };
}
