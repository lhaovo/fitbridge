import { Pool, type PoolClient, type QueryResultRow } from 'pg';

/**
 * Postgres 访问层。
 *
 * M0 阶段刻意保持简单：连接池 + query 助手 + 一个迁移脚本。
 * 后续如果上多用户，再补 RLS。
 */
export class Database {
  private pool: Pool | null = null;
  private available = false;

  constructor(private readonly connectionString: string) {}

  /** 尝试连接；失败不抛错，服务以降级模式启动（/health 会报告 db=false） */
  async connect(): Promise<boolean> {
    try {
      this.pool = new Pool({
        connectionString: this.connectionString,
        max: 10,
        connectionTimeoutMillis: 5000,
      });
      await this.pool.query('SELECT 1');
      this.available = true;
      return true;
    } catch (err) {
      this.available = false;
      this.pool = null;
      console.error('[db] 连接失败，服务以降级模式启动:', err);
      return false;
    }
  }

  get isAvailable(): boolean {
    return this.available;
  }

  async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    if (!this.pool) throw new Error('数据库未连接');
    const res = await this.pool.query<T>(text, params as never[]);
    return res.rows;
  }

  async one<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params: unknown[] = [],
  ): Promise<T | undefined> {
    const rows = await this.query<T>(text, params);
    return rows[0];
  }

  async close(): Promise<void> {
    await this.pool?.end();
    this.pool = null;
  }

  /** 供迁移脚本使用 */
  raw(): Pool {
    if (!this.pool) throw new Error('数据库未连接');
    return this.pool;
  }
}
