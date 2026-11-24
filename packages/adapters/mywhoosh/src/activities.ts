import type {
  Credential,
  Paged,
  RemoteActivity,
  RemoteActivityDetail,
} from '@fitbridge/core';
import { MyWhooshClient } from './client.js';

/**
 * MyWhoosh 列表项的真实字段（2026-11 实测确认）：
 *   id, title, sportType, routeName
 *   distance          → 公里
 *   date              → unix 秒（1795237415）
 *   startDatetime     → ISO（2026-11-21T05:03:35.000Z）★ 用这个
 *   createdAt         → ISO
 *   rideDuration      → "02:35:30.000"
 *   heartrate, watt, elevation
 *   activityFileId    → 下载必需
 */
interface MyWhooshActivityItem {
  id?: string | number;
  _id?: string | number;
  name?: string;
  title?: string;
  routeName?: string;
  /** 下载必需的 activityFileId；缺失则无法下载 */
  activityFileId?: string;
  date?: string | number;
  startDatetime?: string;
  startTime?: string;
  createdAt?: string;
  rideDuration?: string;
  heartrate?: number;
  watt?: number;
  elevation?: number;
  /** 距离单位是公里 */
  distanceKm?: number;
  distance?: number;
  totalDistance?: number;
  duration?: number;
  durationSeconds?: number;
  totalTime?: number;
  avgHeartRate?: number;
  avgPower?: number;
  avgCadence?: number;
}

/**
 * 列表：POST https://service14.mywhoosh.com/v2/rider/profile/activities
 * body {page, limit, sortDate:"DESC"}
 *
 * 平台返回结构在多个版本间有差异，参考项目的做法是兼容多种容器形态，
 * 这里沿用同一思路（data.results / data[] / activities / results / rides / rideHistory）。
 */
/**
 * MyWhoosh 活动列表：POST /v2/rider/profile/activities
 *
 * 增量策略同迈金：**按时间早停**（sortDate=DESC 是时间倒序），
 * 不用页码游标（页码含义会随 limit 漂移）。
 */
export async function listActivities(
  client: MyWhooshClient,
  cred: Credential,
  opts: { cursor?: string; limit?: number; since?: string } = {},
): Promise<Paged<RemoteActivity>> {
  const token = String(cred.secret.accessToken ?? '');
  const limit = opts.limit ?? 50;
  const sinceMs = opts.since ? Date.parse(opts.since) : undefined;

  const items: RemoteActivity[] = [];
  let page = 1;
  let hasMore = false;

  for (let round = 0; round < 50; round++) {
    const res = await client.api<Record<string, unknown>>('/activities', token, {
      page,
      limit,
      sortDate: 'DESC',
    });

    if (res.status === 401) {
      throw new Error('MyWhoosh token 过期（401）');
    }
    if (!res.ok) {
      throw new Error('MyWhoosh 活动列表 HTTP ' + res.status);
    }

    const rawList = extractList(res.json);
    if (rawList.length === 0) {
      hasMore = false;
      break;
    }

    let reachedSince = false;
    for (const raw of rawList) {
      const item = toRemoteActivity(raw);
      if (!item) continue;
      if (sinceMs !== undefined && item.startTime) {
        const t = Date.parse(item.startTime);
        if (Number.isFinite(t) && t < sinceMs) {
          reachedSince = true;
          break;
        }
      }
      items.push(item);
      if (items.length >= limit) break;
    }

    if (reachedSince || items.length >= limit) {
      hasMore = !reachedSince;
      break;
    }
    if (rawList.length < limit) {
      hasMore = false;
      break;
    }
    page++;
  }

  return { items, hasMore };
}

/** 兼容多种响应容器形态 */
export function extractList(body: unknown): MyWhooshActivityItem[] {
  if (!body || typeof body !== 'object') return [];
  const json = body as Record<string, unknown>;

  const data = json.data;
  if (Array.isArray(data)) return data as MyWhooshActivityItem[];
  if (data && typeof data === 'object') {
    const results = (data as Record<string, unknown>).results;
    if (Array.isArray(results)) return results as MyWhooshActivityItem[];
  }
  for (const key of ['activities', 'results', 'rides', 'rideHistory']) {
    const v = json[key];
    if (Array.isArray(v)) return v as MyWhooshActivityItem[];
  }
  return [];
}

function toRemoteActivity(
  it: MyWhooshActivityItem,
): RemoteActivity | undefined {
  const id = it.id ?? it._id;
  if (id === undefined || id === null) return undefined;
  // 没有 activityFileId 就无法下载，仍返回元数据，下载阶段再报明确错误
  const distanceKm = it.distanceKm ?? it.distance ?? it.totalDistance;
  const startTime =
    it.startDatetime ?? normalizeDate(it.date) ?? it.startTime ?? it.createdAt;
  const name =
    it.name ?? it.title ?? it.routeName ??
    (startTime ? 'MyWhoosh 骑行 ' + String(startTime).slice(0, 10) : 'MyWhoosh 骑行');
  return {
    remoteId: String(id),
    name,
    startTime,
    distanceMeters:
      distanceKm === undefined ? undefined : distanceKm * 1000,
    durationSec:
      it.duration ?? it.durationSeconds ?? it.totalTime ?? parseRideDuration(it.rideDuration),
    avgHeartRate: it.avgHeartRate ?? it.heartrate,
    avgPower: it.avgPower ?? it.watt,
    avgCadence: it.avgCadence,
    raw: it,
  };
}

/** unix 秒 → ISO */
function normalizeDate(v: string | number | undefined): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const num = typeof v === 'number' ? v : Number(v);
  if (Number.isFinite(num)) {
    // 10 位=秒，13 位=毫秒
    const ms = num < 1e11 ? num * 1000 : num;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  }
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** "02:35:30.000" → 秒 */
function parseRideDuration(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const parts = v.split(':').map((x) => Number(x));
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return undefined;
  return parts[0]! * 3600 + parts[1]! * 60 + Math.floor(parts[2]!);
}

/** 详情：MyWhoosh 列表项里已带 activityFileId，无需额外请求 */
export function toDetail(activity: RemoteActivity): RemoteActivityDetail {
  const raw = (activity.raw ?? {}) as { activityFileId?: string };
  return {
    ...activity,
    fileId: raw.activityFileId,
    coordinateSystem: 'wgs84',
  };
}
