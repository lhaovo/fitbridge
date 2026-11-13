/**
 * 存储分层策略（决策 D2/D3）。
 *
 * L1 元数据  → Postgres 全量常驻
 * L2 原始文件 → 对象存储，用到才存，默认 90 天
 * L3 派生文件 → 按需生成 + 7 天缓存
 *
 * 详见 docs/06-decisions.md
 */
export interface StoragePolicy {
  /** L2 原始文件保留天数 */
  fileRetentionDays: number;
  /** L3 派生文件缓存天数 */
  derivedTtlDays: number;
  /** 单个文件大小上限（字节），防恶意/超大文件 */
  maxFileBytes: number;
  /** 单次同步最多处理条数 */
  maxItemsPerRun: number;
}

export const DEFAULT_STORAGE_POLICY: StoragePolicy = {
  fileRetentionDays: 90,
  derivedTtlDays: 7,
  maxFileBytes: 128 * 1024 * 1024,
  maxItemsPerRun: 100,
};

/** 内容寻址：sha256/{前2}/{第3-4}/{完整} */
export function blobKey(sha256: string): string {
  return `sha256/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}`;
}

/** 判断文件是否已过保留期 */
export function isExpired(
  createdAt: Date,
  now: Date,
  retentionDays: number,
): boolean {
  if (retentionDays <= 0) return false; // 0 = 永久保留
  const ageMs = now.getTime() - createdAt.getTime();
  return ageMs > retentionDays * 24 * 60 * 60 * 1000;
}
