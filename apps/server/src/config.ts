import { randomBytes } from 'node:crypto';

/**
 * 配置（决策 D2：单用户 / D3：纯自托管）。
 *
 * 密码与主密钥都支持「不设置 → 首次启动随机生成并落盘/打印」。
 * 这样用户 clone 下来 docker compose up 就能用，不需要任何配置。
 */
export interface AppConfig {
  host: string;
  port: number;
  databaseUrl: string;
  redisUrl: string;
  /** 单用户管理员密码 */
  adminPassword: string;
  /** 凭证加密主密钥（base64, 32 字节） */
  masterKey: Buffer;
  /** 首次启动生成的密码（需要打印到日志） */
  generatedPassword?: string;
  fileRetentionDays: number;
  derivedTtlDays: number;
  maxItemsPerRun: number;
}

function env(key: string): string | undefined {
  const v = process.env[key];
  return v && v.trim() !== '' ? v.trim() : undefined;
}

export function loadConfig(): AppConfig {
  const generatedPassword = env('FITBRIDGE_PASSWORD')
    ? undefined
    : randomBytes(12).toString('base64url');

  const masterKeyRaw = env('FITBRIDGE_MASTER_KEY');
  const masterKey = masterKeyRaw
    ? Buffer.from(masterKeyRaw, 'base64')
    : randomBytes(32);

  return {
    host: env('FITBRIDGE_HOST') ?? '127.0.0.1',
    port: Number(env('FITBRIDGE_PORT') ?? 8080),
    databaseUrl:
      env('FITBRIDGE_DATABASE_URL') ??
      'postgres://fitbridge:fitbridge@127.0.0.1:5432/fitbridge',
    redisUrl: env('FITBRIDGE_REDIS_URL') ?? 'redis://127.0.0.1:6379',
    adminPassword: env('FITBRIDGE_PASSWORD') ?? generatedPassword!,
    masterKey,
    generatedPassword,
    fileRetentionDays: Number(env('FITBRIDGE_FILE_RETENTION_DAYS') ?? 90),
    derivedTtlDays: Number(env('FITBRIDGE_DERIVED_TTL_DAYS') ?? 7),
    maxItemsPerRun: Number(env('FITBRIDGE_MAX_ITEMS_PER_RUN') ?? 100),
  };
}
