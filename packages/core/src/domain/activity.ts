import type { CoordinateSystem, SportType } from '@fitbridge/fitkit';

export type { SportType };

/** 活动来源身份（幂等键的一半） */
export interface SourceRef {
  platformId: string;
  /** 平台内的活动唯一 ID */
  activityId: string;
  /** 平台短码，用于拼 external_id（如 'mg'） */
  shortCode: string;
}

/** 统一活动模型（落库形态） */
export interface ActivityRecord {
  id: string;
  userId: string;
  source: SourceRef;

  name: string;
  sportType: SportType;
  rawSportType?: string;

  /** UTC ISO */
  startTime?: string;
  /** 本地时间 ISO（带偏移） */
  localStartTime?: string;
  timezoneOffsetMin?: number;
  timezoneSource: 'file-local-timestamp' | 'platform' | 'user' | 'unknown';

  durationSec: number;
  distanceMeters: number;
  elevationGainMeters?: number;

  metrics: ActivityMetrics;

  /** 数据质量标记 */
  flags: ActivityFlags;

  syncState: 'pending' | 'synced' | 'partial' | 'failed';
  lastSyncedAt?: string;

  createdAt: string;
  updatedAt: string;
}

export interface ActivityMetrics {
  movingTimeSec?: number;
  avgSpeedMps?: number;
  maxSpeedMps?: number;
  avgHeartRate?: number;
  maxHeartRate?: number;
  avgPower?: number;
  maxPower?: number;
  avgCadence?: number;
  maxCadence?: number;
  calories?: number;
}

export interface ActivityFlags {
  /** 原始坐标系 */
  coordinateSystemOriginal: CoordinateSystem;
  /** 统一后的坐标系 */
  coordinateSystemFinal: CoordinateSystem;
  /** 是否做过时区校正 */
  timezoneAdjusted: boolean;
  /** 是否做过坐标转换 */
  coordinatesAdjusted: boolean;
  /** FIT 合规修复记录 */
  fitRepairs: string[];
  /** 解析告警 */
  warnings: string[];
}

/** 幂等键：用户 + 来源平台 + 来源活动 ID */
export function activityKey(
  userId: string,
  source: SourceRef,
): string {
  return `${userId}:${source.platformId}:${source.activityId}`;
}

/**
 * 跨平台 external_id 约定：{source_short_code}{source_activity_id}
 *
 * 例：迈金来源活动 12345 → "mg12345"
 * 参考项目在 Intervals.icu 上已用同样思路做幂等。
 */
export function externalId(source: SourceRef): string {
  return `${source.shortCode}${source.activityId}`;
}
