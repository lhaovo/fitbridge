import type {
  ActivityFlags,
  ActivityMetrics,
  SourceRef,
  SportType,
} from '../domain/activity.js';

/**
 * 持久化接口。
 *
 * 核心引擎只依赖这些抽象，不认识 SQLite / Postgres。
 * 换数据库时只需换实现，引擎不动。
 */

/** 落库用的活动数据 */
export interface UpsertActivityInput {
  source: SourceRef;
  name: string;
  sportType: SportType;
  rawSportType?: string;
  startTime?: string;
  localStartTime?: string;
  timezoneOffsetMin?: number;
  timezoneSource: string;
  durationSec: number;
  distanceMeters: number;
  elevationGainMeters?: number;
  movingTimeSec?: number;
  metrics: ActivityMetrics;
  flags: ActivityFlags;
  raw?: unknown;
}

export interface StoredActivity {
  id: string;
  source: SourceRef;
  name: string;
  sportType: SportType;
  rawSportType?: string;
  startTime?: string;
  localStartTime?: string;
  timezoneOffsetMin?: number;
  timezoneSource: string;
  durationSec: number;
  distanceMeters: number;
  elevationGainMeters?: number;
  movingTimeSec?: number;
  metrics: ActivityMetrics;
  flags: ActivityFlags;
  syncState: 'pending' | 'synced' | 'partial' | 'failed';
  lastSyncedAt?: string;
  syncedTargets: string[];
  /** 平台原始报文（排障用，可能较大） */
  raw?: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface ActivityFileRow {
  id: string;
  activityId: string;
  kind: 'fit' | 'gpx' | 'tcx' | 'converted-fit';
  originalKind?: 'fit' | 'gpx' | 'tcx';
  blobKey: string;
  byteSize: number;
  sha256: string;
  coordinateSystem: string;
  derived: boolean;
  expired: boolean;
  createdAt: string;
}

export interface ActivityQuery {
  userId: string;
  sourcePlatform?: string[];
  sportType?: string[];
  since?: string;
  until?: string;
  keyword?: string;
  syncState?: string[];
  limit: number;
  offset: number;
  /** 排序：'start_time' | 'created_at' */
  sort?: 'start_time' | 'created_at';
  order?: 'asc' | 'desc';
}

/** 增量同步游标 */
export interface SyncState {
  platformId: string;
  lastCursor?: string;
  lastSyncAt?: string;
  lastSuccessAt?: string;
  lookbackSec: number;
}

/** 单条同步明细（活动 × 目标平台） */
export interface SyncItemInput {
  runId: string;
  activityId: string;
  sourcePlatform: string;
  targetPlatform: string;
  status: 'pending' | 'success' | 'skipped' | 'failed';
  attemptCount?: number;
  errorCode?: string;
  errorMessage?: string;
  remoteId?: string;
  externalId?: string;
  durationMs?: number;
}

export interface ActivityStore {
  /** 幂等 upsert（幂等键 = user + sourcePlatform + sourceActivityId） */
  upsert(userId: string, input: UpsertActivityInput): Promise<{ id: string; created: boolean }>;

  getBySource(userId: string, source: SourceRef): Promise<StoredActivity | undefined>;

  get(userId: string, activityId: string): Promise<StoredActivity | undefined>;

  list(userId: string, query: ActivityQuery): Promise<{ items: StoredActivity[]; total: number }>;

  /** 记录活动文件 */
  addFile(userId: string, input: {
    activityId: string;
    kind: ActivityFileRow['kind'];
    originalKind?: ActivityFileRow['originalKind'];
    blobKey: string;
    byteSize: number;
    sha256: string;
    coordinateSystem: string;
    derived: boolean;
  }): Promise<void>;

  listFiles(activityId: string): Promise<ActivityFileRow[]>;

  /**
   * 标记已同步到某目标。
   *
   * runId 指向 sync_runs 的一行（外键约束）。
   * 传 undefined 时使用内置的 standalone run。
   */
  markSynced(
    userId: string,
    activityId: string,
    targetPlatform: string,
    remoteId?: string,
    runId?: string,
  ): Promise<void>;

  /** 创建一次运行记录（sync_runs） */
  createRun(input: {
    runId: string;
    userId: string;
    trigger: 'manual' | 'schedule' | 'webhook' | 'api';
    taskId?: string;
  }): Promise<void>;

  /** 结束运行记录 */
  finishRun(input: {
    runId: string;
    status: 'success' | 'partial' | 'failed' | 'cancelled';
    stats?: Record<string, unknown>;
    error?: string;
  }): Promise<void>;

  /** 增量游标 */
  getSyncState(userId: string, platformId: string): Promise<SyncState | undefined>;
  setSyncState(userId: string, platformId: string, state: Partial<SyncState>): Promise<void>;

  /** 同步明细 */
  recordSyncItem(input: SyncItemInput): Promise<void>;

  /** 按保留期清理已过期的文件记录（返回被清理的 blobKey 列表） */
  expireFiles(retentionDays: number, derivedTtlDays: number, now: Date): Promise<string[]>;
}

/** 事件流（供 SSE 实时推送） */
export interface SyncEvent {
  level: 'info' | 'warn' | 'error';
  category: 'sync' | 'auth' | 'platform' | 'system';
  platformId?: string;
  activityId?: string;
  runId?: string;
  message: string;
  data?: unknown;
}

export interface EventSink {
  emit(userId: string, event: SyncEvent): Promise<void>;
}
