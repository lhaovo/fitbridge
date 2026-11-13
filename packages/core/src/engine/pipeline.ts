import type { FitSummary } from '@fitbridge/fitkit';
import { detectFileKind, readFit } from '@fitbridge/fitkit';
import type { Credential } from '../ports/adapter.js';
import type {
  FilePayload,
  PlatformAdapter,
  RemoteActivity,
  RemoteActivityDetail,
} from '../ports/adapter.js';
import { PlatformError } from './errors.js';

/**
 * 同步引擎的「取数 + 规范化」两段流水线。
 *
 * 引擎本身不认识任何平台：所有平台差异都在 PlatformAdapter 内部。
 * 这里只做编排、去重键计算和规范化。
 */

export interface NormalizedActivity {
  source: {
    platformId: string;
    activityId: string;
    shortCode: string;
  };
  name: string;
  sportType: string;
  startTime?: string;
  timezoneOffsetMin?: number;
  timezoneSource: FitSummary['timezoneSource'];
  distanceMeters: number;
  durationSec: number;
  elevationGainMeters?: number;
  metrics: Record<string, number | undefined>;
  flags: {
    coordinateSystemOriginal: string;
    coordinatesAdjusted: boolean;
    timezoneAdjusted: boolean;
    warnings: string[];
  };
  /** 解析出的 FIT 摘要（有 FIT 时才有） */
  fit?: FitSummary;
}

/** 上传前的产物 */
export interface PreparedFile {
  content: Buffer;
  kind: 'fit' | 'gpx' | 'tcx';
  filename: string;
  byteSize: number;
}

/**
 * 发现阶段：列出候选活动。
 * adapter 自己负责增量游标，引擎只负责编排。
 */
export async function discover(
  adapter: PlatformAdapter,
  cred: Credential,
  opts: { cursor?: string; limit?: number },
): Promise<RemoteActivity[]> {
  try {
    const page = await adapter.listActivities(cred, opts);
    return page.items;
  } catch (err) {
    throw PlatformError.from(err, adapter.manifest.id);
  }
}

/** 取详情（可选，adapter 没有实现时返回原对象） */
export async function detail(
  adapter: PlatformAdapter,
  cred: Credential,
  activity: RemoteActivity,
): Promise<RemoteActivityDetail> {
  if (!adapter.getActivityDetail) return activity;
  try {
    const detail = await adapter.getActivityDetail(cred, activity.remoteId);
    // 合并：detail 可能没有回传列表项里的字段（如 MyWhoosh 的 activityFileId）
    return {
      ...activity,
      ...detail,
      raw: detail.raw ?? activity.raw,
    };
  } catch (err) {
    throw PlatformError.from(err, adapter.manifest.id);
  }
}

/** 下载文件 */
export async function fetch(
  adapter: PlatformAdapter,
  cred: Credential,
  activity: RemoteActivityDetail,
): Promise<FilePayload> {
  try {
    return await adapter.downloadFile(cred, activity);
  } catch (err) {
    throw PlatformError.from(err, adapter.manifest.id);
  }
}

/**
 * 规范化：识别文件类型 + 解析 FIT 摘要 + 标注坐标系与时区。
 *
 * 关键约定：
 * - 文件级坐标系优先于 manifest（迈金七牛直链是 WGS-84、fit_content 是 GCJ-02）
 * - 坐标系转换本身属于「派生文件」，M0 只标注不改写
 */
export async function normalize(
  adapter: PlatformAdapter,
  activity: RemoteActivityDetail,
  payload: FilePayload,
): Promise<NormalizedActivity> {
  const kind = payload.sourceKind ?? detectFileKind(payload.content);
  const manifestSystem = adapter.manifest.coordinateSystem;
  const fileSystem = payload.coordinateSystem ?? manifestSystem;

  let fit: FitSummary | undefined;
  const warnings: string[] = [];

  if (kind === 'fit') {
    try {
      fit = await readFit(payload.content);
      warnings.push(...fit.warnings);
    } catch (err) {
      throw new PlatformError(
        'VALIDATION_FAILED',
        `FIT 解析失败: ${err instanceof Error ? err.message : String(err)}`,
        { platformId: adapter.manifest.id, cause: err },
      );
    }
  }

  const distanceMeters =
    fit?.totalDistanceM ?? activity.distanceMeters ?? 0;
  const durationSec =
    fit?.totalElapsedSec ?? activity.durationSec ?? 0;

  // 时区优先级：平台明确给 > FIT 文件 local_timestamp > 未知
  let timezoneOffsetMin = activity.timezoneOffset ?? fit?.timezoneOffsetMin;
  let timezoneSource: FitSummary['timezoneSource'] = activity.timezoneOffset
    ? 'platform'
    : (fit?.timezoneSource ?? 'unknown');

  return {
    source: {
      platformId: adapter.manifest.id,
      activityId: activity.remoteId,
      shortCode: adapter.manifest.shortCode,
    },
    name: activity.name ?? fit?.rawSportType ?? adapter.manifest.displayName,
    sportType: fit?.sportType ?? 'other',
    startTime: activity.startTime ?? fit?.startTime,
    timezoneOffsetMin,
    timezoneSource,
    distanceMeters,
    durationSec,
    elevationGainMeters:
      fit?.elevationGainM ?? activity.elevationGainMeters,
    metrics: {
      avgHeartRate: fit?.avgHeartRate ?? activity.avgHeartRate,
      maxHeartRate: fit?.maxHeartRate,
      avgPower: fit?.avgPower ?? activity.avgPower,
      maxPower: fit?.maxPower,
      avgCadence: fit?.avgCadence ?? activity.avgCadence,
      maxSpeedMps: fit?.maxSpeedMps,
      avgSpeedMps: fit?.avgSpeedMps,
      calories: fit?.calories,
    },
    flags: {
      coordinateSystemOriginal: fileSystem,
      // M0 只标注不改写；真正转换在 M1 的派生文件阶段
      coordinatesAdjusted: false,
      timezoneAdjusted: false,
      warnings,
    },
    fit,
  };
}

/** 检查目标平台是否接受该格式 */
export function targetAccepts(
  adapter: PlatformAdapter,
  kind: 'fit' | 'gpx' | 'tcx',
): boolean {
  return adapter.manifest.capabilities.uploadFormats.includes(kind);
}
