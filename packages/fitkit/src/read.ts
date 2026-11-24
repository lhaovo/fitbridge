import FitParser from 'fit-file-parser';
import type {
  CoordinateSystem,
  FitSummary,
  ReadFitOptions,
  SportType,
  TrackPoint,
} from './types.js';
import { mapFitSport } from './sport.js';

/**
 * FIT 只读解析（决策 D5：简单路线）。
 *
 * 基于 fit-file-parser v6.2.7（MIT）：
 * - force=false → 开启 CRC 校验（我们用它做「文件体检」，把坏文件标出来）
 * - 默认输出 position 为「度」、timestamp 为 UTC Date
 * - local_timestamp 用同一 epoch 解码，因此 local_timestamp - timestamp 正好等于时区偏移
 *
 * 不做（推到 M1）：GPX→FIT 构建、FIT 合规修复（时间戳溢出 / 非法 ASCII / data_size）、
 * 设备指纹伪装。见 build.ts / repair.ts。
 */

const DEFAULT_MAX_TRACK_POINTS = 5000;

export class FitParseError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'FitParseError';
  }
}

/** 解析 FIT 内容为活动摘要 */
export async function readFit(
  content: Buffer | ArrayBuffer,
  options: ReadFitOptions = {},
): Promise<FitSummary> {
  const {
    force = true,
    strict = false,
    maxTrackPoints = DEFAULT_MAX_TRACK_POINTS,
  } = options;

  let parsed;
  try {
    const parser = new FitParser({
      force,
      strict,
      mode: 'both',
      includeUnmappedMessages: true,
    });
    parsed = await parser.parseAsync(
      content as ArrayBuffer | Buffer<ArrayBuffer>,
    );
  } catch (err) {
    throw new FitParseError(
      `FIT 解析失败: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }

  const warnings: string[] = [];
  type Row = Record<string, unknown>;
  const sessions = (parsed.sessions ?? []) as unknown as Row[];
  const laps = (parsed.laps ?? []) as unknown as Row[];
  const records = (parsed.records ?? []) as unknown as Row[];
  const session = sessions[0];
  const lap = laps[0];

  // ── 运动类型 ──────────────────────────────────────────────
  const rawSport = session?.sport ?? lap?.sport ?? parsed.sports?.[0]?.name;
  const { sportType, rawSportType } = mapFitSport(rawSport as string | number | undefined);

  // ── 时间与时区 ────────────────────────────────────────────
  const startTime = session?.start_time ?? lap?.start_time ?? records[0]?.timestamp;
  const endTime = deriveEndTime(session, lap, records);

  // local_timestamp 与 timestamp 用同一 epoch 解码 → 差值即平台本地时区偏移
  let timezoneOffsetMin: number | undefined;
  let timezoneSource: FitSummary['timezoneSource'] = 'unknown';
  const activityLocal = parsed.activity?.local_timestamp;
  const activityTs = parsed.activity?.timestamp;
  if (activityLocal instanceof Date && activityTs instanceof Date) {
    const diffMin = Math.round((activityLocal.getTime() - activityTs.getTime()) / 60000);
    // 合理范围：±14h；超出说明平台写坏了 local_timestamp，忽略
    if (Math.abs(diffMin) <= 840) {
      timezoneOffsetMin = diffMin;
      timezoneSource = 'file-local-timestamp';
    } else {
      warnings.push(`local_timestamp 与 timestamp 差值异常(${diffMin}min)，已忽略`);
    }
  }

  // ── 轨迹 ─────────────────────────────────────────────────
  const trackPointCount = records.length;
  const capped = maxTrackPoints > 0 ? records.slice(0, maxTrackPoints) : records;
  const track = buildTrack(capped);
  if (maxTrackPoints > 0 && trackPointCount > capped.length) {
    warnings.push(
      `轨迹点超过上限 ${maxTrackPoints}，已截断（共 ${trackPointCount} 点）`,
    );
  }

  // ── 指标（session 优先，缺失时用 lap，最后从 record 聚合） ──
  const agg = aggregateFromRecords(records);

  const totalDistanceM =
    pickNumber(session?.total_distance, lap?.total_distance, agg.distance);
  const totalElapsedSec =
    pickNumber(session?.total_elapsed_time, lap?.total_elapsed_time, agg.elapsed);
  const totalTimerSec =
    pickNumber(session?.total_timer_time, lap?.total_timer_time, agg.timer);

  /**
   * 平均速度：自己按「距离 / 移动时间」算，不用文件里的 avg_speed。
   *
   * 原因（实测 20 个真实 FIT 文件）：FIT 语义上 avg_speed == total_distance /
   * total_timer_time（移动平均速度），但部分平台导出的文件里这个字段是坏的
   * ——实测有 3/20 个文件写成 0 或明显偏小（0.534 vs 真实 3.956 m/s）。
   * 自己算的结果与文件值一致（差异 <2%），所以以自算为准，文件值只做兜底。
   */
  const fileAvgSpeed = pickNumber(session?.avg_speed, lap?.avg_speed);
  const avgSpeedMps = deriveAvgSpeed({
    distanceM: totalDistanceM,
    timerSec: totalTimerSec,
    elapsedSec: totalElapsedSec,
    fileAvgSpeed,
    warnings,
  });

  const summary: FitSummary = {
    sportType,
    rawSportType,
    startTime: startTime instanceof Date ? startTime.toISOString() : undefined,
    endTime: endTime instanceof Date ? endTime.toISOString() : undefined,
    timezoneOffsetMin,
    timezoneSource,
    totalDistanceM,
    totalElapsedSec,
    totalTimerSec,
    elevationGainM: pickNumber(session?.total_ascent, lap?.total_ascent),
    elevationDescentM: pickNumber(session?.total_descent, lap?.total_descent),
    avgSpeedMps: avgSpeedMps ?? agg.avgSpeed,
    maxSpeedMps: pickNumber(session?.max_speed, lap?.max_speed, agg.maxSpeed),
    avgHeartRate: pickNumber(
      session?.avg_heart_rate,
      lap?.avg_heart_rate,
      agg.avgHr,
    ),
    maxHeartRate: pickNumber(session?.max_heart_rate, lap?.max_heart_rate, agg.maxHr),
    avgPower: pickNumber(session?.avg_power, lap?.avg_power, agg.avgPower),
    maxPower: pickNumber(session?.max_power, lap?.max_power, agg.maxPower),
    avgCadence: pickNumber(session?.avg_cadence, lap?.avg_cadence, agg.avgCadence),
    maxCadence: pickNumber(session?.max_cadence, lap?.max_cadence, agg.maxCadence),
    calories: pickNumber(session?.total_calories, lap?.total_calories),
    track,
    trackTruncated: maxTrackPoints > 0 && trackPointCount > capped.length,
    trackPointCount,
    hasPosition: track.some((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon)),
    hasHeartRate: agg.hasHr,
    hasPower: agg.hasPower,
    hasCadence: agg.hasCadence,
    warnings,
    raw: buildRaw(session, lap, parsed),
  };

  const createdAt = parsed.file_ids?.[0]?.time_created;
  if (createdAt instanceof Date) {
    summary.fileCreatedAt = createdAt.toISOString();
  }

  // force=false 时 CRC 校验失败会直接抛错；能走到这里说明 CRC 通过
  if (!force) {
    summary.crcValid = true;
  }

  return summary;
}

/**
 * 计算平均速度（m/s）。
 *
 * FIT 语义：avg_speed = total_distance / total_timer_time（移动平均速度，
 * 排除暂停）。优先自算；文件里的值只在自算不可用时兜底。
 */
function deriveAvgSpeed(args: {
  distanceM?: number;
  timerSec?: number;
  elapsedSec?: number;
  fileAvgSpeed?: number;
  warnings: string[];
}): number | undefined {
  const { distanceM, timerSec, elapsedSec, fileAvgSpeed, warnings } = args;
  const derivedTimer =
    distanceM && timerSec && timerSec > 0 ? distanceM / timerSec : undefined;
  const derivedElapsed =
    distanceM && elapsedSec && elapsedSec > 0 ? distanceM / elapsedSec : undefined;

  if (derivedTimer !== undefined) {
    if (
      fileAvgSpeed === undefined ||
      fileAvgSpeed <= 0 ||
      Math.abs(fileAvgSpeed - derivedTimer) / derivedTimer > 0.02
    ) {
      warnings.push(
        `FIT avg_speed 字段异常(${fileAvgSpeed ?? '缺失'})，已按 距离/移动时间 重算为 ` +
          `${derivedTimer.toFixed(3)} m/s`,
      );
    }
    return derivedTimer;
  }
  if (derivedElapsed !== undefined) {
    if (fileAvgSpeed === undefined || fileAvgSpeed <= 0) {
      warnings.push(
        `FIT avg_speed 字段缺失，已按 距离/总时长 重算为 ${derivedElapsed.toFixed(3)} m/s`,
      );
    }
    return derivedElapsed;
  }
  return fileAvgSpeed;
}

/**
 * 判断文件内容是不是 FIT（按 header + magic number）。
 *
 * FIT 文件头布局：
 *   byte  0      header size (12 或 14)
 *   byte  1      protocol version (0x10 = 1.0, 0x20 = 2.0)
 *   bytes 2-3    profile version (uint16 LE)
 *   bytes 4-7    data size (uint32 LE)，必须是 4 的倍数
 *   bytes 8-11   magic = ".FIT"
 */
export function isFitFile(content: Buffer | Uint8Array): boolean {
  if (content.length < 12) return false;
  const headerSize = content[0];
  if (headerSize !== 12 && headerSize !== 14) return false;
  const protocol = content[1];
  if (protocol !== 0x10 && protocol !== 0x20) return false;
  // magic ".FIT"
  if (
    content[8] !== 0x2e ||
    content[9] !== 0x46 ||
    content[10] !== 0x49 ||
    content[11] !== 0x54
  ) {
    return false;
  }
  const dataSize =
    content[4]! | (content[5]! << 8) | (content[6]! << 16) | (content[7]! << 24);
  return dataSize >= 0 && dataSize % 4 === 0;
}

/** 探测文件类型 */
export function detectFileKind(
  content: Buffer | Uint8Array,
): 'fit' | 'gpx' | 'tcx' | 'unknown' {
  if (isFitFile(content)) return 'fit';
  const head = Buffer.from(
    content.subarray(0, Math.min(content.length, 512)),
  ).toString('utf8');
  if (head.includes('<TrainingCenterDatabase')) return 'tcx';
  if (head.includes('<gpx')) return 'gpx';
  // 其它 XML（不含 gpx 根节点）与 JSON 一律 unknown —— 不能把任意 JSON 当成 GPX
  return 'unknown';
}

function pickNumber(...candidates: unknown[]): number | undefined {
  for (const c of candidates) {
    if (typeof c === 'number' && Number.isFinite(c)) return c;
  }
  return undefined;
}

function deriveEndTime(
  session: Record<string, unknown> | undefined,
  lap: Record<string, unknown> | undefined,
  records: Array<Record<string, unknown>>,
): Date | undefined {
  const elapsed =
    pickNumber(
      session?.total_elapsed_time as number | undefined,
      lap?.total_elapsed_time as number | undefined,
    );
  const start =
    session?.start_time instanceof Date
      ? (session.start_time as Date)
      : lap?.start_time instanceof Date
        ? (lap.start_time as Date)
        : undefined;
  if (start instanceof Date && elapsed !== undefined) {
    return new Date(start.getTime() + elapsed * 1000);
  }
  const last = records[records.length - 1];
  return last?.timestamp instanceof Date ? (last.timestamp as Date) : undefined;
}

function buildTrack(records: Array<Record<string, unknown>>): TrackPoint[] {
  const out: TrackPoint[] = [];
  for (const r of records) {
    const lat = r.position_lat;
    const lon = r.position_long;
    const t = r.timestamp;
    if (
      typeof lat !== 'number' ||
      typeof lon !== 'number' ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      !(t instanceof Date)
    ) {
      continue;
    }
    const p: TrackPoint = { lat, lon, t: t.getTime() };
    if (typeof r.altitude === 'number') p.alt = r.altitude;
    if (typeof r.speed === 'number') p.speed = r.speed;
    if (typeof r.heart_rate === 'number') p.hr = r.heart_rate;
    if (typeof r.power === 'number') p.power = r.power;
    if (typeof r.cadence === 'number') p.cadence = r.cadence;
    if (typeof r.distance === 'number') p.distance = r.distance;
    out.push(p);
  }
  return out;
}

interface RecordAggregate {
  distance?: number;
  elapsed?: number;
  timer?: number;
  avgSpeed?: number;
  maxSpeed?: number;
  avgHr?: number;
  maxHr?: number;
  avgPower?: number;
  maxPower?: number;
  avgCadence?: number;
  maxCadence?: number;
  hasHr: boolean;
  hasPower: boolean;
  hasCadence: boolean;
}

/** session/lap 缺失时，从 record 流聚合兜底 */
function aggregateFromRecords(
  records: Array<Record<string, unknown>>,
): RecordAggregate {
  const agg: RecordAggregate = {
    hasHr: false,
    hasPower: false,
    hasCadence: false,
  };
  if (records.length === 0) return agg;

  let hrSum = 0;
  let hrCount = 0;
  let hrMax: number | undefined;
  let pSum = 0;
  let pCount = 0;
  let pMax: number | undefined;
  let cSum = 0;
  let cCount = 0;
  let cMax: number | undefined;
  let spSum = 0;
  let spCount = 0;
  let spMax: number | undefined;

  let firstT: number | undefined;
  let lastT: number | undefined;
  let lastDistance: number | undefined;

  for (const r of records) {
    const t = r.timestamp instanceof Date ? r.timestamp.getTime() : undefined;
    if (t !== undefined) {
      if (firstT === undefined) firstT = t;
      lastT = t;
    }
    if (typeof r.distance === 'number' && Number.isFinite(r.distance)) {
      lastDistance = r.distance;
    }
    if (typeof r.heart_rate === 'number') {
      agg.hasHr = true;
      hrSum += r.heart_rate;
      hrCount++;
      hrMax = hrMax === undefined ? r.heart_rate : Math.max(hrMax, r.heart_rate);
    }
    if (typeof r.power === 'number') {
      agg.hasPower = true;
      pSum += r.power;
      pCount++;
      pMax = pMax === undefined ? r.power : Math.max(pMax, r.power);
    }
    if (typeof r.cadence === 'number') {
      agg.hasCadence = true;
      cSum += r.cadence;
      cCount++;
      cMax = cMax === undefined ? r.cadence : Math.max(cMax, r.cadence);
    }
    if (typeof r.speed === 'number' && Number.isFinite(r.speed)) {
      spSum += r.speed;
      spCount++;
      spMax = spMax === undefined ? r.speed : Math.max(spMax, r.speed);
    }
  }

  agg.distance = lastDistance;
  if (firstT !== undefined && lastT !== undefined) {
    agg.elapsed = (lastT - firstT) / 1000;
  }
  if (hrCount) agg.avgHr = hrSum / hrCount;
  if (hrMax !== undefined) agg.maxHr = hrMax;
  if (pCount) agg.avgPower = pSum / pCount;
  if (pMax !== undefined) agg.maxPower = pMax;
  if (cCount) agg.avgCadence = cSum / cCount;
  if (cMax !== undefined) agg.maxCadence = cMax;
  if (spCount) {
    agg.avgSpeed = spSum / spCount;
    agg.maxSpeed = spMax;
  }
  return agg;
}

function buildRaw(
  session: Record<string, unknown> | undefined,
  lap: Record<string, unknown> | undefined,
  parsed: { file_creator?: unknown; device_settings?: unknown },
): Record<string, unknown> {
  const raw: Record<string, unknown> = {};
  if (session) {
    raw.session_event = session.event;
    raw.session_trigger = session.trigger;
  }
  if (lap) {
    raw.lap_trigger = lap.trigger;
  }
  if (parsed.file_creator) raw.file_creator = parsed.file_creator;
  if (parsed.device_settings) raw.device_settings = parsed.device_settings;
  return raw;
}

/**
 * 估算文件的坐标系。
 *
 * M0 阶段只做「标注」不做改写：来源平台的 manifest 已声明坐标系，
 * 这里提供的是文件级覆盖（例如迈金七牛直链是 WGS-84、fit_content 是 GCJ-02）。
 */
export function estimateCoordinateSystem(
  summary: FitSummary,
  fallback: CoordinateSystem = 'unknown',
): CoordinateSystem {
  if (!summary.hasPosition) return fallback;
  return fallback;
}
