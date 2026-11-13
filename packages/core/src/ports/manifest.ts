import type { CoordinateSystem } from '@fitbridge/fitkit';

/**
 * 平台能力声明。
 *
 * 这是 UI 能力矩阵的唯一数据源：前端直接由 manifest 列表渲染，
 * 用户能清楚看到每个平台的「官方/逆向」「可下载/可上传」「坐标系」「限流」。
 */
export type PlatformAccess =
  | 'official'
  | 'partner'
  | 'reverse-engineered'
  | 'webview-scrape';

export type AuthType = 'oauth2' | 'password' | 'password+otp' | 'webview';

export type RiskLevel = 'low' | 'medium' | 'high';

export interface PlatformCapabilities {
  download: boolean;
  upload: boolean;
  /** 目标平台接受的文件格式 */
  uploadFormats: Array<'fit' | 'gpx' | 'tcx'>;
  deleteRemote: boolean;
  webhook: boolean;
  /** 平台是否支持增量（游标 / 时间戳过滤） */
  incremental: boolean;
}

export interface PlatformRateLimit {
  requestsPerMinute: number;
  requestsPerDay?: number;
  /** 登录最小间隔（秒），防风控 */
  minLoginIntervalSec?: number;
  /** 单次最多上传多少条 */
  uploadBatchSize?: number;
}

export interface PlatformManifest {
  id: string;
  displayName: string;
  /** 短码，参与 external_id 拼接 */
  shortCode: string;
  vendor: string;
  homepage?: string;

  authType: AuthType;
  access: PlatformAccess;

  capabilities: PlatformCapabilities;
  /** 平台默认坐标系（文件级可覆盖） */
  coordinateSystem: CoordinateSystem;
  rateLimit: PlatformRateLimit;

  /** 上传是否异步入库 */
  uploadAsync: boolean;
  /** 异步入库的确认延迟（秒） */
  uploadVerifyDelaySec?: number;

  riskLevel: RiskLevel;
  /** 展示给用户的注意事项 */
  notes?: string;
  docsUrl?: string;
}

/** 所有内置平台的 manifest 列表 */
export const BUILTIN_PLATFORMS: PlatformManifest[] = [];
