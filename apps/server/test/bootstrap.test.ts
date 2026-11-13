import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../src/lib/db.js';
import { bootstrap, checkLogin } from '../src/lib/bootstrap.js';
import { makePasswordRecord, verifyPassword } from '../src/lib/crypto.js';
import { DEFAULT_USER_ID } from '../src/lib/constants.js';
import { runMigrations } from '../src/migrate.js';

let dataDir: string;
let db: Database;

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'fb-boot-'));
  db = new Database(join(dataDir, 'test.db'));
  await db.connect();
  await runMigrations(db);
});

afterEach(async () => {
  await db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('首次启动引导', () => {
  it('未提供密码时生成随机密码并写入 DB', async () => {
    const r = await bootstrap(db, undefined);
    expect(r.generatedPassword).toBeTruthy();
    expect((r.generatedPassword ?? '').length).toBeGreaterThan(8);
    expect(checkLogin(db, r.generatedPassword!)).toBe(true);
  });

  it('再次启动不会重新生成密码', async () => {
    const first = await bootstrap(db, undefined);
    const second = await bootstrap(db, undefined);
    expect(second.generatedPassword).toBeUndefined();
    expect(checkLogin(db, first.generatedPassword!)).toBe(true);
  });

  it('提供了环境变量密码时用它且不打印', async () => {
    const r = await bootstrap(db, 'from-env');
    expect(r.generatedPassword).toBeUndefined();
    expect(checkLogin(db, 'from-env')).toBe(true);
    expect(checkLogin(db, 'wrong')).toBe(false);
  });

  it('错误密码校验失败', async () => {
    await bootstrap(db, 'correct');
    expect(checkLogin(db, 'correct')).toBe(true);
    expect(checkLogin(db, 'nope')).toBe(false);
  });

  it('口令记录是 salt:hash 格式，不含明文', () => {
    const rec = makePasswordRecord('my-password');
    expect(rec).toMatch(/^[A-Za-z0-9_-]+:[0-9a-f]{128}$/);
    expect(rec).not.toContain('my-password');
    expect(verifyPassword('my-password', rec)).toBe(true);
    expect(verifyPassword('other', rec)).toBe(false);
  });

  it('默认用户存在', () => {
    const u = db.one<{ id: string }>('SELECT id FROM users WHERE id = ?', [
      DEFAULT_USER_ID,
    ]);
    expect(u?.id).toBe(DEFAULT_USER_ID);
  });
});
