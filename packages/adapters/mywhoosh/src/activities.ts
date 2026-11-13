import type {
  Credential,
  Paged,
  RemoteActivity,
  RemoteActivityDetail,
} from '@fitbridge/core';
import { MyWhooshClient } from './client.js';

interface MyWhooshActivityItem {
  id?: string | number;
  _id?: string | number;
  name?: string;
  title?: string;
  /** 下载必需的 activityFileId；缺失则无法下载 */
  activityFileId?: string;
  date?: string;
  startTime?: string;
  createdAt?: string;
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
export async function listActivities(
  client: MyWhooshClient,
  cred: Credential,
  opts: { cursor?: string; limit?: number } = {},
): Promise<Paged<RemoteActivity>> {
  const token = String(cred.secret.accessToken ?? '');
  const page = Number(opts.cursor ?? 1) || 1;
  const limit = opts.limit ?? 50;

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
  const items: RemoteActivity[] = rawList
    .map((it) => toRemoteActivity(it))
    .filter((x): x is RemoteActivity => x !== undefined);

  return {
    items,
    cursor: rawList.length >= limit ? String(page + 1) : undefined,
    hasMore: rawList.length >= limit,
  };
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
  return {
    remoteId: String(id),
    name: it.name ?? it.title ?? 'MyWhoosh 骑行',
    startTime: it.date ?? it.startTime ?? it.createdAt,
    distanceMeters:
      distanceKm === undefined ? undefined : distanceKm * 1000,
    durationSec: it.duration ?? it.durationSeconds ?? it.totalTime,
    avgHeartRate: it.avgHeartRate,
    avgPower: it.avgPower,
    avgCadence: it.avgCadence,
    raw: it,
  };
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
