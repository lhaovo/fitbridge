import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { Database } from './lib/db.js';

/**
 * 极简迁移器：按文件名顺序执行 apps/server/migrations/*.sql。
 *
 * 用法：node dist/migrate.js
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const db = new Database(config.databaseUrl);
  const ok = await db.connect();
  if (!ok) {
    console.error('数据库连接失败，迁移中止');
    process.exit(1);
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const dir = join(here, '..', 'migrations');

  await db.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       name TEXT PRIMARY KEY,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  );

  const applied = new Set(
    (await db.query<{ name: string }>('SELECT name FROM schema_migrations')).map(
      (r) => r.name,
    ),
  );

  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    if (applied.has(f)) {
      console.log('跳过（已应用）:', f);
      continue;
    }
    const sql = await readFile(join(dir, f), 'utf8');
    console.log('应用迁移:', f);
    await db.query(sql);
    await db.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
  }

  console.log('迁移完成');
  await db.close();
}

main().catch((err) => {
  console.error('迁移失败', err);
  process.exit(1);
});
