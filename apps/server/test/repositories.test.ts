import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../src/lib/db.js';
import { SqliteActivityStore, SqliteEventSink } from '../src/lib/repositories.js';
import { runMigrations } from '../src/migrate.js';
import { DEFAULT_USER_ID } from '../src/lib/constants.js';

let dataDir: string;
let db: Database;

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'fb-repo-'));
  db = new Database(join(dataDir, 'test.db'));
  await db.connect();
  await runMigrations(db);
});

afterEach(async () => {
  await db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const upsertInput = {
  source: { platformId: 'otm', activityId: 'a1', shortCode: 'mg' },
  name: '晨骑',
  sportType: 'ride' as const,
  rawSportType: 'cycling',
  startTime: '2026-11-20T01:00:00.000Z',
  timezoneOffsetMin: 480,
  timezoneSource: 'platform',
  durationSec: 3600,
  distanceMeters: 25000,
  elevationGainMeters: 120,
  metrics: { avgHeartRate: 150, avgPower: 200 },
  flags: {
    coordinateSystemOriginal: 'gcj02' as const,
    coordinateSystemFinal: 'wgs84' as const,
    timezoneAdjusted: true,
    coordinatesAdjusted: true,
    fitRepairs: ['crc'],
    warnings: [],
  },
  raw: { id: 1 },
};

describe('活动仓储（同时是 schema 漂移检测）', () => {
  it('upsert / 读取 / 列表 往返一致', async () => {
    const store = new SqliteActivityStore(db);
    const { id, created } = await store.upsert(DEFAULT_USER_ID, upsertInput);
    expect(created).toBe(true);

    const got = await store.get(DEFAULT_USER_ID, id);
    expect(got).toBeDefined();
    expect(got!.name).toBe('晨骑');
    expect(got!.sportType).toBe('ride');
    expect(got!.rawSportType).toBe('cycling');
    expect(got!.distanceMeters).toBe(25000);
    expect(got!.metrics.avgHeartRate).toBe(150);
    expect(got!.flags.coordinateSystemOriginal).toBe('gcj02');
    expect(got!.flags.fitRepairs).toEqual(['crc']);
  });

  it('★ 幂等：同来源同 ID 重复 upsert 不产生第二条', async () => {
    const store = new SqliteActivityStore(db);
    const a = await store.upsert(DEFAULT_USER_ID, upsertInput);
    const b = await store.upsert(DEFAULT_USER_ID, {
      ...upsertInput,
      name: '晨骑（改名）',
    });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(a.id).toBe(b.id);

    const { total } = await store.list(DEFAULT_USER_ID, { userId: DEFAULT_USER_ID, limit: 100, offset: 0 });
    expect(total).toBe(1);
  });

  it('getBySource 能按幂等键找到', async () => {
    const store = new SqliteActivityStore(db);
    const { id } = await store.upsert(DEFAULT_USER_ID, upsertInput);
    const found = await store.getBySource(DEFAULT_USER_ID, upsertInput.source);
    expect(found?.id).toBe(id);
  });

  it('文件记录可写入并列出', async () => {
    const store = new SqliteActivityStore(db);
    const { id } = await store.upsert(DEFAULT_USER_ID, upsertInput);
    await store.addFile(DEFAULT_USER_ID, {
      activityId: id,
      kind: 'fit',
      blobKey: 'sha256/ab/cd/xyz',
      byteSize: 1234,
      sha256: 'xyz',
      coordinateSystem: 'wgs84',
      derived: false,
    });
    const files = await store.listFiles(id);
    expect(files).toHaveLength(1);
    expect(files[0]!.byteSize).toBe(1234);
    expect(files[0]!.expired).toBe(false);
  });

  it('相同 sha256 不重复建文件记录', async () => {
    const store = new SqliteActivityStore(db);
    const { id } = await store.upsert(DEFAULT_USER_ID, upsertInput);
    const f = {
      activityId: id,
      kind: 'fit' as const,
      blobKey: 'sha256/ab/cd/xyz',
      byteSize: 1234,
      sha256: 'xyz',
      coordinateSystem: 'wgs84',
      derived: false,
    };
    await store.addFile(DEFAULT_USER_ID, f);
    await store.addFile(DEFAULT_USER_ID, f);
    expect((await store.listFiles(id)).length).toBe(1);
  });

  it('标记已同步后可查到目标平台', async () => {
    const store = new SqliteActivityStore(db);
    const { id } = await store.upsert(DEFAULT_USER_ID, upsertInput);
    await store.markSynced(DEFAULT_USER_ID, id, 'otm', 'remote-1');
    const got = await store.get(DEFAULT_USER_ID, id);
    expect(got!.syncedTargets).toContain('otm');
    expect(got!.syncState).toBe('synced');
  });

  it('增量游标可写可读', async () => {
    const store = new SqliteActivityStore(db);
    await store.setSyncState(DEFAULT_USER_ID, 'otm', { lastCursor: '3' });
    const s = await store.getSyncState(DEFAULT_USER_ID, 'otm');
    expect(s?.lastCursor).toBe('3');
  });

  it('筛选：按来源 / 类型 / 日期', async () => {
    const store = new SqliteActivityStore(db);
    await store.upsert(DEFAULT_USER_ID, upsertInput);
    await store.upsert(DEFAULT_USER_ID, {
      ...upsertInput,
      source: { platformId: 'mywhoosh', activityId: 'b1', shortCode: 'mw' },
      sportType: 'run',
    });

    const all = await store.list(DEFAULT_USER_ID, { userId: DEFAULT_USER_ID, limit: 100, offset: 0 });
    expect(all.total).toBe(2);

    const byPlatform = await store.list(DEFAULT_USER_ID, {
      userId: DEFAULT_USER_ID, limit: 100, offset: 0, sourcePlatform: ['mywhoosh'],
    });
    expect(byPlatform.total).toBe(1);

    const bySport = await store.list(DEFAULT_USER_ID, {
      userId: DEFAULT_USER_ID, limit: 100, offset: 0, sportType: ['ride'],
    });
    expect(bySport.total).toBe(1);

    const bySince = await store.list(DEFAULT_USER_ID, {
      userId: DEFAULT_USER_ID, limit: 100, offset: 0, since: '2026-11-21T00:00:00.000Z',
    });
    expect(bySince.total).toBe(0);
  });

  it('保留期清理：超期文件被标记并返回待删 blobKey', async () => {
    const store = new SqliteActivityStore(db);
    const { id } = await store.upsert(DEFAULT_USER_ID, upsertInput);
    await store.addFile(DEFAULT_USER_ID, {
      activityId: id,
      kind: 'fit',
      blobKey: 'sha256/old/blob',
      byteSize: 10,
      sha256: 'old',
      coordinateSystem: 'wgs84',
      derived: false,
    });
    // 手动把创建时间改到很久以前
    db.run("UPDATE activity_files SET created_at = '2020-01-01T00:00:00.000Z'");

    const expired = await store.expireFiles(90, 7, new Date());
    expect(expired).toContain('sha256/old/blob');

    const files = await store.listFiles(id);
    expect(files[0]!.expired).toBe(true);
    // 元数据仍在（活动账本不删）
    expect(await store.get(DEFAULT_USER_ID, id)).toBeDefined();
  });

  it('事件写入后可查', async () => {
    const sink = new SqliteEventSink(db);
    await sink.emit(DEFAULT_USER_ID, {
      level: 'info',
      category: 'sync',
      platformId: 'otm',
      message: '已拉取：晨骑',
    });
    const rows = db.query('SELECT * FROM events');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.message).toBe('已拉取：晨骑');
  });
});
