import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../src/lib/db.js';
import { SqliteActivityStore } from '../src/lib/repositories.js';
import { LocalFileStore } from '../src/lib/file-store.js';
import { runMigrations } from '../src/migrate.js';
import { DEFAULT_USER_ID } from '../src/lib/constants.js';
import { buildTrack, findRelated } from '../src/lib/activity-detail.js';
import { buildSyntheticFit } from '@fitbridge/fitkit/testing';

let dataDir: string;
let db: Database;
let store: SqliteActivityStore;
let files: LocalFileStore;

const START = new Date('2026-11-21T05:03:35.000Z');

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'fb-detail-'));
  db = new Database(join(dataDir, 'test.db'));
  await db.connect();
  await runMigrations(db);
  store = new SqliteActivityStore(db);
  files = new LocalFileStore(join(dataDir, 'blobs'));
});

afterEach(async () => {
  await db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function baseInput(platformId: string, activityId: string, name: string) {
  return {
    source: { platformId, activityId, shortCode: '' },
    name,
    sportType: 'ride' as const,
    startTime: START.toISOString(),
    timezoneOffsetMin: 480,
    timezoneSource: 'platform',
    durationSec: 3600,
    distanceMeters: 30000,
    elevationGainMeters: 100,
    metrics: { avgHeartRate: 150 },
    flags: {
      coordinateSystemOriginal: 'wgs84' as const,
      coordinateSystemFinal: 'wgs84' as const,
      timezoneAdjusted: false,
      coordinatesAdjusted: false,
      fitRepairs: [],
      warnings: [],
    },
  };
}

/** 存一个 FIT 文件到本地库并登记到 activity_files */
async function attachFit(
  activityId: string,
  coordSystem: string,
  opts: { startLat?: number; startLon?: number } = {},
): Promise<void> {
  const buf = buildSyntheticFit({
    start: START,
    recordCount: 30,
    startLat: opts.startLat ?? 31.2304,
    startLon: opts.startLon ?? 121.4737,
  });
  const stored = await files.put(buf);
  await store.addFile(DEFAULT_USER_ID, {
    activityId,
    kind: 'fit',
    blobKey: stored.blobKey,
    byteSize: stored.byteSize,
    sha256: stored.sha256,
    coordinateSystem: coordSystem,
    derived: false,
  });
}

describe('活动详情：轨迹解析', () => {
  it('解析 FIT 得到轨迹点与指标序列', async () => {
    const { id } = await store.upsert(DEFAULT_USER_ID, baseInput('otm', 'a1', '晨骑'));
    await attachFit(id, 'wgs84');

    const activity = (await store.get(DEFAULT_USER_ID, id))!;
    const track = await buildTrack(db, files, activity, await store.listFiles(id));

    expect(track.hasFit).toBe(true);
    expect(track.coordinateSystem).toBe('wgs84');
    expect(track.pointCount).toBe(30);
    expect(track.track.length).toBe(30);
    expect(track.track[0]!.lat).toBeCloseTo(31.2304, 3);
    expect(track.series.length).toBeGreaterThan(0);
    expect(track.summary?.avgSpeedMps).toBeCloseTo(5, 1);
  });

  it('GCJ-02 文件默认转换到 WGS-84 以便跨平台对比', async () => {
    const { id } = await store.upsert(DEFAULT_USER_ID, baseInput('otm', 'a1', '晨骑'));
    await attachFit(id, 'gcj02');

    const activity = (await store.get(DEFAULT_USER_ID, id))!;
    const rows = await store.listFiles(id);

    const converted = await buildTrack(db, files, activity, rows);
    expect(converted.coordinateSystem).toBe('gcj02');
    expect(converted.convertedTo).toBe('wgs84');
    // 原始点在上海，GCJ-02 → WGS-84 后应当往西南偏一点
    expect(converted.track[0]!.lon).toBeLessThan(121.4737);

    const raw = await buildTrack(db, files, activity, rows, { convertTo: 'none' });
    expect(raw.convertedTo).toBeUndefined();
    expect(raw.track[0]!.lon).toBeCloseTo(121.4737, 3);
  });

  it('没有 FIT 文件时给出提示而不是报错', async () => {
    const { id } = await store.upsert(DEFAULT_USER_ID, baseInput('otm', 'a1', '晨骑'));
    const activity = (await store.get(DEFAULT_USER_ID, id))!;
    const track = await buildTrack(db, files, activity, []);
    expect(track.hasFit).toBe(false);
    expect(track.warnings.join()).toContain('FIT');
  });
});

describe('活动详情：跨平台关联', () => {
  it('同时间同距离的其它平台活动会被关联上', async () => {
    const a = await store.upsert(DEFAULT_USER_ID, baseInput('otm', 'a1', '迈金骑行'));
    const b = await store.upsert(DEFAULT_USER_ID, baseInput('mywhoosh', 'b1', 'MyWhoosh Ride'));
    await attachFit(a.id, 'gcj02');
    await attachFit(b.id, 'wgs84');

    const activity = (await store.get(DEFAULT_USER_ID, a.id))!;
    const related = findRelated(db, activity);

    expect(related).toHaveLength(1);
    expect(related[0]!.id).toBe(b.id);
    expect(related[0]!.platformId).toBe('mywhoosh');
    expect(related[0]!.coordinateSystem).toBe('wgs84');
    expect(related[0]!.distanceDiffPct).toBeCloseTo(0, 3);
    expect(related[0]!.timeDiffSec).toBeCloseTo(0, 3);
  });

  it('距离差超过 2% 的活动不关联', async () => {
    const a = await store.upsert(DEFAULT_USER_ID, baseInput('otm', 'a1', '迈金骑行'));
    await store.upsert(DEFAULT_USER_ID, {
      ...baseInput('mywhoosh', 'b1', '另一场'),
      distanceMeters: 40000,
    });
    const activity = (await store.get(DEFAULT_USER_ID, a.id))!;
    expect(findRelated(db, activity)).toHaveLength(0);
  });

  it('时间差超过 5 分钟的活动不关联', async () => {
    const a = await store.upsert(DEFAULT_USER_ID, baseInput('otm', 'a1', '迈金骑行'));
    await store.upsert(DEFAULT_USER_ID, {
      ...baseInput('mywhoosh', 'b1', '晚一点的'),
      startTime: new Date(START.getTime() + 10 * 60 * 1000).toISOString(),
    });
    const activity = (await store.get(DEFAULT_USER_ID, a.id))!;
    expect(findRelated(db, activity)).toHaveLength(0);
  });
});
