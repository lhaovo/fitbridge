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
