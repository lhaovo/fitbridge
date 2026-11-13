import type {
  Credential,
  Paged,
  RemoteActivity,
  RemoteActivityDetail,
} from '@fitbridge/core';
import { OtmClient } from './client.js';

interface OtmListItem {
  id?: string | number;
  rideId?: string | number;
  title?: string;
  name?: string;
  distance?: number;
  totalDistance?: number;
  ridingTime?: number;
  ridingDuration?: number;
  startTime?: string | number;
  startTimestamp?: string | number;
  rideType?: string;
  sportType?: string;
  avgHeartRate?: number;
  avgPower?: number;
  elevationGain?: number;
}

interface OtmListData {
  list?: OtmListItem[];
  records?: OtmListItem[];
  pagination?: {
    has_more?: boolean;
    hasMore?: boolean;
    page?: number;
    total?: number;
  };
}

/** 迈金列表：POST /api/otm/ride_record/list，body {page, limit} */
export async function listActivities(
  client: OtmClient,
  cred: Credential,
  opts: { cursor?: string; limit?: number } = {},
): Promise<Paged<RemoteActivity>> {
  const token = String(cred.secret.token ?? '');
  const page = Number(opts.cursor ?? 1) || 1;
  const limit = opts.limit ?? 50;

  const res = await client.request<OtmListData>(
    '/api/otm/ride_record/list',
    token,
    {
      method: 'POST',
      json: { page, limit },
    },
  );
  const env = OtmClient.assertOk<OtmListData>(res, '迈金活动列表');
  const data = env.data ?? {};
  const rawList = data.list ?? data.records ?? [];
  const pagination = data.pagination ?? {};

  const items: RemoteActivity[] = rawList
    .map((it) => toRemoteActivity(it))
    .filter((x): x is RemoteActivity => x !== undefined);

  const hasMore =
    pagination.has_more ?? pagination.hasMore ?? rawList.length >= limit;

  return {
    items,
    cursor: hasMore ? String(page + 1) : undefined,
    hasMore,
  };
}

/** 迈金详情：GET /api/otm/ride_record/analysis/{id} */
export async function getActivityDetail(
  client: OtmClient,
  cred: Credential,
  remoteId: string,
): Promise<RemoteActivityDetail> {
  const token = String(cred.secret.token ?? '');
  const res = await client.request<{
    ridingRecord?: {
      durl?: string;
      fitUrl?: string;
      title?: string;
      distance?: number;
      ridingTime?: number;
      startTime?: string | number;
    };
  }>('/api/otm/ride_record/analysis/' + remoteId, token);

  const env = OtmClient.assertOk<{
    ridingRecord?: {
      durl?: string;
      fitUrl?: string;
      title?: string;
      distance?: number;
      ridingTime?: number;
      startTime?: string | number;
    };
  }>(res, '迈金活动详情');
  const rec = env.data?.ridingRecord ?? {};

  return {
    remoteId,
    name: rec.title,
    startTime: normalizeTimestamp(rec.startTime),
    distanceMeters: rec.distance,
    durationSec: rec.ridingTime,
    // 文件级坐标系：durl 是七牛直链（WGS-84），fit_content 是 GCJ-02
    coordinateSystem: rec.fitUrl ? 'gcj02' : rec.durl ? 'wgs84' : undefined,
    raw: rec,
  };
}

function toRemoteActivity(it: OtmListItem): RemoteActivity | undefined {
  const id = it.id ?? it.rideId;
  if (id === undefined || id === null) return undefined;
  return {
    remoteId: String(id),
    name: it.title ?? it.name,
    sportType: it.rideType ?? it.sportType,
    startTime: normalizeTimestamp(it.startTime ?? it.startTimestamp),
    distanceMeters: it.distance ?? it.totalDistance,
    durationSec: it.ridingTime ?? it.ridingDuration,
    elevationGainMeters: it.elevationGain,
    avgHeartRate: it.avgHeartRate,
    avgPower: it.avgPower,
    raw: it,
  };
}

/** 迈金时间可能是秒级时间戳、毫秒级时间戳或 ISO 字符串 */
export function normalizeTimestamp(
  value: string | number | undefined,
): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'number') {
    // 10 位=秒，13 位=毫秒
    const ms = value < 1e11 ? value * 1000 : value;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric) && String(numeric) === value.trim()) {
    return normalizeTimestamp(numeric);
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}
