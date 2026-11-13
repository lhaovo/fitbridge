import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { Database } from './lib/db.js';

/**
 * 迁移器：按文件名顺序执行 apps/server/migrations/*.sql（SQLite 方言）。
 *
 * 服务启动时会自动跑一遍；这个脚本用于手动/排障。
 * 用法：node apps/server/dist/migrate.js
 */
export async function runMigrations(db: Database): Promise<string[]> {
  const here = dirname(fileURLToPath(import.meta.url));
  const dir = join(here, '..', 'migrations');

  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (' +
      'name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (strftime(\'%Y-%m-%dT%H:%M:%fZ\',\'now\')))',
  );

  const applied = new Set(
    db
      .query<{ name: string }>('SELECT name FROM schema_migrations')
      .map((r) => r.name),
  );

  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const ran: string[] = [];
  for (const f of files) {
    if (applied.has(f)) continue;
    const sql = await readFile(join(dir, f), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      db.run('INSERT INTO schema_migrations (name) VALUES (?)', [f]);
    });
    ran.push(f);
  }
  return ran;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const db = new Database(config.databaseFile);
  const ok = await db.connect();
  if (!ok) {
    console.error('数据库打开失败，迁移中止');
    process.exit(1);
  }
  const ran = await runMigrations(db);
  console.log(ran.length ? '已应用迁移: ' + ran.join(', ') : '数据库已是最新');
  await db.close();
}

if (process.argv[1] && process.argv[1].endsWith('migrate.js')) {
  main().catch((err) => {
    console.error('迁移失败', err);
    process.exit(1);
  });
}
