import { loadConfig } from './config.js';
import { buildApp } from './app.js';
import { Database } from './lib/db.js';
import { registerBuiltinPlatforms } from './lib/platforms.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const db = new Database(config.databaseUrl);

  const dbReady = await db.connect();
  registerBuiltinPlatforms();

  const app = await buildApp({ config, db });

  await app.listen({ host: config.host, port: config.port });

  app.log.info(
    {
      db: dbReady,
      host: config.host,
      port: config.port,
    },
    'FitBridge 已启动',
  );

  if (config.generatedPassword) {
    // 只打印一次
    app.log.warn(
      `FITBRIDGE_PASSWORD 未设置，已生成初始管理员密码：${config.generatedPassword}`,
    );
    app.log.warn('请立即登录并妥善保存，或设置 FITBRIDGE_PASSWORD 环境变量后重启');
  }
}

main().catch((err) => {
  console.error('启动失败', err);
  process.exit(1);
});
