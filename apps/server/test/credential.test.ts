import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../src/lib/db.js';
import { CredentialRepository } from '../src/lib/credential-repository.js';
import { runMigrations } from '../src/migrate.js';
import { deriveDeviceId, relogin } from '@fitbridge/core';
import type { PlatformAdapter } from '@fitbridge/core';

let dataDir: string;
let db: Database;
const KEY = Buffer.alloc(32, 9);

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'fb-cred-'));
  db = new Database(join(dataDir, 'test.db'));
  await db.connect();
  await runMigrations(db);
});

afterEach(async () => {
  await db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('稳定设备标识', () => {
  it('同一密钥+平台+账号 → 每次相同', () => {
    const a = deriveDeviceId(KEY, 'mywhoosh', 'demo');
    const b = deriveDeviceId(KEY, 'mywhoosh', 'demo');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('账号/平台/密钥不同 → 不同', () => {
    const base = deriveDeviceId(KEY, 'mywhoosh', 'demo');
    expect(deriveDeviceId(KEY, 'mywhoosh', 'other')).not.toBe(base);
    expect(deriveDeviceId(KEY, 'otm', 'demo')).not.toBe(base);
    expect(deriveDeviceId(Buffer.alloc(32, 1), 'mywhoosh', 'demo')).not.toBe(base);
  });
});

describe('凭证仓储', () => {
  it('保存后能取回 secret 与账号密码', async () => {
    const repo = new CredentialRepository(db, KEY, true);
    const id = await repo.create({
      platformId: 'otm',
      authType: 'password',
      secret: { token: 'jwt-abc' },
      meta: { hasRefreshToken: true },
      account: 'demo',
      password: 'p@ssw0rd',
    });

    const cred = repo.get(id)!;
    expect(cred.secret.token).toBe('jwt-abc');
    expect(cred.credentials?.account).toBe('demo');
    expect(cred.credentials?.password).toBe('p@ssw0rd');
    expect(cred.meta?.hasRefreshToken).toBe(true);
  });

  it('列表不泄露任何凭证内容', async () => {
    const repo = new CredentialRepository(db, KEY, true);
    await repo.create({
      platformId: 'otm',
      authType: 'password',
      secret: { token: 'jwt-abc' },
      account: 'demo',
      password: 'p@ssw0rd',
    });
    const list = repo.list();
    const dumped = JSON.stringify(list);
    expect(dumped).not.toContain('jwt-abc');
    expect(dumped).not.toContain('p@ssw0rd');
    expect(list[0]!.platformId).toBe('otm');
  });

  it('关闭密码存储时不保存账号密码', async () => {
    const repo = new CredentialRepository(db, KEY, false);
    const id = await repo.create({
      platformId: 'otm',
      authType: 'password',
      secret: { token: 'jwt' },
      account: 'demo',
      password: 'p@ss',
    });
    const cred = repo.get(id)!;
    expect(cred.credentials?.password).toBeUndefined();
    expect(cred.secret.token).toBe('jwt');
  });

  it('数据库里存的是密文，明文搜不到', async () => {
    const repo = new CredentialRepository(db, KEY, true);
    await repo.create({
      platformId: 'otm',
      authType: 'password',
      secret: { token: 'jwt-abc' },
      account: 'demo',
      password: 'p@ssw0rd',
    });
    const rows = db.query<{ secret_cipher: Buffer }>(
      'SELECT secret_cipher FROM credentials',
    );
    const blob = rows[0]!.secret_cipher.toString('utf8');
    expect(blob).not.toContain('jwt-abc');
    expect(blob).not.toContain('p@ssw0rd');
  });

  it('更新 secret 后旧值不再可用', async () => {
    const repo = new CredentialRepository(db, KEY, true);
    const id = await repo.create({
      platformId: 'otm',
      authType: 'password',
      secret: { token: 'old' },
      account: 'demo',
      password: 'pw',
    });
    await repo.updateSecret(id, { token: 'new' });
    const cred = repo.get(id)!;
    expect(cred.secret.token).toBe('new');
    // 账号密码在更新后仍然保留
    expect(cred.credentials?.password).toBe('pw');
  });

  it('按平台取凭证', async () => {
    const repo = new CredentialRepository(db, KEY, true);
    await repo.create({
      platformId: 'mywhoosh',
      authType: 'password',
      secret: { accessToken: 'mw' },
      account: 'demo',
      password: 'pw',
    });
    const cred = repo.getByPlatform('mywhoosh');
    expect(cred?.secret.accessToken).toBe('mw');
    expect(repo.getByPlatform('otm')).toBeUndefined();
  });
});

describe('自动重新登录', () => {
  const fakeAdapter: PlatformAdapter = {
    manifest: {
      id: 'otm',
      displayName: 'OTM',
      shortCode: 'mg',
      vendor: 'x',
      authType: 'password',
      access: 'reverse-engineered',
      capabilities: {
        download: true,
        upload: true,
        uploadFormats: ['fit'],
        deleteRemote: false,
        webhook: false,
        incremental: false,
      },
      coordinateSystem: 'gcj02',
      rateLimit: { requestsPerMinute: 20 },
      uploadAsync: true,
      riskLevel: 'medium',
    },
    async auth(input) {
      if (!input.account || !input.password) throw new Error('缺少账号密码');
      return { secret: { token: 'fresh-' + input.account } };
    },
    async validate() {
      return { ok: true, checkedAt: new Date().toISOString() };
    },
    async listActivities() {
      return { items: [], hasMore: false };
    },
    async downloadFile() {
      throw new Error('not used');
    },
  };

  it('用保存的账号密码换新 token', async () => {
    const cred = {
      id: 'c1',
      userId: 'default',
      platformId: 'otm',
      secret: { token: 'expired' },
      credentials: { account: 'demo', password: 'pw' },
    };
    const fresh = await relogin(fakeAdapter, cred);
    expect(fresh.secret.token).toBe('fresh-demo');
  });

  it('没有保存密码时给出明确错误', async () => {
    const cred = {
      id: 'c1',
      userId: 'default',
      platformId: 'otm',
      secret: { token: 'expired' },
    };
    await expect(relogin(fakeAdapter, cred)).rejects.toThrow(/没有保存账号密码/);
  });
});
