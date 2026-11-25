import { FitEncoder, FitBaseType } from 'fit-file-parser';
import type { FitSummary, TrackPoint } from './types.js';

/**
 * FIT 重建（把任意来源的 FIT 改写成「标准结构」的 FIT）。
 *
 * ## 为什么需要
 *
 * 迈金/顽鹿 OTM 的上传接口是**异步入库**：接口返回 `success_count >= 1`
 * 只代表「文件收到了」，入库由后台异步做。实测：
 *
 * | 上传的文件 | 结构 | 迈金列表 |
 * |---|---|---|
 * | 迈金原生文件 | 每 5km 一个 lap、`sport` 消息、`device_info`、`sub_sport=252` | ✅ 出现 |
 * | MyWhoosh 原生文件 | **整个活动只有 1 个 lap**、无 `sport`/`device_info`、`sub_sport=virtual_activity` | ❌ 被静默丢弃（接口仍返回 success_count=1） |
 *
 * 也就是说：**接口说成功 ≠ 数据入库**。不重建就传，表现为「上传成功但列表里没有」。
 *
 * 重建时对齐迈金原生文件的结构：
 *   - 每 `lapDistanceM`（默认 5km，与迈金一致）切一个 lap，并写全 lap 汇总字段
 *   - `sub_sport` 用 252（generic），不用 `virtual_activity`
 *   - 补 `sport`(12) 消息、`device_info`(23) 消息
 *   - session 的 avg_speed 按「距离/移动时间」自算（源文件里这个字段经常是坏的）
 *
 * ## 保真度
 *
 * 轨迹点的时间、经纬度、海拔、心率、功率、踏频、速度都按原值写入；
 * 丢掉的只有「设备身份信息」（序列号/型号换成了通用值）和
 * 「源文件里就已经不可信的汇总字段」（avg_speed 之类）。
 */

/** FIT 坐标单位：半圆（semicircle） */
const SEMICIRCLES = 2 ** 31 / 180;

const u8 = (number: number, value: number) => ({
  number,
  size: 1,
  baseType: FitBaseType.Uint8,
  value,
});
const u16 = (number: number, value: number) => ({
  number,
  size: 2,
  baseType: FitBaseType.Uint16,
  value,
});
const u16z = (number: number, value: number) => ({
  number,
  size: 2,
  baseType: FitBaseType.Uint16z,
  value,
});
const u32 = (number: number, value: number) => ({
  number,
  size: 4,
  baseType: FitBaseType.Uint32,
  value,
});
const u32z = (number: number, value: number) => ({
  number,
  size: 4,
  baseType: FitBaseType.Uint32z,
  value,
});
const s32 = (number: number, value: number) => ({
  number,
  size: 4,
  baseType: FitBaseType.Sint32,
  value,
});
const enumF = (number: number, value: number) => ({
  number,
  size: 1,
  baseType: FitBaseType.Enum,
  value,
});
const strF = (number: number, value: string) => {
  const bytes = FitEncoder.string(value);
  return {
    number,
    size: bytes.length,
    baseType: FitBaseType.String,
    value: bytes,
  };
};

/** FIT sport 枚举 */
export const FIT_SPORT = {
  generic: 0,
  running: 1,
  cycling: 2,
  walking: 4,
} as const;

/** FIT sub_sport：252 = generic（不用 virtual_activity=0，避免被当虚拟活动丢掉） */
export const FIT_SUB_SPORT_GENERIC = 252;

/** 默认每个 lap 的距离（米）—— 迈金原生文件就是每 5km 一个 lap */
const DEFAULT_LAP_DISTANCE_M = 5000;

/** 超过这个间隔（秒）视为暂停，不计入移动时间 */
const AUTO_PAUSE_SEC = 60;

export interface RebuildFitOptions {
  /** 源 FIT 的解析结果（track 必须是不截断的，见 readFit 的 maxTrackPoints: 0） */
  summary: FitSummary;
  /** file_id 的 manufacturer */
  manufacturer?: number;
  /** file_id 的 product */
  product?: number;
  /** file_id 的序列号 */
  serialNumber?: number;
  /** file_id 的型号名 */
  productName?: string;
  /** FIT sport 枚举值 */
  sport?: number;
  /** FIT sub_sport 枚举值（默认 252 generic） */
  subSport?: number;
  /** 每个 lap 的距离（米），默认 5000 */
  lapDistanceM?: number;
  /** 时区偏移（分钟），用于写 local_timestamp */
  timezoneOffsetMin?: number;
  /** 设备描述（写进 device_info） */
  deviceDescriptor?: string;
}

export interface RebuildFitResult {
  content: Buffer;
  warnings: string[];
  lapCount: number;
  recordCount: number;
}

/** 一个 lap 的统计 */
interface LapStat {
  startTime: Date;
  endTime: Date;
  elapsedSec: number;
  timerSec: number;
  distanceM: number;
  ascentM: number;
  descentM: number;
  avgSpeedMps: number;
  maxSpeedMps: number;
  avgHr?: number;
  maxHr?: number;
  avgPower?: number;
  maxPower?: number;
  avgCadence?: number;
  maxCadence?: number;
  startLat?: number;
  startLon?: number;
  endLat?: number;
  endLon?: number;
  points: TrackPoint[];
}

/**
 * 把解析出来的轨迹点补齐成「带累计距离」的版本。
 *
 * 源文件不一定给 record.distance（有些只给 speed），这时用经纬度
 * 累加距离（等距圆柱近似，够用）。
 */
function withDistance(points: TrackPoint[]): { points: TrackPoint[]; totalM: number } {
  const out: TrackPoint[] = [];
  let cum = 0;
  let prev: TrackPoint | undefined;
  for (const p of points) {
    const dist = p.distance ?? cum;
    if (prev) {
      const d = dist - cum;
      if (d > 0 && d < 1000) cum = d;
      else if (p.distance === undefined) {
        // 没有 distance 字段 → 用经纬度累加
        const R = 6371000;
        const dLat = ((p.lat - prev.lat) * Math.PI) / 180;
        const dLon = ((p.lon - prev.lon) * Math.PI) / 180;
        const a =
          Math.sin(dLat / 2) ** 2 +
          Math.cos((prev.lat * Math.PI) / 180) *
            Math.cos((p.lat * Math.PI) / 180) *
            Math.sin(dLon / 2) ** 2;
        cum += 2 * R * Math.asin(Math.sqrt(a));
      }
    }
    const next: TrackPoint = { ...p, distance: p.distance ?? cum };
    out.push(next);
    prev = next;
  }
  return { points: out, totalM: cum };
}

/** 计算一段点的统计 */
function statOf(points: TrackPoint[]): LapStat | undefined {
  if (points.length === 0) return undefined;
  const first = points[0]!;
  const last = points[points.length - 1]!;

  let elapsedSec = (last.t - first.t) / 1000;
  if (elapsedSec < 0) elapsedSec = 0;

  // 移动时间：间隔超过 AUTO_PAUSE_SEC 的算暂停，不计入
  let timerSec = 0;
  for (let i = 1; i < points.length; i++) {
    const gap = (points[i]!.t - points[i - 1]!.t) / 1000;
    if (gap > 0 && gap <= AUTO_PAUSE_SEC) timerSec += gap;
  }
  if (timerSec === 0) timerSec = elapsedSec;

  const distanceM = Math.max(0, (last.distance ?? 0) - (first.distance ?? 0));

  let ascentM = 0;
  let descentM = 0;
  for (let i = 1; i < points.length; i++) {
    const d = (points[i]!.alt ?? 0) - (points[i - 1]!.alt ?? 0);
    if (d > 0) ascentM += d;
    else descentM -= d;
  }

  const hrs = points.map((p) => p.hr).filter((v): v is number => v != null);
  const pws = points.map((p) => p.power).filter((v): v is number => v != null);
  const cads = points.map((p) => p.cadence).filter((v): v is number => v != null);
  const spds = points.map((p) => p.speed).filter((v): v is number => v != null);

  const avg = (a: number[]) =>
    a.length ? a.reduce((x, y) => x + y, 0) / a.length : undefined;

  return {
    startTime: new Date(first.t),
    endTime: new Date(last.t),
    elapsedSec,
    timerSec,
    distanceM,
    ascentM,
    descentM,
    avgSpeedMps: timerSec > 0 ? distanceM / timerSec : 0,
    maxSpeedMps: spds.length ? Math.max(...spds) : 0,
    avgHr: avg(hrs),
    maxHr: hrs.length ? Math.max(...hrs) : undefined,
    avgPower: avg(pws),
    maxPower: pws.length ? Math.max(...pws) : undefined,
    avgCadence: avg(cads),
    maxCadence: cads.length ? Math.max(...cads) : undefined,
    startLat: first.lat,
    startLon: first.lon,
    endLat: last.lat,
    endLon: last.lon,
    points,
  };
}

/**
 * 重建一个「迈金能入库」的 FIT。
 */
export function rebuildFit(opts: RebuildFitOptions): RebuildFitResult {
  const warnings: string[] = [];
  const {
    summary,
    manufacturer = 255, // development
    product = 1,
    serialNumber = 1,
    productName = 'FitBridge',
    sport = FIT_SPORT.cycling,
    subSport = FIT_SUB_SPORT_GENERIC,
    lapDistanceM = DEFAULT_LAP_DISTANCE_M,
    timezoneOffsetMin,
    deviceDescriptor = 'FitBridge',
  } = opts;

  const raw = summary.track ?? [];
  if (raw.length < 2) {
    throw new Error('轨迹点不足，无法重建 FIT（至少需要 2 个点）');
  }
  if (summary.trackTruncated) {
    warnings.push('轨迹点被截断，重建后的 FIT 会缺少部分轨迹');
  }

  const { points, totalM } = withDistance(raw);

  // ── 按距离切 lap ─────────────────────────────────────
  const laps: LapStat[] = [];
  let bucket: TrackPoint[] = [];
  let bucketStartDist = 0;
  for (const p of points) {
    bucket.push(p);
    const d = (p.distance ?? 0) - bucketStartDist;
    if (d >= lapDistanceM) {
      const st = statOf(bucket);
      if (st) laps.push(st);
      bucket = [];
      bucketStartDist = p.distance ?? 0;
    }
  }
  const tail = statOf(bucket);
  if (tail && (tail.distanceM > 1 || laps.length === 0)) laps.push(tail);

  if (laps.length === 0) {
    throw new Error('切分 lap 失败');
  }

  const session = statOf(points);
  if (!session) throw new Error('计算 session 统计失败');

  // ── 写 FIT ───────────────────────────────────────────
  const enc = new FitEncoder();
  const startFitTs = FitEncoder.toFitTimestamp(session.startTime);

  // file_id (0)
  enc.writeMessage(0, [
    enumF(0, 4), // type = activity
    u16(1, manufacturer),
    u16(2, product),
    u32z(3, serialNumber),
    u32(4, startFitTs),
    strF(8, productName),
  ]);

  // device_info (23) —— 迈金原生文件都有，缺了可能被丢
  enc.writeMessage(23, [
    u8(0, 0), // device_index
    u8(1, 120), // device_type = fitness_equipment
    u16(2, manufacturer),
    u32z(3, serialNumber),
    u16(4, product),
    strF(19, deviceDescriptor),
    u32(253, startFitTs),
  ]);

  // sport (12)
  enc.writeMessage(12, [enumF(0, sport), enumF(1, subSport)]);

  // session (18)
  const sessionFields = [
    enumF(0, 8), // event = session
    enumF(1, 1), // event_type = stop
    u32(2, startFitTs),
    enumF(5, sport),
    enumF(6, subSport),
    u32(7, Math.round(session.elapsedSec * 1000)),
    u32(8, Math.round(session.timerSec * 1000)),
    u32(9, Math.round(session.distanceM * 100)),
    u16(11, Math.min(65535, Math.round(summary.calories ?? 0))),
    u16(14, Math.min(65535, Math.round(session.avgSpeedMps * 1000))),
    u16(15, Math.min(65535, Math.round(session.maxSpeedMps * 1000))),
  ];
  if (session.avgHr != null) sessionFields.push(u8(16, Math.round(session.avgHr)));
  if (session.maxHr != null) sessionFields.push(u8(17, Math.round(session.maxHr)));
  if (session.avgCadence != null) sessionFields.push(u8(18, Math.round(session.avgCadence)));
  if (session.maxCadence != null) sessionFields.push(u8(19, Math.round(session.maxCadence)));
  if (session.avgPower != null) sessionFields.push(u16(20, Math.round(session.avgPower)));
  if (session.maxPower != null) sessionFields.push(u16(21, Math.round(session.maxPower)));
  sessionFields.push(u16(22, Math.round(session.ascentM)));
  sessionFields.push(u16(23, Math.round(session.descentM)));
  sessionFields.push(u16(26, laps.length)); // num_laps
  if (session.startLat != null) sessionFields.push(s32(3, Math.round(session.startLat * SEMICIRCLES)));
  if (session.startLon != null) sessionFields.push(s32(4, Math.round(session.startLon * SEMICIRCLES)));
  if (session.endLat != null) sessionFields.push(s32(38, Math.round(session.endLat * SEMICIRCLES)));
  if (session.endLon != null) sessionFields.push(s32(39, Math.round(session.endLon * SEMICIRCLES)));
  enc.writeMessage(18, sessionFields);

  // lap (19) × N
  for (const lap of laps) {
    const f: ReturnType<typeof u32>[] = [
      enumF(0, 9), // event = lap
      enumF(1, 1), // event_type = stop
      u32(2, FitEncoder.toFitTimestamp(lap.startTime)),
      u32(7, Math.round(lap.elapsedSec * 1000)),
      u32(8, Math.round(lap.timerSec * 1000)),
      u32(9, Math.round(lap.distanceM * 100)),
      u16(13, Math.min(65535, Math.round(lap.avgSpeedMps * 1000))),
      u16(14, Math.min(65535, Math.round(lap.maxSpeedMps * 1000))),
      enumF(24, 2), // lap_trigger = distance
      enumF(25, sport),
    ];
    if (lap.avgHr != null) f.push(u8(15, Math.round(lap.avgHr)));
    if (lap.maxHr != null) f.push(u8(16, Math.round(lap.maxHr)));
    if (lap.avgCadence != null) f.push(u8(17, Math.round(lap.avgCadence)));
    if (lap.maxCadence != null) f.push(u8(18, Math.round(lap.maxCadence)));
    if (lap.avgPower != null) f.push(u16(19, Math.round(lap.avgPower)));
    if (lap.maxPower != null) f.push(u16(20, Math.round(lap.maxPower)));
    f.push(u16(21, Math.round(lap.ascentM)));
    f.push(u16(22, Math.round(lap.descentM)));
    if (lap.startLat != null) f.push(s32(3, Math.round(lap.startLat * SEMICIRCLES)));
    if (lap.startLon != null) f.push(s32(4, Math.round(lap.startLon * SEMICIRCLES)));
    if (lap.endLat != null) f.push(s32(5, Math.round(lap.endLat * SEMICIRCLES)));
    if (lap.endLon != null) f.push(s32(6, Math.round(lap.endLon * SEMICIRCLES)));
    enc.writeMessage(19, f);
  }

  // activity (34)
  const activityFields = [
    u32(0, Math.round(session.timerSec * 1000)),
    u16(1, 1), // num_sessions
    enumF(2, 0), // type = manual
    enumF(3, 26), // event = activity
    enumF(4, 1), // event_type = stop
    u32(253, startFitTs),
  ];
  if (timezoneOffsetMin != null) {
    activityFields.push(u32(5, startFitTs + timezoneOffsetMin * 60));
  }
  enc.writeMessage(34, activityFields);

  // event (21)：timer start / stop
  enc.writeMessage(21, [
    enumF(0, 0), // event = timer
    enumF(1, 0), // event_type = start
    u32(253, startFitTs),
  ]);
  enc.writeMessage(21, [
    enumF(0, 0), // event = timer
    enumF(1, 1), // event_type = stop
    u32(253, FitEncoder.toFitTimestamp(session.endTime)),
  ]);

  // record (20) × M
  for (const p of points) {
    const f: ReturnType<typeof u32>[] = [
      s32(0, Math.round(p.lat * SEMICIRCLES)),
      s32(1, Math.round(p.lon * SEMICIRCLES)),
      u32(5, Math.round((p.distance ?? 0) * 100)),
      u32(253, FitEncoder.toFitTimestamp(new Date(p.t))),
    ];
    if (p.alt != null) {
      f.push(u16(2, Math.max(0, Math.round((p.alt + 500) * 5))));
    }
    if (p.hr != null) f.push(u8(3, Math.round(p.hr)));
    if (p.cadence != null) f.push(u8(4, Math.round(p.cadence)));
    if (p.speed != null) f.push(u16(6, Math.min(65535, Math.round(p.speed * 1000))));
    if (p.power != null) f.push(u16(7, Math.round(p.power)));
    enc.writeMessage(20, f);
  }

  const content = Buffer.from(enc.close());
  return {
    content,
    warnings,
    lapCount: laps.length,
    recordCount: points.length,
  };
}

/**
 * 判断「这个 FIT 是否值得重建」。
 *
 * 两种情况需要重建：
 *   ① 整个活动只有 1 个 lap（等于没分段）
 *   ② sub_sport = virtual_activity（虚拟活动，严格平台会当虚拟记录丢掉）
 */
export function needsRebuild(summary: FitSummary): boolean {
  const lapCount = (summary.raw?.lap_count as number | undefined) ?? undefined;
  if (lapCount != null) return lapCount < 2;
  const sub = (summary.raw?.sub_sport as string | undefined) ?? undefined;
  if (sub === 'virtual_activity') return true;
  return false;
}
