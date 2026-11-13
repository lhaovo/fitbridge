import type { CoordinateSystem } from '@fitbridge/fitkit';
import type { PlatformManifest } from './manifest.js';

/** 加密后的平台凭证（明文只在 worker 内存中短暂存在） */
export interface Credential {
  id: string;
  userId: string;
  platformId: string;
  /** 已解密的凭证内容（结构随平台而异） */
  secret: Record<string, unknown>;
  /** 非敏感元数据（如 MyWhoosh 的 whooshId） */
  meta?: Record<string, unknown>;
  /** 登录信息（账号密码），与 secret 一起加密存储，用于 token 过期后自动重登 */
  credentials?: {
    account?: string;
    password?: string;
  };
  expiresAt?: string;
}

/** 认证请求 */
export interface AuthInput {
  /** OAuth2 授权码 */
  code?: string;
  redirectUri?: string;
  /** 账号密码类 */
  account?: string;
  password?: string;
  /** 自建应用凭证 */
  clientId?: string;
  clientSecret?: string;
  /**
   * 稳定设备标识。
   * 部分 App 的登录请求带 DeviceId 并把 token 与之绑定，
   * 同一安装实例应始终使用同一个值。
   */
  deviceId?: string;
}

/** 认证结果 */
export interface AuthOutput {
  secret: Record<string, unknown>;
  meta?: Record<string, unknown>;
  expiresAt?: string;
}

export interface CredentialHealth {
  ok: boolean;
  reason?: string;
  expiresAt?: string;
  checkedAt: string;
}

/** 平台侧的活动（尚未规范化） */
export interface RemoteActivity {
  remoteId: string;
  name?: string;
  sportType?: string;
  /** ISO8601 */
  startTime?: string;
  /** 平台提供的时区偏移（分钟） */
  timezoneOffset?: number;
  distanceMeters?: number;
  durationSec?: number;
  elevationGainMeters?: number;
  avgHeartRate?: number;
  avgPower?: number;
  avgCadence?: number;
  /** 平台原始响应 */
  raw?: unknown;
}

export interface RemoteActivityDetail extends RemoteActivity {
  /** 下载所需的平台内文件 ID */
  fileId?: string;
  /** 坐标系（文件级覆盖，优先于 manifest） */
  coordinateSystem?: CoordinateSystem;
}

/** 分页结果 */
export interface Paged<T> {
  items: T[];
  /** 平台游标；无游标时用 offset */
  cursor?: string;
  hasMore: boolean;
}

/** 下载到的文件 */
export interface FilePayload {
  content: Buffer;
  contentType: string;
  filename: string;
  sourceKind: 'fit' | 'gpx' | 'tcx';
  /** 文件级坐标系，优先于 manifest */
  coordinateSystem?: CoordinateSystem;
  /** 平台侧文件 ID */
  remoteFileId?: string;
}

/** 上传提示 */
export interface UploadHint {
  name: string;
  /** 已校正的本地时间 + 时区偏移 */
  startTime?: string;
  timezoneOffsetMin?: number;
  sportType: string;
  /** 幂等键 {shortCode}{sourceId} */
  externalId: string;
}

export type UploadStatus = 'accepted' | 'pending' | 'rejected';

export interface UploadResult {
  remoteId?: string;
  status: UploadStatus;
  message?: string;
  raw?: unknown;
}

/** Webhook 事件 */
export interface ParsedWebhookEvent {
  platformId: string;
  ownerId?: string;
  objectId: string;
  aspectType?: string;
  eventTime?: string;
}

/**
 * 平台适配器契约。
 *
 * 核心引擎只依赖这个接口，不认识任何具体平台。
 * 新增平台 = 新增一个 adapters/<id> 目录 + 一份 manifest，不改引擎任何一行。
 */
export interface PlatformAdapter {
  readonly manifest: PlatformManifest;

  // ── 认证 ────────────────────────────────────────────────
  auth(input: AuthInput): Promise<AuthOutput>;
  validate(cred: Credential): Promise<CredentialHealth>;
  refresh?(cred: Credential): Promise<Credential>;

  // ── 读取 ────────────────────────────────────────────────
  listActivities(
    cred: Credential,
    opts?: { cursor?: string; limit?: number },
  ): Promise<Paged<RemoteActivity>>;
  getActivityDetail?(
    cred: Credential,
    remoteId: string,
  ): Promise<RemoteActivityDetail>;
  downloadFile(
    cred: Credential,
    activity: RemoteActivityDetail,
  ): Promise<FilePayload>;

  // ── 写入（manifest.capabilities.upload === true 时实现）──
  uploadFile?(
    cred: Credential,
    file: { content: Buffer; kind: 'fit' | 'gpx' | 'tcx'; filename: string },
    hint: UploadHint,
  ): Promise<UploadResult>;

  // ── Webhook ─────────────────────────────────────────────
  parseWebhook?(payload: unknown): ParsedWebhookEvent | null;
}
