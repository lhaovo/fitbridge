import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * 配置（决策 D2/D3：单用户 + 纯自托管单体，不引入外部服务）。
 *
 * 整个 FitBridge 的状态就是一个目录：
 *   data/
 *   ├── fitbridge.db     SQLite（业务数据 + 凭证密文）
 *   ├── blobs/            FIT/GPX 原文件（内容寻址）
 *   └── master.key        凭证加密主密钥
 *
 * 首次启动若未提供 FITBRIDGE_PASSWORD，会自动生成随机密码并打印到日志（仅一次）。
 */
export interface AppConfig {
  host: string;
  port: number;

  /** 数据目录 */
  dataDir: string;
  /** SQLite 文件路径 */
  databaseFile: string;
  /** blob 存储根目录 */
  blobDir: string;
  /** 主密钥文件路径 */
  masterKeyFile: string;

  /** 环境变量提供的管理员密码（未设置则自动生成） */
  adminPassword?: string;
  /** 凭证加密主密钥（32 字节） */
  masterKey: Buffer;

  fileRetentionDays: number;
  derivedTtlDays: number;
  maxItemsPerRun: number;
}

function env(key: string): string | undefined {
  const v = process.env[key];
  return v && v.trim() !== '' ? v.trim() : undefined;
}

export function loadConfig(): AppConfig {
  const dataDir = resolve(env('FITBRIDGE_DATA_DIR') ?? './data');
  mkdirSync(dataDir, { recursive: true });

  const masterKeyFile = join(dataDir, 'master.key');
  const masterKey = resolveMasterKey(masterKeyFile);

  return {
    host: env('FITBRIDGE_HOST') ?? '0.0.0.0',
    port: Number(env('FITBRIDGE_PORT') ?? 8080),
    dataDir,
    databaseFile: join(dataDir, 'fitbridge.db'),
    blobDir: join(dataDir, 'blobs'),
    masterKeyFile,
    adminPassword: env('FITBRIDGE_PASSWORD'),
    masterKey,
    fileRetentionDays: Number(env('FITBRIDGE_FILE_RETENTION_DAYS') ?? 90),
    derivedTtlDays: Number(env('FITBRIDGE_DERIVED_TTL_DAYS') ?? 7),
    maxItemsPerRun: Number(env('FITBRIDGE_MAX_ITEMS_PER_RUN') ?? 100),
  };
}

/**
 * 主密钥来源优先级：
 *   1. 环境变量 FITBRIDGE_MASTER_KEY（base64，32 字节）
 *   2. data/master.key 文件
 *   3. 自动生成并写入 data/master.key（0600）
 */
function resolveMasterKey(file: string): Buffer {
  const fromEnv = env('FITBRIDGE_MASTER_KEY');
  if (fromEnv) {
    const buf = Buffer.from(fromEnv, 'base64');
    if (buf.length !== 32) {
      throw new Error(
        'FITBRIDGE_MASTER_KEY 必须是 base64 编码的 32 字节（当前 ' + buf.length + ' 字节）',
      );
    }
    return buf;
  }
  if (existsSync(file)) {
    const buf = Buffer.from(readFileSync(file, 'utf8').trim(), 'base64');
    if (buf.length !== 32) {
      throw new Error('主密钥文件损坏：' + file);
    }
    return buf;
  }
  const generated = randomBytes(32);
  writeFileSync(file, generated.toString('base64'), { mode: 0o600 });
  return generated;
}
