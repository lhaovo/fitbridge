import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DatabaseSync as DatabaseSyncInstance } from 'node:sqlite';

/**
 * node:sqlite 用 createRequire 动态加载。
 *
 * 原因：它是较新的 Node 内置模块（Node >= 22.5），部分打包器 / 测试运行器
 * 还不知道它是内置模块，静态 import 会被当成普通依赖去解析而失败。
 */
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as {
  DatabaseSync: new (path: string) => DatabaseSyncInstance;
};

/**
 * SQLite 数据层。
 *
 * 为什么用 SQLite（而不是 Postgres / MinIO）：
 * - 决策 D2/D3：单用户 + 纯自托管 → 不需要独立数据库服务
 * - node:sqlite 是 Node 内置模块（SQLite 3.53+），零原生依赖、零安装成本
 * - 单文件部署：整个 FitBridge 状态就是一个 data/fitbridge.db
 *
 * 与 Postgres 的差异已在本层消化：上层仍然用 query/one/run 这套接口。
 * 将来要换 Postgres，只需替换本文件。
 */
export class Database {
  private db: DatabaseSyncInstance | null = null;
  private available = false;
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  /** 打开数据库；失败则以降级模式启动 */
  async connect(): Promise<boolean> {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      this.db = new DatabaseSync(this.path);
      // 单用户单进程 → 不需要 WAL 的并发收益。
      // 用 DELETE 模式让全部数据留在 fitbridge.db 单文件里：
      //   · 备份/拷贝只需拷一个文件（不会漏掉 -wal 里的数据）
      //   · 直接用别的工具打开就能看到完整数据，而不是"空库 + 一堆旁文件"
      this.db.exec('PRAGMA journal_mode = DELETE;');
      this.db.exec('PRAGMA foreign_keys = ON;');
      this.db.exec('PRAGMA busy_timeout = 5000;');
      this.available = true;
      return true;
    } catch (err) {
      this.available = false;
      this.db = null;
      console.error('[db] 打开数据库失败，服务以降级模式启动:', err);
      return false;
    }
  }

  get isAvailable(): boolean {
    return this.available;
  }

  get filePath(): string {
    return this.path;
  }

  /** 查询多行 */
  query<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): T[] {
    if (!this.db) throw new Error('数据库未连接');
    const stmt = this.db.prepare(sql);
    return stmt.all(...(params as never[])) as T[];
  }

  /** 查询单行 */
  one<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): T | undefined {
    if (!this.db) throw new Error('数据库未连接');
    const stmt = this.db.prepare(sql);
    return stmt.get(...(params as never[])) as T | undefined;
  }

  /** 执行写入 */
  run(
    sql: string,
    params: unknown[] = [],
  ): { changes: number; lastInsertRowid: number } {
    if (!this.db) throw new Error('数据库未连接');
    const stmt = this.db.prepare(sql);
    const r = stmt.run(...(params as never[]));
    return {
      changes: Number(r.changes),
      lastInsertRowid: Number(r.lastInsertRowid),
    };
  }

  /** 执行多条 DDL */
  exec(sql: string): void {
    if (!this.db) throw new Error('数据库未连接');
    this.db.exec(sql);
  }

  /** 事务包装 */
  transaction<T>(fn: () => T): T {
    if (!this.db) throw new Error('数据库未连接');
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  async close(): Promise<void> {
    // 若是 WAL 模式则先落盘检查点，避免数据留在 -wal 里
    try {
      this.db?.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    } catch {
      /* 非 WAL 模式会报错，忽略 */
    }
    this.db?.close();
    this.db = null;
    this.available = false;
  }
}
