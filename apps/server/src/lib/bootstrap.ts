import { randomBytes } from 'node:crypto';
import type { Database } from './db.js';
import { makePasswordRecord, verifyPassword } from './crypto.js';
import { DEFAULT_USER_ID } from './constants.js';

/**
 * 首次启动引导。
 *
 * 单用户模式（决策 D2）：
 * - 数据库里只有一个固定用户
 * - 密码优先用环境变量 FITBRIDGE_PASSWORD；未设置则生成随机密码并写入 DB
 * - 生成的明文密码只在首次启动时打印一次（之后只能通过 CLI 重置）
 */
export interface BootstrapResult {
  /** 本次启动是否新生成了密码（需要打印） */
  generatedPassword?: string;
}

export async function bootstrap(
  db: Database,
  envPassword: string | undefined,
): Promise<BootstrapResult> {
  const user = db.one<{ id: string; password_hash: string }>(
    'SELECT id, password_hash FROM users WHERE id = ?',
    [DEFAULT_USER_ID],
  );

  if (!user) {
    throw new Error('默认用户不存在，请先执行迁移');
  }

  // 已设置过密码（env-managed 是初始占位）
  if (user.password_hash && user.password_hash !== 'env-managed') {
    return {};
  }

  const password = envPassword ?? randomBytes(12).toString('base64url');
  db.run('UPDATE users SET password_hash = ? WHERE id = ?', [
    makePasswordRecord(password),
    DEFAULT_USER_ID,
  ]);

  return envPassword ? {} : { generatedPassword: password };
}

/** 校验登录密码 */
export function checkLogin(
  db: Database,
  password: string,
): boolean {
  const user = db.one<{ password_hash: string }>(
    'SELECT password_hash FROM users WHERE id = ?',
    [DEFAULT_USER_ID],
  );
  if (!user) return false;
  return verifyPassword(password, user.password_hash);
}
