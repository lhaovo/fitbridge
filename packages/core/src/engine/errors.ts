import { classifyAuthFailure, isTransientFailure } from './risk.js';

/**
 * 携带 HTTP 状态码的平台异常。
 *
 * 为什么需要：适配器如果只抛纯文本 Error，「401 Unauthorized」这类信息
 * 会被 classifyAuthFailure 判成 unknown，导致 token 过期时不会触发自动重登。
 * 所以 HTTP 层失败必须显式带上 status。
 */
export class PlatformHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: string,
  ) {
    super(message);
    this.name = 'PlatformHttpError';
  }
}

/** 统一错误码（与 docs/04-data-model-api.md 一致） */
export type PlatformErrorCode =
  | 'AUTH_EXPIRED'
  | 'RATE_LIMITED'
  | 'VALIDATION_FAILED'
  | 'TRANSIENT'
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'PLATFORM_CHANGED'
  | 'CONFIG_ERROR'
  | 'INTERNAL';

const RETRYABLE: ReadonlySet<PlatformErrorCode> = new Set([
  'RATE_LIMITED',
  'TRANSIENT',
]);

export class PlatformError extends Error {
  constructor(
    readonly code: PlatformErrorCode,
    message: string,
    readonly options: {
      retryable?: boolean;
      platformId?: string;
      details?: Record<string, unknown>;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'PlatformError';
  }

  get retryable(): boolean {
    return this.options.retryable ?? RETRYABLE.has(this.code);
  }

  static from(err: unknown, platformId?: string): PlatformError {
    if (err instanceof PlatformError) return err;
    const message = err instanceof Error ? err.message : String(err);
    return new PlatformError('TRANSIENT', message, { platformId, cause: err });
  }
}

/** 错误码 → HTTP 状态码 */
export function httpStatusFor(code: PlatformErrorCode): number {
  switch (code) {
    case 'AUTH_EXPIRED':
      return 401;
    case 'FORBIDDEN':
      return 403;
    case 'NOT_FOUND':
      return 404;
    case 'VALIDATION_FAILED':
      return 422;
    case 'RATE_LIMITED':
      return 429;
    case 'PLATFORM_CHANGED':
      return 502;
    case 'CONFIG_ERROR':
      return 400;
    default:
      return 500;
  }
}


/**
 * 把任意异常归一化为 PlatformError。
 *
 * 适配器里目前抛的是普通 Error（带中文信息），
 * 这里统一用 classifyAuthFailure 判定语义，
 * 让引擎能可靠地决定「要不要重试 / 要不要冷却」。
 */
export function normalizeError(err: unknown, platformId?: string): PlatformError {
  if (err instanceof PlatformError) return err;

  const message = err instanceof Error ? err.message : String(err);
  const status =
    err instanceof PlatformHttpError
      ? err.status
      : typeof (err as { status?: unknown })?.status === 'number'
        ? ((err as { status: number }).status)
        : undefined;

  // 状态码优先于文本判定
  if (status === 401) {
    return new PlatformError('AUTH_EXPIRED', message, { platformId, cause: err });
  }
  if (status === 403) {
    return new PlatformError('FORBIDDEN', message, { platformId, cause: err });
  }
  if (status === 429) {
    return new PlatformError('RATE_LIMITED', message, { platformId, cause: err });
  }
  if (status === 404) {
    return new PlatformError('NOT_FOUND', message, { platformId, cause: err });
  }
  if (status !== undefined && status >= 400 && status < 500) {
    return new PlatformError('VALIDATION_FAILED', message, { platformId, cause: err });
  }
  if (status !== undefined && status >= 500) {
    return new PlatformError('TRANSIENT', message, { platformId, cause: err });
  }

  const failure = classifyAuthFailure(message, { status });

  switch (failure.kind) {
    case 'rate-limited':
      return new PlatformError('RATE_LIMITED', failure.message, {
        platformId,
        cause: err,
      });
    case 'challenge-required':
      return new PlatformError('FORBIDDEN', failure.message, {
        platformId,
        cause: err,
      });
    case 'invalid-credential':
    case 'ambiguous':
      return new PlatformError('AUTH_EXPIRED', failure.message, {
        platformId,
        cause: err,
      });
    default:
      return new PlatformError(
        isTransientFailure(message) ? 'TRANSIENT' : 'VALIDATION_FAILED',
        message,
        { platformId, cause: err },
      );
  }
}
