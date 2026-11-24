import { FitEncoder, FitBaseType } from 'fit-file-parser';

/**
 * 合成 FIT 样本文件。
 *
 * 用 fit-file-parser 自带的 FitEncoder 生成完整的
 * file_id → session → lap → activity → record 消息流，
 * 这样测试不依赖任何外部二进制样本，且同时验证了库的编码能力（M1 的 GPX→FIT 会复用）。
 */

/**
 * FIT 坐标以「半圆（semicircle）」为单位存储：
 * 2^31 半圆 = 180 度，所以 1 度 = 2^31 / 180 个半圆。
 * 库里解码时用 raw * FIT.scConst（scConst = 180 / 2^31）还原成度。
 */
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

export interface SyntheticFitOptions {
  /** 起始时间（UTC） */
  start: Date;
  /** 记录间隔（秒） */
  intervalSec?: number;
  /** 记录条数 */
  recordCount?: number;
  /** 起始经纬度（度） */
  startLat?: number;
  startLon?: number;
  /** 每条记录的经纬度增量（度） */
  stepLat?: number;
  stepLon?: number;
  /** 本地时区偏移（分钟） */
  timezoneOffsetMin?: number;
  /** 是否写入 local_timestamp */
  withLocalTimestamp?: boolean;
  /** 是否写心率 */
  withHr?: boolean;
  /** 是否写功率 */
  withPower?: boolean;
  /**
   * 覆盖 session.avg_speed 的原始值（scale 1000）。
   * 真实数据里这个字段有时是坏的（0 或明显偏小），
   * 用它来验证 readFit 会按「距离/移动时间」重算。
   */
  sessionAvgSpeedRaw?: number;
}

export function buildSyntheticFit(opts: SyntheticFitOptions): Buffer {
  const {
    start,
    intervalSec = 1,
    recordCount = 10,
    startLat = 31.2304,
    startLon = 121.4737,
    stepLat = 0.0001,
    stepLon = 0.0001,
    timezoneOffsetMin = 480,
    withLocalTimestamp = true,
    withHr = true,
    withPower = true,
    sessionAvgSpeedRaw,
  } = opts;

  // 记录速度固定 5 m/s → 距离增量必须与之一致，
  // 否则合成文件本身就是「坏文件」（avg_speed 与距离/时长 对不上）。
  const RECORD_SPEED_MPS = 5;
  const stepMeters = RECORD_SPEED_MPS * intervalSec;
  const totalDistanceM = stepMeters * recordCount;

  const enc = new FitEncoder();

  // ── file_id (message 0) ─────────────────────────────────
  enc.writeMessage(0, [
    enumF(0, 4), // type = activity
    u16(1, 1), // manufacturer = garmin
    u16(2, 2697), // product
    u32z(3, 123456789), // serial_number
    u32(4, FitEncoder.toFitTimestamp(start)),
  ]);

  // ── session (message 18) ───────────────────────────────
  const totalElapsedSec = recordCount * intervalSec;
  enc.writeMessage(18, [
    u32(2, FitEncoder.toFitTimestamp(start)), // start_time
    enumF(5, 2), // sport = cycling
    u32(7, totalElapsedSec * 1000), // total_elapsed_time (scale 1000)
    u32(8, totalElapsedSec * 1000), // total_timer_time
    u32(9, Math.round(totalDistanceM * 100)), // total_distance (scale 100)
    u16(11, 320), // total_calories
    u16(
      14,
      sessionAvgSpeedRaw ?? RECORD_SPEED_MPS * 1000,
    ), // avg_speed (scale 1000) → 5 m/s
    u16(15, 12000), // max_speed → 12 m/s
    ...(withHr ? [u8(16, 145), u8(17, 172)] : []),
    u8(18, 88), // avg_cadence
    u8(19, 104), // max_cadence
    ...(withPower ? [u16(20, 210), u16(21, 640)] : []),
    u16(22, 250), // total_ascent (scale 5, offset 500) → 0 m
    u16(23, 150), // total_descent → -10 m
  ]);

  // ── lap (message 19) ───────────────────────────────────
  enc.writeMessage(19, [
    u32(2, FitEncoder.toFitTimestamp(start)),
    u32(7, totalElapsedSec * 1000),
    u32(9, Math.round(totalDistanceM * 100)),
    enumF(25, 8), // lap_trigger = time
  ]);

  // ── activity (message 34) ──────────────────────────────
  const activityFields = [
    u32(0, totalElapsedSec * 1000), // total_timer_time
    u16(1, 1), // num_sessions
    enumF(2, 0), // type = manual
    enumF(3, 26), // event = activity
    enumF(4, 1), // event_type
    u32(253, FitEncoder.toFitTimestamp(start)), // timestamp
  ];
  if (withLocalTimestamp) {
    // local_timestamp：本地墙钟时间按同一 epoch 表达
    activityFields.push(
      u32(5, FitEncoder.toFitTimestamp(start) + timezoneOffsetMin * 60),
    );
  }
  enc.writeMessage(34, activityFields);

  // ── record (message 20) ────────────────────────────────
  for (let i = 0; i < recordCount; i++) {
    const t = new Date(start.getTime() + i * intervalSec * 1000);
    const lat = startLat + i * stepLat;
    const lon = startLon + i * stepLon;
    const fields = [
      s32(0, Math.round(lat * SEMICIRCLES)),
      s32(1, Math.round(lon * SEMICIRCLES)),
      u16(2, 5100), // altitude (scale 5, offset 500) → 20 m
      u32(5, Math.round((i + 1) * stepMeters * 100)), // distance (scale 100)
      u16(6, RECORD_SPEED_MPS * 1000), // speed → 5 m/s
      u32(253, FitEncoder.toFitTimestamp(t)),
    ];
    if (withHr) fields.push(u8(3, 140 + (i % 10)));
    if (withPower) fields.push(u16(7, 200 + (i % 20)));
    enc.writeMessage(20, fields);
  }

  return Buffer.from(enc.close());
}
