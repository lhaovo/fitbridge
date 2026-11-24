import type { Database } from './db.js';
import type { FileStore, StoredActivity } from '@fitbridge/core';
import { readFit, convertTrack, type FitSummary } from '@fitbridge/fitkit';

/**
 * 活动详情：轨迹点 + 指标序列 + 跨平台关联活动。
 *
 * 轨迹点直接从存储的 FIT blob 现场解析（不额外落库），
 * 因为 FIT 解析很快（单文件 ~10ms），而落库会引入第二份数据要同步清理。
 */

export interface TrackPointDto {
  /** 相对开始时间的秒数 */
  t: number;
  lat: number;
  lon: number;
  alt?: number;
  speed?: number;
  hr?: number;
  power?: number;
  cadence?: number;
}

export interface MetricSeries {
  key: 'speed' | 'hr' | 'power' | 'cadence' | 'alt';
  label: string;
  unit: string;
  points: Array<{ t: number; v: number }>;
  min: number;
  max: number;
  avg: number;
}

export interface ActivityTrackDto {
  activityId: string;
  hasFit: boolean;
  /** FIT 文件的原始坐标系（wgs84 / gcj02 / unknown） */
  coordinateSystem: string;
  /** 轨迹点是否被转换过（转换方向 → wgs84） */
  convertedTo?: string;
  pointCount: number;
  /** 是否被抽样（原始点太多） */
  sampled: boolean;
  track: TrackPointDto[];
  series: MetricSeries[];
  summary?: {
    distanceMeters?: number;
    durationSec?: number;
    avgSpeedMps?: number;
    maxSpeedMps?: number;
    avgHeartRate?: number;
    maxHeartRate?: number;
    avgPower?: number;
    maxPower?: number;
    avgCadence?: number;
    elevationGainM?: number;
    startTime?: string;
    endTime?: string;
    timezoneOffsetMin?: number;
    sportType: string;
  };
  warnings: string[];
}

const MAX_TRACK_POINTS = 1200;

/** 解析活动文件，返回轨迹与指标序列 */
export interface BuildTrackOptions {
  /**
   * 坐标系归一：'wgs84' 时把 GCJ-02 轨迹转换到 WGS-84，
   * 这样跨平台叠加对比才能对齐（迈金是 GCJ-02，MyWhoosh 是 WGS-84）。
   */
  convertTo?: 'wgs84' | 'none';
}

export async function buildTrack(
  db: Database,
  files: FileStore,
  activity: StoredActivity,
  fileRows: Array<{ kind: string; blobKey: string; expired: boolean; coordinateSystem?: string }>,
  options: BuildTrackOptions = {},
): Promise<ActivityTrackDto> {
  const dto: ActivityTrackDto = {
    activityId: activity.id,
    hasFit: false,
    coordinateSystem: 'unknown',
    pointCount: 0,
    sampled: false,
    track: [],
    series: [],
    warnings: [],
  };

  const fitFile = fileRows.find((f) => f.kind === 'fit' && !f.expired);
  if (!fitFile) {
    dto.warnings.push('没有可用的 FIT 文件（可能已过保留期被清理）');
    return dto;
  }

  let summary: FitSummary;
  try {
    const content = await files.get(fitFile.blobKey);
    // maxTrackPoints=0 → 不截断，详情页要看到完整轨迹
    // （fitkit 默认 5000 点上限，会把长骑行的尾巴切掉，图表 x 轴也就对不上了）
    summary = await readFit(content, { maxTrackPoints: 0 });
  } catch (err) {
    dto.warnings.push(
      'FIT 解析失败: ' + (err instanceof Error ? err.message : String(err)),
    );
    return dto;
  }

  dto.hasFit = true;
  dto.coordinateSystem = fitFile.coordinateSystem || 'unknown';
  dto.pointCount = summary.trackPointCount || summary.track.length;

  const raw = summary.track;
  const step = raw.length > MAX_TRACK_POINTS ? Math.ceil(raw.length / MAX_TRACK_POINTS) : 1;
  const sampled = step > 1 ? raw.filter((_, i) => i % step === 0) : raw;
  // 保证保留最后一个点
  if (sampled.length && raw.length && sampled[sampled.length - 1] !== raw[raw.length - 1]) {
    sampled.push(raw[raw.length - 1]!);
  }

  const t0 = raw.length ? raw[0]!.t : 0;
  dto.sampled = step > 1;

  // 坐标系归一（默认转到 WGS-84，便于跨平台对比）
  let pts = sampled;
  const wantWgs84 = (options.convertTo ?? 'wgs84') === 'wgs84';
  if (wantWgs84 && dto.coordinateSystem === 'gcj02' && pts.length) {
    pts = convertTrack(pts, 'to-wgs84');
    dto.convertedTo = 'wgs84';
  }

  dto.track = pts.map((p) => {
    const o: TrackPointDto = {
      t: Math.round((p.t - t0) / 1000),
      lat: p.lat,
      lon: p.lon,
    };
    if (p.alt !== undefined) o.alt = p.alt;
    if (p.speed !== undefined) o.speed = p.speed;
    if (p.hr !== undefined) o.hr = p.hr;
    if (p.power !== undefined) o.power = p.power;
    if (p.cadence !== undefined) o.cadence = p.cadence;
    return o;
  });

  dto.series = buildSeries(dto.track);
  dto.warnings.push(...summary.warnings);

  dto.summary = {
    distanceMeters: summary.totalDistanceM,
    durationSec: summary.totalElapsedSec,
    avgSpeedMps: summary.avgSpeedMps,
    maxSpeedMps: summary.maxSpeedMps,
    avgHeartRate: summary.avgHeartRate,
    maxHeartRate: summary.maxHeartRate,
    avgPower: summary.avgPower,
    maxPower: summary.maxPower,
    avgCadence: summary.avgCadence,
    elevationGainM: summary.elevationGainM,
    startTime: summary.startTime,
    endTime: summary.endTime,
    timezoneOffsetMin: summary.timezoneOffsetMin,
    sportType: summary.sportType,
  };

  return dto;
}

/** 从轨迹点构造各指标的时间序列 */
function buildSeries(track: TrackPointDto[]): MetricSeries[] {
  const defs: Array<{
    key: MetricSeries['key'];
    label: string;
    unit: string;
    pick: (p: TrackPointDto) => number | undefined;
  }> = [
    { key: 'speed', label: '速度', unit: 'km/h', pick: (p) => (p.speed === undefined ? undefined : p.speed * 3.6) },
    { key: 'hr', label: '心率', unit: 'bpm', pick: (p) => p.hr },
    { key: 'power', label: '功率', unit: 'W', pick: (p) => p.power },
    { key: 'cadence', label: '踏频', unit: 'rpm', pick: (p) => p.cadence },
    { key: 'alt', label: '海拔', unit: 'm', pick: (p) => p.alt },
  ];

  const out: MetricSeries[] = [];
  for (const d of defs) {
    const points: Array<{ t: number; v: number }> = [];
    for (const p of track) {
      const v = d.pick(p);
      if (v !== undefined && Number.isFinite(v)) points.push({ t: p.t, v });
    }
    if (points.length < 2) continue;
    let min = points[0]!.v;
    let max = points[0]!.v;
    let sum = 0;
    for (const p of points) {
      if (p.v < min) min = p.v;
      if (p.v > max) max = p.v;
      sum += p.v;
    }
    out.push({
      key: d.key,
      label: d.label,
      unit: d.unit,
      points,
      min,
      max,
      avg: sum / points.length,
    });
  }
  return out;
}

/**
 * 找出同一条活动在其他平台的副本。
 *
 * 匹配条件：开始时间相差 <= 5 分钟，且距离相差 <= 2%。
 * 跨平台同步后同一条骑行会在多个平台各存一份，这个视图能直观看出
 * 两个平台的数据差异（尤其是坐标系转换是否正确）。
 */
export function findRelated(
  db: Database,
  activity: StoredActivity,
  windowSec = 300,
  distanceTolerance = 0.02,
): Array<{
  id: string;
  platformId: string;
  name: string;
  startTime?: string;
  distanceMeters: number;
  durationSec: number;
  coordinateSystem: string;
  distanceDiffPct: number;
  timeDiffSec: number;
}> {
  if (!activity.startTime) return [];
  const t0 = Date.parse(activity.startTime);
  if (!Number.isFinite(t0)) return [];

  const rows = db.query<{
    id: string;
    source_platform: string;
    name: string;
    start_time: string | null;
    distance_m: number;
    duration_sec: number;
    coord_system: string | null;
  }>(
    `SELECT a.id, a.source_platform, a.name, a.start_time, a.distance_m, a.duration_sec,
            (SELECT f.coord_system FROM activity_files f
              WHERE f.activity_id = a.id AND f.kind = 'fit' AND f.expired_at IS NULL
              ORDER BY f.created_at LIMIT 1) AS coord_system
       FROM activities a
      WHERE a.id <> ?
        AND a.start_time IS NOT NULL
        AND a.start_time BETWEEN ? AND ?`,
    [
      activity.id,
      new Date(t0 - windowSec * 1000).toISOString(),
      new Date(t0 + windowSec * 1000).toISOString(),
    ],
  );

  const d0 = activity.distanceMeters || 0;
  return rows
    .map((r) => {
      const t1 = Date.parse(r.start_time!);
      const timeDiffSec = Math.abs(t1 - t0) / 1000;
      const distDiff = d0 ? Math.abs(r.distance_m - d0) / d0 : 0;
      return {
        id: r.id,
        platformId: r.source_platform,
        name: r.name,
        startTime: r.start_time ?? undefined,
        distanceMeters: r.distance_m,
        durationSec: r.duration_sec,
        coordinateSystem: r.coord_system || 'unknown',
        distanceDiffPct: distDiff * 100,
        timeDiffSec,
      };
    })
    .filter((r) => r.distanceDiffPct <= distanceTolerance * 100)
    .sort((a, b) => a.distanceDiffPct - b.distanceDiffPct);
}
