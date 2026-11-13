/**
 * GPX → FIT 构建（M1 实现，M0 留契约桩）。
 *
 * 背景：迈金/顽鹿 OTM 上传只接受 FIT，且要求完整的
 * file_id → session → lap → activity → record 消息流。
 * fit-file-parser 自带 FitEncoder（writeMessage / toFitTimestamp / calculateCRC），
 * 不需要自己手写 FIT 二进制。
 */
export interface GpxPoint {
  lat: number;
  lon: number;
  /** Unix 毫秒 */
  t: number;
  alt?: number;
  hr?: number;
  power?: number;
  cadence?: number;
}

export interface BuildFitOptions {
  /** 活动名称 */
  name: string;
  /** 运动类型（FIT profile 名，如 'cycling'） */
  sport: string;
  /** 轨迹点 */
  points: GpxPoint[];
  /** 时区偏移（分钟） */
  timezoneOffsetMin?: number;
}

export interface BuildFitResult {
  content: Buffer;
  warnings: string[];
}

/** M1 实现 */
export function buildFitFromGpx(_options: BuildFitOptions): BuildFitResult {
  throw new Error(
    'buildFitFromGpx 尚未实现（M1）。当前版本 fitkit 只提供只读解析能力。',
  );
}
