import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../src/lib/db.js';
import { RiskGuard } from '../src/lib/risk-guard.js';
import { runMigrations } from '../src/migrate.js';
import { classifyAuthFailure } from '@fitbridge/core';

let dataDir: string;
let db: Database;
let guard: RiskGuard;

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'fb-guard-'));
  db = new Database(join(dataDir, 'test.db'));
  await db.connect();
  await runMigrations(db);
  guard = new RiskGuard(db, { defaultCooldownMinutes: 60 });
});

afterEach(async () => {
  await db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('风控冷却', () => {
  it('初始状态允许登录', () => {
    expect(guard.check('otm', 'demo').allowed).toBe(true);
  });

  it('风控失败后进入冷却，拒绝后续尝试', () => {
    guard.recordFailure(
      'otm',
      'demo',
      classifyAuthFailure('HTTP 429 rate limit'),
    );
    const d = guard.check('otm', 'demo');
    expect(d.allowed).toBe(false);
    expect(d.retryAfterMinutes).toBeGreaterThan(0);
    expect(d.kind).toBe('rate-limited');
  });

  it('密码错误不进入冷却（但也不自动重试）', () => {
    guard.recordFailure(
      'otm',
      'demo',
      classifyAuthFailure('invalid password'),
    );
    expect(guard.check('otm', 'demo').allowed).toBe(true);
    expect(guard.get('otm', 'demo')?.failCount).toBe(1);
  });

  it('连续风控失败会延长冷却，但有上限', () => {
    const failure = classifyAuthFailure('429 rate limit');
    for (let i = 0; i < 10; i++) {
      guard.recordFailure('otm', 'demo', failure);
    }
    const state = guard.get('otm', 'demo')!;
    const minutes = Math.round(
      (new Date(state.cooldownUntil!).getTime() - Date.now()) / 60000,
    );
    // 默认 60min，最多 4 倍 = 240min
    expect(minutes).toBeGreaterThan(60);
    expect(minutes).toBeLessThanOrEqual(245);
  });

  it('登录成功后清除冷却', () => {
    guard.recordFailure('otm', 'demo', classifyAuthFailure('429'));
    expect(guard.check('otm', 'demo').allowed).toBe(false);
    guard.recordSuccess('otm', 'demo');
    expect(guard.check('otm', 'demo').allowed).toBe(true);
    expect(guard.get('otm', 'demo')?.failCount).toBe(0);
  });

  it('手动解除冷却', () => {
    guard.recordFailure('otm', 'demo', classifyAuthFailure('429'));
    guard.clear('otm', 'demo');
    expect(guard.check('otm', 'demo').allowed).toBe(true);
  });

  it('登录最小间隔节流', () => {
    guard.recordSuccess('otm', 'demo');
    const d = guard.check('otm', 'demo', 300); // 迈金 5 分钟
    expect(d.allowed).toBe(false);
    expect(d.kind).toBe('throttled');
    expect(d.retryAfterMinutes).toBeGreaterThan(0);
  });

  it('节流不影响冷却判断的优先级之外的情况', () => {
    guard.recordSuccess('otm', 'demo');
    // 不传 minInterval 则不节流
    expect(guard.check('otm', 'demo', 0).allowed).toBe(true);
  });

  it('不同账号互不影响', () => {
    guard.recordFailure('otm', 'a', classifyAuthFailure('429'));
    expect(guard.check('otm', 'a').allowed).toBe(false);
    expect(guard.check('otm', 'b').allowed).toBe(true);
  });

  it('列出全部受保护账号', () => {
    guard.recordFailure('otm', 'a', classifyAuthFailure('429'));
    guard.recordFailure('mywhoosh', 'b', classifyAuthFailure('429'));
    expect(guard.listGuarded()).toHaveLength(2);
  });
});
