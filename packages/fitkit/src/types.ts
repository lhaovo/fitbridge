/**
 * fitkit 公共类型。
 *
 * 设计原则（决策 D5：FIT 走简单路线）：
 * - 只做「读」与「标注」，不做完整 profile 还原
 * - 拿不到就留空，绝不臆造数值
 * - 任何被修正过的数据都要在 warnings / flags 中留痕
 */

/** 运动类型（归一化后） */
export type SportType =
  | 'ride'
  | 'run'
  | 'swim'
  | 'hiking'
  | 'ski'
  | 'strength'
  | 'rowing'
  | 'other';

/** 坐标系 */
export type CoordinateSystem = 'wgs84' | 'gcj02' | 'bd09' | 'unknown';

/** 轨迹点 */
export interface TrackPoint {
  lat: number;
  lon: number;
  /** 海拔（米） */
  alt?: number;
  /** Unix 毫秒 */
  t: number;
  /** 速度（m/s） */
  speed?: number;
  /** 心率（bpm） */
  hr?: number;
  /** 功率（w） */
  power?: number;
  /** 踏频（rpm） */
  cadence?: number;
  /** 累计距离（米） */
  distance?: number;
}

/** FIT 解析结果摘要 */
export interface FitSummary {
  /** FIT file_id 里的创建时间 */
  fileCreatedAt?: string;
  /** 运动类型（归一化） */
  sportType: SportType;
  /** 平台原始运动类型字符串，未知为 undefined */
  rawSportType?: string;

  /** 活动开始时间（UTC ISO） */
  startTime?: string;
  /** 活动结束时间（UTC ISO） */
  endTime?: string;
  /** 从 local_timestamp - timestamp 反推出的时区偏移（分钟） */
  timezoneOffsetMin?: number;
  /** 时区偏移的来源 */
  timezoneSource: 'file-local-timestamp' | 'platform' | 'user' | 'unknown';

  /** 总距离（米） */
  totalDistanceM?: number;
  /** 总耗时（秒，含停顿） */
  totalElapsedSec?: number;
  /** 运动时长（秒） */
  totalTimerSec?: number;
  /** 总爬升（米） */
  elevationGainM?: number;
  /** 总下降（米） */
  elevationDescentM?: number;

  avgSpeedMps?: number;
  maxSpeedMps?: number;
  avgHeartRate?: number;
  maxHeartRate?: number;
  avgPower?: number;
  maxPower?: number;
  avgCadence?: number;
  maxCadence?: number;
  calories?: number;

  /** 轨迹点（可能被 maxTrackPoints 截断） */
  track: TrackPoint[];
  /** 轨迹是否被截断 */
  trackTruncated: boolean;
  /** 轨迹点总数（截断前） */
  trackPointCount: number;

  /** 传感器数据可用性 */
  hasPosition: boolean;
  hasHeartRate: boolean;
  hasPower: boolean;
  hasCadence: boolean;

  /** CRC 校验是否通过（force=false 时才有意义） */
  crcValid?: boolean;
  /** 解析告警 */
  warnings: string[];
  /** 原始运动类型等无法归类的原始信息 */
  raw?: Record<string, unknown>;
}

/** readFit 选项 */
export interface ReadFitOptions {
  /**
   * true = 跳过 CRC 校验并允许尽力恢复（默认，兼容脏文件）
   * false = 严格校验 CRC（用于体检/诊断）
   */
  force?: boolean;
  /** 严格模式：要求完整文件且无尾随字节 */
  strict?: boolean;
  /** 轨迹点上限，0 表示不限制（默认 5000） */
  maxTrackPoints?: number;
}
