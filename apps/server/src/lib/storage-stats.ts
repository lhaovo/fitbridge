import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Database } from './db.js';

/**
 * 本地库状态统计。
 *
 * 让用户在 Web 上就能看到"本地到底存了什么、占多大、多久清理"，
 * 而不用去服务器上翻目录。
 */
export interface StorageStats {
  database: {
    path: string;
    sizeBytes: number;
    journalMode: string;
    tables: number;
  };
  blobs: {
    dir: string;
    fileCount: number;
    sizeBytes: number;
  };
  counts: {
    activities: number;
    activityFiles: number;
    activeFiles: number;
    expiredFiles: number;
    credentials: number;
    syncRuns: number;
    syncItems: number;
    events: number;
  };
  policy: {
    fileRetentionDays: number;
    derivedTtlDays: number;
  };
  /** 按来源平台统计（去重效果的直接体现） */
  byPlatform: Array<{
    platformId: string;
    activities: number;
    files: number;
    sizeBytes: number;
  }>;
}

async function dirSize(dir: string): Promise<{ count: number; bytes: number }> {
  let count = 0;
  let bytes = 0;
  const walk = async (p: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(p, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(p, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else if (e.isFile()) {
        try {
          const s = await stat(full);
          count++;
          bytes += s.size;
        } catch {
          /* ignore */
        }
      }
    }
  };
  await walk(dir);
  return { count, bytes };
}

export async function collectStorageStats(
  db: Database,
  opts: { dbFile: string; blobDir: string; fileRetentionDays: number; derivedTtlDays: number },
): Promise<StorageStats> {
  const dbStat = await stat(opts.dbFile).catch(() => null);
  const blobStat = await dirSize(opts.blobDir);

  const one = (sql: string): number =>
    db.one<{ c: number }>(sql)?.c ?? 0;

  const tables = db
    .query<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'")
    .length;

  const journalMode =
    db.one<{ journal_mode: string }>('PRAGMA journal_mode')?.journal_mode ?? 'unknown';

  const byPlatform = db
    .query<{ platform_id: string; activities: number; files: number; size: number }>(
      `SELECT a.source_platform AS platform_id,
              COUNT(DISTINCT a.id)   AS activities,
              COUNT(f.id)           AS files,
              COALESCE(SUM(f.byte_size), 0) AS size
         FROM activities a
         LEFT JOIN activity_files f ON f.activity_id = a.id
        GROUP BY a.source_platform
        ORDER BY activities DESC`,
    )
    .map((r) => ({
      platformId: r.platform_id,
      activities: r.activities,
      files: r.files,
      sizeBytes: r.size,
    }));

  return {
    database: {
      path: opts.dbFile,
      sizeBytes: dbStat?.size ?? 0,
      journalMode,
      tables,
    },
    blobs: {
      dir: opts.blobDir,
      fileCount: blobStat.count,
      sizeBytes: blobStat.bytes,
    },
    counts: {
      activities: one('SELECT COUNT(*) AS c FROM activities'),
      activityFiles: one('SELECT COUNT(*) AS c FROM activity_files'),
      activeFiles: one('SELECT COUNT(*) AS c FROM activity_files WHERE expired_at IS NULL'),
      expiredFiles: one('SELECT COUNT(*) AS c FROM activity_files WHERE expired_at IS NOT NULL'),
      credentials: one('SELECT COUNT(*) AS c FROM credentials'),
      syncRuns: one('SELECT COUNT(*) AS c FROM sync_runs'),
      syncItems: one('SELECT COUNT(*) AS c FROM sync_items'),
      events: one('SELECT COUNT(*) AS c FROM events'),
    },
    policy: {
      fileRetentionDays: opts.fileRetentionDays,
      derivedTtlDays: opts.derivedTtlDays,
    },
    byPlatform,
  };
}
