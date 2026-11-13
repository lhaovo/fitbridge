import { randomBytes } from 'node:crypto';
import { loadConfig } from '../config.js';
import { Database } from '../lib/db.js';
import { makePasswordRecord } from '../lib/crypto.js';
import { DEFAULT_USER_ID } from '../lib/constants.js';
import { runMigrations } from '../migrate.js';

/**
 * 重置单用户管理员密码。
 *
 *   node apps/server/dist/cli/reset-password.js          # 随机生成并打印
 *   node apps/server/dist/cli/reset-password.js <新密码>  # 指定密码
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const db = new Database(config.databaseFile);
  const ok = await db.connect();
  if (!ok) {
    console.error('数据库打开失败');
    process.exit(1);
  }
  await runMigrations(db);

  const arg = process.argv[2];
  const password = arg ?? randomBytes(12).toString('base64url');
  db.run('UPDATE users SET password_hash = ? WHERE id = ?', [
    makePasswordRecord(password),
    DEFAULT_USER_ID,
  ]);

  console.log('新管理员密码：' + password);
  await db.close();
}

main().catch((err) => {
  console.error('重置失败', err);
  process.exit(1);
});
