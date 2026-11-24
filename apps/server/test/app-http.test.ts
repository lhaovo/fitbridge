import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { Database } from '../src/lib/db.js';
import { CredentialRepository } from '../src/lib/credential-repository.js';
import { RiskGuard } from '../src/lib/risk-guard.js';
import { SqliteActivityStore } from '../src/lib/repositories.js';
import { runMigrations } from '../src/migrate.js';
import { DEFAULT_USER_ID } from '../src/lib/constants.js';
import type { ActivityStore, EventSink, SyncEvent } from '@fitbridge/core';
import { registerBuiltinPlatforms } from '../src/lib/platforms.js';

let dataDir: string;
let db: Database;
let app: FastifyInstance;

const masterKey = Buffer.alloc(32, 7);

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'fb-app-'));
  db = new Database(join(dataDir, 'test.db'));
  await db.connect();
  await runMigrations(db);
  registerBuiltinPlatforms();

  const events: SyncEvent[] = [];
  const eventSink: EventSink = {
    async emit(_userId, e) {
      events.push(e as SyncEvent);
    },
  };
  const store = new SqliteActivityStore(db);

  app = await buildApp({
    config: {
      host: '127.0.0.1',
      port: 0,
      dataDir,
      databaseFile: join(dataDir, 'test.db'),
      blobDir: join(dataDir, 'blobs'),
      masterKeyFile: join(dataDir, 'master.key'),
      adminPassword: 'pw',
      masterKey,
      fileRetentionDays: 90,
      derivedTtlDays: 7,
      maxItemsPerRun: 50,
      storePlatformPassword: true,
    },
    db,
    credentialRepo: new CredentialRepository(db, masterKey, true),
    riskGuard: new RiskGuard(db, { maxCooldownMin: 60 }),
    store: store as unknown as ActivityStore,
    events: eventSink,
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  await db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('HTTP 层', () => {
  it('空 body + application/json 不再被判 400', async () => {
    // 这类「本来就没有请求体」的 POST，客户端很容易带上 JSON content-type
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/sync/run',
      headers: { 'content-type': 'application/json' },
      payload: '',
    });
    // 空 body 被解析成 {}，请求会走到鉴权/业务逻辑（而不是 400）
    expect(res.statusCode).not.toBe(400);
  });

  it('非法 JSON 仍然是 400', async () => {
    // 用公开接口：鉴权在 onRequest 阶段，早于 body 解析，
    // 走业务接口会先被 401 挡掉，测不到 JSON 解析器。
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
    });
    expect(res.statusCode).toBe(400);
  });

  it('带上安全响应头', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('same-origin');
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['permissions-policy']).toContain('geolocation=()');
  });

  it('未登录访问业务接口返回 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/activities' });
    expect(res.statusCode).toBe(401);
  });

  it('公开接口不需要登录', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/platforms' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).platforms.length).toBeGreaterThan(0);
  });
});
