import { loadConfig } from './config.js';
import { buildApp } from './app.js';
import { Database } from './lib/db.js';
import { LocalFileStore } from './lib/file-store.js';
import { registerBuiltinPlatforms } from './lib/platforms.js';
import { CredentialRepository } from './lib/credential-repository.js';
import { RiskGuard } from './lib/risk-guard.js';
import { bootstrap } from './lib/bootstrap.js';
import { runMigrations } from './migrate.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const db = new Database(config.databaseFile);
  const dbReady = await db.connect();

  // 单体形态：启动时自动迁移，不需要单独的 migrate 步骤
  if (dbReady) {
    const ran = await runMigrations(db);
    if (ran.length) {
      console.log('[db] 已应用迁移:', ran.join(', '));
    }
  }

  const boot = dbReady ? await bootstrap(db, config.adminPassword) : {};
  registerBuiltinPlatforms();

  const fileStore = new LocalFileStore(config.blobDir);
  const credentialRepo = new CredentialRepository(
    db,
    config.masterKey,
    config.storePlatformPassword,
  );
  const riskGuard = new RiskGuard(db, {
    defaultCooldownMinutes: Number(
      process.env.FITBRIDGE_AUTH_COOLDOWN_MINUTES ?? 60,
    ),
  });
  const app = await buildApp({
    config,
    db,
    fileStore,
    credentialRepo,
    riskGuard,
  });

  await app.listen({ host: config.host, port: config.port });

  app.log.info(
    {
      db: dbReady,
      dbFile: config.databaseFile,
      blobs: config.blobDir,
      host: config.host,
      port: config.port,
    },
    'FitBridge 已启动',
  );

  if (boot.generatedPassword) {
    // 只打印一次
    app.log.warn(
      'FITBRIDGE_PASSWORD 未设置，已生成初始管理员密码：' + boot.generatedPassword,
    );
    app.log.warn('请立即登录并妥善保存；重置密码：npm run reset-password');
  }
}

main().catch((err) => {
  console.error('启动失败', err);
  process.exit(1);
});
