import { randomUUID } from 'node:crypto';
import type {
  ActivityFlags,
  ActivityFileRow,
  ActivityQuery,
  ActivityStore,
  EventSink,
  SourceRef,
  StoredActivity,
  SyncItemInput,
  SyncState,
  UpsertActivityInput,
} from '@fitbridge/core';
import type { Database } from './db.js';
import { DEFAULT_USER_ID } from './constants.js';

/**
 * SQLite 版持久化实现。
 *
 * 核心引擎只依赖 core 里的 ActivityStore / EventSink 抽象，
 * 这里把接口翻译成 SQL。换数据库只改本文件。
 */
export class SqliteActivityStore implements ActivityStore {
  constructor(private readonly db: Database) {}

  async upsert(
    userId: string,
    input: UpsertActivityInput,
  ): Promise<{ id: string; created: boolean }> {
    const existing = await this.getBySource(userId, input.source);
    const now = new Date().toISOString();

    if (existing) {
      this.db.run(
        'UPDATE activities SET name = ?, sport_type = ?, raw_sport_type = ?, start_time = ?, ' +
          ' local_start_time = ?, timezone_offset_min = ?, timezone_source = ?, duration_sec = ?, ' +
          ' distance_m = ?, elevation_gain_m = ?, moving_time_sec = ?, metrics = ?, flags = ?, ' +
          ' raw = ?, updated_at = ? WHERE id = ?',
        [
          input.name,
          input.sportType,
          input.rawSportType ?? null,
          input.startTime ?? null,
          input.localStartTime ?? null,
          input.timezoneOffsetMin ?? 0,
          input.timezoneSource,
          Math.round(input.durationSec),
          input.distanceMeters,
          input.elevationGainMeters ?? null,
          input.movingTimeSec ?? null,
          JSON.stringify(input.metrics ?? {}),
          JSON.stringify(input.flags ?? {}),
          input.raw === undefined ? null : JSON.stringify(input.raw),
          now,
          existing.id,
        ],
      );
      return { id: existing.id, created: false };
    }

    const id = randomUUID();
    this.db.run(
      'INSERT INTO activities (id, user_id, source_platform, source_activity_id, name, sport_type, ' +
        ' raw_sport_type, start_time, local_start_time, timezone_offset_min, timezone_source, ' +
        ' duration_sec, distance_m, elevation_gain_m, moving_time_sec, metrics, coord_original, ' +
        ' coord_final, flags, sync_state, raw, created_at, updated_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        id,
        userId,
        input.source.platformId,
        input.source.activityId,
        input.name,
        input.sportType,
        input.rawSportType ?? null,
        input.startTime ?? null,
        input.localStartTime ?? null,
        input.timezoneOffsetMin ?? 0,
        input.timezoneSource,
        Math.round(input.durationSec),
        input.distanceMeters,
        input.elevationGainMeters ?? null,
        input.movingTimeSec ?? null,
        JSON.stringify(input.metrics ?? {}),
        input.flags.coordinateSystemOriginal ?? 'unknown',
        input.flags.coordinateSystemFinal ?? 'wgs84',
        JSON.stringify(input.flags ?? {}),
        'pending',
        input.raw === undefined ? null : JSON.stringify(input.raw),
        now,
        now,
      ],
    );
    return { id, created: true };
  }

  async getBySource(
    userId: string,
    source: SourceRef,
  ): Promise<StoredActivity | undefined> {
    const rows = this.db.query<ActivityRow>(
      'SELECT * FROM activities WHERE user_id = ? AND source_platform = ? AND source_activity_id = ?',
      [userId, source.platformId, source.activityId],
    );
    const row = rows[0];
    return row ? this.toStored(row) : undefined;
  }

  async get(userId: string, activityId: string): Promise<StoredActivity | undefined> {
    const rows = this.db.query<ActivityRow>(
      'SELECT * FROM activities WHERE user_id = ? AND id = ?',
      [userId, activityId],
    );
    const row = rows[0];
    return row ? this.toStored(row) : undefined;
  }

  async list(
    userId: string,
    query: ActivityQuery,
  ): Promise<{ items: StoredActivity[]; total: number }> {
    const where: string[] = ['user_id = ?'];
    const params: unknown[] = [userId];

    if (query.sourcePlatform?.length) {
      where.push(
        'source_platform IN (' + query.sourcePlatform.map(() => '?').join(',') + ')',
      );
      params.push(...query.sourcePlatform);
    }
    if (query.sportType?.length) {
      where.push('sport_type IN (' + query.sportType.map(() => '?').join(',') + ')');
      params.push(...query.sportType);
    }
    if (query.since) {
      where.push('start_time >= ?');
      params.push(query.since);
    }
    if (query.until) {
      where.push('start_time <= ?');
      params.push(query.until);
    }
    if (query.keyword) {
      where.push('(name LIKE ? OR source_activity_id LIKE ?)');
      params.push('%' + query.keyword + '%', '%' + query.keyword + '%');
    }
    if (query.syncState?.length) {
      where.push('sync_state IN (' + query.syncState.map(() => '?').join(',') + ')');
      params.push(...query.syncState);
    }

    const whereSql = 'WHERE ' + where.join(' AND ');
    const total =
      this.db.one<{ c: number }>('SELECT COUNT(*) AS c FROM activities ' + whereSql, params)
        ?.c ?? 0;

    const sortCol = query.sort === 'created_at' ? 'created_at' : 'start_time';
    const order = query.order === 'asc' ? 'ASC' : 'DESC';
    const rows = this.db.query<ActivityRow>(
      'SELECT * FROM activities ' + whereSql +
        ' ORDER BY ' + sortCol + ' ' + order + ', created_at DESC LIMIT ? OFFSET ?',
      [...params, query.limit, query.offset],
    );

    return { items: rows.map((r) => this.toStored(r)), total };
  }

  async addFile(
    _userId: string,
    input: {
      activityId: string;
      kind: ActivityFileRow['kind'];
      originalKind?: ActivityFileRow['originalKind'];
      blobKey: string;
      byteSize: number;
      sha256: string;
      coordinateSystem: string;
      derived: boolean;
    },
  ): Promise<void> {
    // 同一活动同 sha256 只留一条
    const existing = this.db.one<{ id: string }>(
      'SELECT id FROM activity_files WHERE activity_id = ? AND sha256 = ? AND kind = ?',
      [input.activityId, input.sha256, input.kind],
    );
    if (existing) return;

    this.db.run(
      'INSERT INTO activity_files (id, activity_id, kind, original_kind, blob_key, byte_size, ' +
        ' sha256, coord_system, derived, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        randomUUID(),
        input.activityId,
        input.kind,
        input.originalKind ?? null,
        input.blobKey,
        input.byteSize,
        input.sha256,
        input.coordinateSystem,
        input.derived ? 1 : 0,
        new Date().toISOString(),
      ],
    );
  }

  async listFiles(activityId: string): Promise<ActivityFileRow[]> {
    return this.db
      .query<FileRow>('SELECT * FROM activity_files WHERE activity_id = ?', [activityId])
      .map((r) => ({
        id: r.id,
        activityId: r.activity_id,
        kind: r.kind as ActivityFileRow['kind'],
        originalKind: (r.original_kind ?? undefined) as ActivityFileRow['originalKind'],
        blobKey: r.blob_key,
        byteSize: r.byte_size,
        sha256: r.sha256,
        coordinateSystem: r.coord_system,
        derived: r.derived === 1,
        expired: r.expired_at !== null,
        createdAt: r.created_at,
      }));
  }

  /** 内置的 standalone run（用于没有具体运行上下文的标记） */
  private static readonly STANDALONE_RUN = 'run-standalone';

  async createRun(input: {
    runId: string;
    userId: string;
    trigger: 'manual' | 'schedule' | 'webhook' | 'api';
    taskId?: string;
  }): Promise<void> {
    this.db.run(
      'INSERT INTO sync_runs (id, task_id, user_id, trigger, status, started_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING',
      [
        input.runId,
        input.taskId ?? null,
        input.userId,
        input.trigger,
        'running',
        new Date().toISOString(),
      ],
    );
  }

  async finishRun(input: {
    runId: string;
    status: 'success' | 'partial' | 'failed' | 'cancelled';
    stats?: Record<string, unknown>;
    error?: string;
  }): Promise<void> {
    this.db.run(
      'UPDATE sync_runs SET status = ?, finished_at = ?, stats = ?, error = ? WHERE id = ?',
      [
        input.status,
        new Date().toISOString(),
        JSON.stringify(input.stats ?? {}),
        input.error ? JSON.stringify({ message: input.error }) : null,
        input.runId,
      ],
    );
  }

  /** 确保 standalone run 存在（sync_items.run_id 有外键） */
  private ensureStandaloneRun(userId: string): string {
    this.db.run(
      'INSERT INTO sync_runs (id, task_id, user_id, trigger, status, started_at, finished_at) ' +
        'VALUES (?, NULL, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING',
      [
        SqliteActivityStore.STANDALONE_RUN,
        userId,
        'manual',
        'success',
        new Date().toISOString(),
        new Date().toISOString(),
      ],
    );
    return SqliteActivityStore.STANDALONE_RUN;
  }

  async markSynced(
    userId: string,
    activityId: string,
    targetPlatform: string,
    remoteId?: string,
    runId?: string,
  ): Promise<void> {
    const now = new Date().toISOString();
    const effectiveRunId = runId ?? this.ensureStandaloneRun(userId);
    const existing = this.db.one<{ id: string }>(
      "SELECT id FROM sync_items WHERE activity_id = ? AND target_platform = ? AND status = 'success'",
      [activityId, targetPlatform],
    );
    if (existing) {
      this.db.run('UPDATE sync_items SET remote_id = ? WHERE id = ?', [
        remoteId ?? null,
        existing.id,
      ]);
    } else {
      this.db.run(
        'INSERT INTO sync_items (id, run_id, activity_id, source_platform, target_platform, ' +
          ' status, remote_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [
          randomUUID(),
          effectiveRunId,
          activityId,
          '',
          targetPlatform,
          'success',
          remoteId ?? null,
          now,
        ],
      );
    }
    // 活动整体状态：所有目标都成功 → synced
    const pending = this.db.one<{ c: number }>(
      'SELECT COUNT(*) AS c FROM sync_items WHERE activity_id = ? AND status <> ?',
      [activityId, 'success'],
    );
    this.db.run(
      'UPDATE activities SET sync_state = ?, last_synced_at = ?, updated_at = ? WHERE id = ?',
      [pending && pending.c > 0 ? 'partial' : 'synced', now, now, activityId],
    );
  }

  async getSyncState(userId: string, platformId: string): Promise<SyncState | undefined> {
    const row = this.db.one<{
      platform_id: string;
      last_cursor: string | null;
      last_sync_at: string | null;
      last_success_at: string | null;
      lookback_sec: number;
    }>('SELECT * FROM sync_states WHERE user_id = ? AND platform_id = ?', [
      userId,
      platformId,
    ]);
    if (!row) return undefined;
    return {
      platformId: row.platform_id,
      lastCursor: row.last_cursor ?? undefined,
      lastSyncAt: row.last_sync_at ?? undefined,
      lastSuccessAt: row.last_success_at ?? undefined,
      lookbackSec: row.lookback_sec ?? 86400,
    };
  }

  async setSyncState(
    userId: string,
    platformId: string,
    state: Partial<SyncState>,
  ): Promise<void> {
    this.db.run(
      'INSERT INTO sync_states (user_id, platform_id, last_cursor, last_sync_at, last_success_at, lookback_sec) ' +
        'VALUES (?, ?, ?, ?, ?, ?) ' +
        'ON CONFLICT(user_id, platform_id) DO UPDATE SET ' +
        'last_cursor = COALESCE(excluded.last_cursor, sync_states.last_cursor), ' +
        'last_sync_at = COALESCE(excluded.last_sync_at, sync_states.last_sync_at), ' +
        'last_success_at = COALESCE(excluded.last_success_at, sync_states.last_success_at), ' +
        'lookback_sec = excluded.lookback_sec',
      [
        userId,
        platformId,
        state.lastCursor ?? null,
        state.lastSyncAt ?? null,
        state.lastSuccessAt ?? null,
        state.lookbackSec ?? 86400,
      ],
    );
  }

  async recordSyncItem(input: SyncItemInput): Promise<void> {
    this.db.run(
      'INSERT INTO sync_items (id, run_id, activity_id, source_platform, target_platform, status, ' +
        ' attempt_count, error_code, error_message, remote_id, external_id, duration_ms, created_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        randomUUID(),
        input.runId,
        input.activityId,
        input.sourcePlatform,
        input.targetPlatform,
        input.status,
        input.attemptCount ?? 0,
        input.errorCode ?? null,
        input.errorMessage ?? null,
        input.remoteId ?? null,
        input.externalId ?? null,
        input.durationMs ?? null,
        new Date().toISOString(),
      ],
    );
  }

  async expireFiles(
    retentionDays: number,
    derivedTtlDays: number,
    now: Date,
  ): Promise<string[]> {
    const expired: string[] = [];

    // L2 原始文件：超过保留期
    if (retentionDays > 0) {
      const cutoff = new Date(
        now.getTime() - retentionDays * 24 * 60 * 60 * 1000,
      ).toISOString();
      const rows = this.db.query<{ id: string; blob_key: string }>(
        'SELECT id, blob_key FROM activity_files WHERE derived = 0 AND expired_at IS NULL AND created_at < ?',
        [cutoff],
      );
      for (const r of rows) {
        this.db.run('UPDATE activity_files SET expired_at = ? WHERE id = ?', [
          now.toISOString(),
          r.id,
        ]);
        expired.push(r.blob_key);
      }
    }

    // L3 派生文件：缓存期短
    if (derivedTtlDays > 0) {
      const cutoff = new Date(
        now.getTime() - derivedTtlDays * 24 * 60 * 60 * 1000,
      ).toISOString();
      const rows = this.db.query<{ id: string; blob_key: string }>(
        'SELECT id, blob_key FROM activity_files WHERE derived = 1 AND expired_at IS NULL AND created_at < ?',
        [cutoff],
      );
      for (const r of rows) {
        this.db.run('UPDATE activity_files SET expired_at = ? WHERE id = ?', [
          now.toISOString(),
          r.id,
        ]);
        expired.push(r.blob_key);
      }
    }

    return expired;
  }

  /** 已同步到的目标平台列表 */
  private syncedTargets(activityId: string): string[] {
    return this.db
      .query<{ target_platform: string }>(
        "SELECT DISTINCT target_platform FROM sync_items WHERE activity_id = ? AND status = 'success'",
        [activityId],
      )
      .map((r) => r.target_platform);
  }

  private toStored(r: ActivityRow): StoredActivity {
    return {
      id: r.id,
      source: {
        platformId: r.source_platform,
        activityId: r.source_activity_id,
        shortCode: '',
      },
      name: r.name,
      sportType: r.sport_type as StoredActivity['sportType'],
      rawSportType: r.raw_sport_type ?? undefined,
      startTime: r.start_time ?? undefined,
      localStartTime: r.local_start_time ?? undefined,
      timezoneOffsetMin: r.timezone_offset_min,
      timezoneSource: r.timezone_source,
      durationSec: r.duration_sec,
      distanceMeters: r.distance_m,
      elevationGainMeters: r.elevation_gain_m ?? undefined,
      movingTimeSec: r.moving_time_sec ?? undefined,
      metrics: parseJson(r.metrics),
      flags: toFlags(r.flags),
      syncState: r.sync_state as StoredActivity['syncState'],
      lastSyncedAt: r.last_synced_at ?? undefined,
      syncedTargets: this.syncedTargets(r.id),
      raw: r.raw ? parseJson(r.raw) : undefined,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }
}

/** 事件写入（供 SSE 实时推送与历史查询） */
export class SqliteEventSink implements EventSink {
  constructor(private readonly db: Database) {}

  async emit(userId: string, event: {
    level: 'info' | 'warn' | 'error';
    category: 'sync' | 'auth' | 'platform' | 'system';
    platformId?: string;
    activityId?: string;
    runId?: string;
    message: string;
    data?: unknown;
  }): Promise<void> {
    this.db.run(
      'INSERT INTO events (user_id, level, category, platform_id, activity_id, run_id, message, data) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [
        userId,
        event.level,
        event.category,
        event.platformId ?? null,
        event.activityId ?? null,
        event.runId ?? null,
        event.message,
        event.data === undefined ? null : JSON.stringify(event.data),
      ],
    );
  }
}

/** 事件历史查询 */
export function listEvents(
  db: Database,
  userId: string,
  opts: { limit?: number; offset?: number; level?: string; category?: string } = {},
): Array<Record<string, unknown>> {
  const where = ['user_id = ?'];
  const params: unknown[] = [userId];
  if (opts.level) {
    where.push('level = ?');
    params.push(opts.level);
  }
  if (opts.category) {
    where.push('category = ?');
    params.push(opts.category);
  }
  return db.query(
    'SELECT * FROM events WHERE ' + where.join(' AND ') +
      ' ORDER BY id DESC LIMIT ? OFFSET ?',
    [...params, opts.limit ?? 100, opts.offset ?? 0],
  );
}

interface ActivityRow {
  id: string;
  user_id: string;
  source_platform: string;
  source_activity_id: string;
  name: string;
  sport_type: string;
  raw_sport_type: string | null;
  start_time: string | null;
  local_start_time: string | null;
  timezone_offset_min: number;
  timezone_source: string;
  duration_sec: number;
  distance_m: number;
  elevation_gain_m: number | null;
  moving_time_sec: number | null;
  metrics: string;
  coord_original: string;
  coord_final: string;
  flags: string;
  sync_state: string;
  last_synced_at: string | null;
  raw: string | null;
  created_at: string;
  updated_at: string;
}

interface FileRow {
  id: string;
  activity_id: string;
  kind: string;
  original_kind: string | null;
  blob_key: string;
  byte_size: number;
  sha256: string;
  coord_system: string;
  derived: number;
  expired_at: string | null;
  created_at: string;
}

const DEFAULT_FLAGS = {
  coordinateSystemOriginal: 'unknown',
  coordinateSystemFinal: 'wgs84',
  timezoneAdjusted: false,
  coordinatesAdjusted: false,
  fitRepairs: [] as string[],
  warnings: [] as string[],
};

function toFlags(s: string | null): ActivityFlags {
  const raw = parseJson(s) as Partial<ActivityFlags>;
  return {
    coordinateSystemOriginal: (
      raw.coordinateSystemOriginal ?? DEFAULT_FLAGS.coordinateSystemOriginal
    ) as ActivityFlags['coordinateSystemOriginal'],
    coordinateSystemFinal: (
      raw.coordinateSystemFinal ?? DEFAULT_FLAGS.coordinateSystemFinal
    ) as ActivityFlags['coordinateSystemFinal'],
    timezoneAdjusted: raw.timezoneAdjusted ?? false,
    coordinatesAdjusted: raw.coordinatesAdjusted ?? false,
    fitRepairs: raw.fitRepairs ?? [],
    warnings: raw.warnings ?? [],
  };
}

function parseJson(s: string | null): Record<string, unknown> {
  if (!s) return {};
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export { DEFAULT_USER_ID };
