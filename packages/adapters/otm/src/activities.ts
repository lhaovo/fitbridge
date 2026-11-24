import type {
  Credential,
  Paged,
  RemoteActivity,
  RemoteActivityDetail,
} from '@fitbridge/core';
import { OtmClient } from './client.js';

/**
 * 迈金列表项的真实字段（2026-11 实测确认）。
 *
 * ★ 注意：字段名与直觉差别很大，且 name 常常是 null。
 *   name              → 活动名（实测多为 null）
 *   distance_km       → 距离，单位**公里**（不是米）
 *   time_seconds      → 时长（秒）；time_formatted 是 "2:35:30" 展示串
 *   start_riding_time → 本地开始时间 "2026-11-21 13:03:35"（**无时区**）
 *   avg_speed_kmh     → 平均速度（km/h）
 *   avg_power_w       → 平均功率（w）
 *   avg_heart_bpm     → 平均心率（bpm）
 *   load_tss          → 训练压力
 *
 * 下面同时保留旧字段名做兼容，防止平台再次改版。
 */
/** 迈金活动详情记录（实测字段 + 兼容旧字段） */
interface OtmDetailRecord {
  durl?: string;
  fitUrl?: string;
  title?: string;
  name?: string | null;
  distance?: number;
  distance_km?: number;
  ridingTime?: number;
  time_seconds?: number;
  startTime?: string | number;
  start_riding_time?: string;
}

interface OtmListItem {
  id?: string | number;
  rideId?: string | number;
  title?: string | null;
  name?: string | null;
  distance?: number;
  distance_km?: number;
  totalDistance?: number;
  ridingTime?: number;
  ridingDuration?: number;
  time_seconds?: number;
  time_formatted?: string;
  startTime?: string | number;
  startTimestamp?: string | number;
  start_riding_time?: string;
  created_at?: string;
  rideType?: string;
  sportType?: string;
  avg_speed_kmh?: number;
  avgSpeed?: number;
  avg_heart_bpm?: number;
  avgHeartRate?: number;
  avg_power_w?: number;
  avgPower?: number;
  elevationGain?: number;
  elevation_gain?: number;
  load_tss?: number;
}

/** 迈金是中国平台，本地时间按 UTC+8 解释 */
const LOCAL_TZ_OFFSET_MIN = 480;

/**
 * 解析迈金的本地时间 "2026-11-21 13:03:35" → 带时区的 ISO。
 *
 * 该字段没有时区信息，只能按平台所在时区（UTC+8）补齐。
 */
export function parseLocalRidingTime(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const m =
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?/.exec(
      v.trim(),
    );
  if (!m) {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  }
  const [, y, mo, da, h, mi, s, frac] = m;
  const ms = frac ? Number(frac.padEnd(3, '0')) : 0;
  const utcMs =
    Date.UTC(
      Number(y),
      Number(mo) - 1,
      Number(da),
      Number(h),
      Number(mi),
      Number(s ?? '0'),
      ms,
    ) -
    LOCAL_TZ_OFFSET_MIN * 60000;
  const d = new Date(utcMs);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/**
 * 解析迈金的本地时间串 → 带时区偏移的 ISO（保留「当地墙钟」语义）。
 * 例："2026-11-21 13:03:35" → "2026-11-21T13:03:35+08:00"
 */
export function parseLocalWallClock(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const m =
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(
      v.trim(),
    );
  if (!m) return undefined;
  const [, y, mo, da, h, mi, s] = m;
  const abs = Math.abs(LOCAL_TZ_OFFSET_MIN);
  const sign = LOCAL_TZ_OFFSET_MIN >= 0 ? '+' : '-';
  const off =
    sign +
    String(Math.floor(abs / 60)).padStart(2, '0') +
    ':' +
    String(abs % 60).padStart(2, '0');
  return `${y}-${mo}-${da}T${h}:${mi}:${s ?? '00'}${off}`;
}

/**
 * 迈金的时间字段有两种形态：
 *   列表项   start_riding_time = "2026-11-21 13:03:35"（本地墙钟，无时区）
 *   详情记录 startRidingTime   = 1795237415000（unix 毫秒，绝对时刻）
 * 统一解析成 { utc, local }：utc 是绝对时刻，local 是「当地墙钟 + 偏移」。
 */
function parseOtmStart(v: unknown): { utc?: string; local?: string } {
  if (typeof v === 'string') {
    const utc = parseLocalRidingTime(v);
    if (utc) return { utc, local: parseLocalWallClock(v) };
  }
  const iso = normalizeTimestamp(v as string | number | undefined);
  if (!iso) return {};
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return {};
  const d = new Date(t + LOCAL_TZ_OFFSET_MIN * 60000);
  const p = (n: number) => String(n).padStart(2, '0');
  const abs = Math.abs(LOCAL_TZ_OFFSET_MIN);
  const off =
    (LOCAL_TZ_OFFSET_MIN >= 0 ? '+' : '-') +
    String(Math.floor(abs / 60)).padStart(2, '0') +
    ':' +
    String(abs % 60).padStart(2, '0');
  const local =
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}` +
    off;
  return { utc: iso, local };
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
/**
 * 迈金活动列表：POST /api/otm/ride_record/list
 *
 * 增量策略：**按时间早停**，不用页码游标。
 *
 * 列表按时间倒序排列，一旦遇到早于 since 的活动就停止翻页。
 * （用页码当游标是错的：页码含义会随 limit 变化而漂移，
 *   实测出现过「上次 limit=10 记下 cursor=2，这次 limit=20 从第 2 页开始 → 一条都没有」）
 */
export async function listActivities(
  client: OtmClient,
  cred: Credential,
  opts: { cursor?: string; limit?: number; since?: string } = {},
): Promise<Paged<RemoteActivity>> {
  const token = String(cred.secret.token ?? '');
  const limit = opts.limit ?? 50;
  const sinceMs = opts.since ? Date.parse(opts.since) : undefined;

  const items: RemoteActivity[] = [];
  let page = 1;
  let hasMore = false;

  // 最多翻 50 页，避免异常情况下无限翻页
  for (let round = 0; round < 50; round++) {
    const res = await client.request<OtmListData>(
      '/api/otm/ride_record/list',
      token,
      { method: 'POST', json: { page, limit } },
    );
    const env = OtmClient.assertOk<OtmListData>(res, '迈金活动列表');
    const data = env.data ?? {};
    const rawList = data.list ?? data.records ?? [];
    const pagination = data.pagination ?? {};

    if (rawList.length === 0) {
      hasMore = false;
      break;
    }

    let reachedSince = false;
    for (const raw of rawList) {
      const item = toRemoteActivity(raw);
      if (!item) continue;
      // 时间早于 since → 后面的只会更早，停
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

    const more = pagination.has_more ?? pagination.hasMore ?? rawList.length >= limit;
    if (!more) {
      hasMore = false;
      break;
    }
    page++;
  }

  return { items, hasMore };
}

/** 迈金详情：GET /api/otm/ride_record/analysis/{id} */
export async function getActivityDetail(
  client: OtmClient,
  cred: Credential,
  remoteId: string,
): Promise<RemoteActivityDetail> {
  const token = String(cred.secret.token ?? '');
  const res = await client.request<{ ridingRecord?: OtmDetailRecord }>(
    '/api/otm/ride_record/analysis/' + remoteId,
    token,
  );

  const env = OtmClient.assertOk<{ ridingRecord?: OtmDetailRecord }>(
    res,
    '迈金活动详情',
  );
  const rec = env.data?.ridingRecord ?? {};
  const started = parseOtmStart(
    (rec as { start_riding_time?: string; startRidingTime?: number })
      .start_riding_time ??
      (rec as { startRidingTime?: number }).startRidingTime ??
      rec.startTime,
  );

  return {
    remoteId,
    name: rec.title ?? rec.name ?? undefined,
    startTime: started.utc,
    localStartTime: started.local,
    distanceMeters:
      typeof (rec as { distance_km?: number }).distance_km === 'number'
        ? (rec as { distance_km: number }).distance_km * 1000
        : rec.distance,
    durationSec:
      (rec as { time_seconds?: number }).time_seconds ?? rec.ridingTime,
    // 文件级坐标系：durl 是七牛直链（WGS-84），fit_content 是 GCJ-02
    coordinateSystem: rec.fitUrl ? 'gcj02' : rec.durl ? 'wgs84' : undefined,
    // 迈金给的是本地时间串（无时区），按 UTC+8 解读 → 记录偏移量
    timezoneOffset: LOCAL_TZ_OFFSET_MIN,
    raw: rec,
  };
}

function toRemoteActivity(it: OtmListItem): RemoteActivity | undefined {
  const id = it.id ?? it.rideId;
  if (id === undefined || id === null) return undefined;

  const started = parseOtmStart(it.start_riding_time ?? it.startTime ?? it.startTimestamp);
  const startTime = started.utc;

  // 距离：优先 distance_km（公里），兼容旧字段（米）
  const distanceMeters =
    typeof it.distance_km === 'number'
      ? it.distance_km * 1000
      : (it.distance ?? it.totalDistance);

  // 时长：优先 time_seconds，兼容旧字段
  const durationSec =
    it.time_seconds ?? it.ridingTime ?? it.ridingDuration ?? parseHms(it.time_formatted);

  // 迈金的 name 常常是 null → 用日期生成一个可读的名字
  const name =
    it.name ??
    it.title ??
    (startTime ? '迈金骑行 ' + startTime.slice(0, 10) : undefined);

  return {
    remoteId: String(id),
    name,
    sportType: it.rideType ?? it.sportType ?? 'cycling',
    startTime,
    localStartTime: started.local,
    // 迈金给的是本地时间串（无时区），按 UTC+8 解读
    timezoneOffset: LOCAL_TZ_OFFSET_MIN,
    distanceMeters,
    durationSec,
    elevationGainMeters: it.elevation_gain ?? it.elevationGain,
    avgHeartRate: it.avg_heart_bpm ?? it.avgHeartRate,
    avgPower: it.avg_power_w ?? it.avgPower,
    raw: it,
  };
}

/** "2:35:30" → 秒 */
function parseHms(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const parts = v.split(':').map((x) => Number(x));
  if (parts.some((n) => !Number.isFinite(n))) return undefined;
  if (parts.length === 3) return parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
  if (parts.length === 2) return parts[0]! * 60 + parts[1]!;
  return parts[0];
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
