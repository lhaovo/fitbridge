import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppConfig } from './config.js';
import { Database } from './lib/db.js';
import { CredentialRepository } from './lib/credential-repository.js';
import { RiskGuard } from './lib/risk-guard.js';
import { listEvents } from './lib/repositories.js';
import type { FileStore } from '@fitbridge/core';
import { listManifests, getAdapter, listAdapters } from './lib/platforms.js';
import {
  classifyAuthFailure,
  deriveDeviceId,
  relogin,
  runSync,
  DEFAULT_SYNC_POLICY,
  type ActivityQuery,
  type ActivityStore,
  type EventSink,
  type SyncTaskSpec,
} from '@fitbridge/core';
import { signToken, verifyToken } from './lib/crypto.js';
import { checkLogin } from './lib/bootstrap.js';
import { randomUUID } from 'node:crypto';
import { DEFAULT_USER_ID } from './lib/constants.js';

/**
 * 服务端应用工厂。
 *
 * M0 范围（决策 D2：单用户）：
 * - 无注册、无找回、无用户管理
 * - 登录用环境变量里的管理员密码
 * - 会话用 HMAC 签名的 HttpOnly Cookie
 */
export interface AppDeps {
  config: AppConfig;
  db: Database;
  fileStore?: FileStore;
  credentialRepo: CredentialRepository;
  riskGuard: RiskGuard;
  /** 活动持久化 */
  store: ActivityStore;
  /** 事件写入 */
  events: EventSink;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config, db } = deps;

  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'body.password',
          'body.account',
        ],
        censor: '[redacted]',
      },
    },
  });

  await app.register(cookie, {
    secret: config.masterKey.toString('base64url'),
    hook: 'onRequest',
  });

  // Web 控制台（静态资源）
  const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
  await app.register(fastifyStatic, {
    root: publicDir,
    index: ['index.html'],
    prefix: '/',
  });

  const SESSION_COOKIE = 'fb_session';

  /** 会话有效性与鉴权 */
  async function requireAuth(req: {
    cookies: Record<string, string | undefined>;
  }): Promise<boolean> {
    const token = req.cookies[SESSION_COOKIE];
    if (!token) return false;
    const payload = verifyToken(token, config.masterKey);
    return payload !== undefined;
  }

  app.addHook('onRequest', async (req, reply) => {
    // 静态资源（登录页本身）与健康检查放行
    if (!req.url.startsWith('/api/')) return;
    // 平台能力矩阵与认证接口是公开的
    if (
      req.url.startsWith('/api/v1/platforms') ||
      req.url.startsWith('/api/v1/auth/')
    ) {
      return;
    }
    if (!(await requireAuth(req))) {
      await reply.code(401).send({
        error: {
          code: 'AUTH_EXPIRED',
          message: '未登录',
        },
      });
    }
  });

  // ── 健康检查 ────────────────────────────────────────────
  app.get('/health', async () => ({
    status: 'ok',
    version: '0.1.0',
    db: db.isAvailable,
    dbFile: db.filePath,
    fileStore: deps.fileStore?.kind ?? 'none',
    platforms: listManifests().length,
  }));

  // ── 平台能力矩阵（公开） ────────────────────────────────
  app.get('/api/v1/platforms', async () => ({
    platforms: listManifests(),
  }));

  app.get('/api/v1/platforms/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const manifest = listManifests().find((p) => p.id === id);
    if (!manifest) {
      return reply
        .code(404)
        .send({ error: { code: 'NOT_FOUND', message: '未知平台: ' + id } });
    }
    return { platform: manifest };
  });

  // ── 认证（单用户） ──────────────────────────────────────
  app.get('/api/v1/auth/bootstrap-state', async () => ({
    initialized: true,
    hint: '单用户模式：密码来自 FITBRIDGE_PASSWORD，未设置时首次启动随机生成并打印到日志',
  }));

  app.post('/api/v1/auth/login', async (req, reply) => {
    const body = (req.body ?? {}) as { password?: string };
    if (!body.password || !checkLogin(db, body.password)) {
      return reply.code(401).send({
        error: { code: 'AUTH_EXPIRED', message: '密码错误' },
      });
    }
    const token = signToken(
      JSON.stringify({ uid: 'default', iat: Date.now() }),
      config.masterKey,
    );
    reply.setCookie(SESSION_COOKIE, token, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      signed: false,
      maxAge: 60 * 60 * 24 * 30,
    });
    return { ok: true };
  });

  app.post('/api/v1/auth/logout', async (_req, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/v1/auth/me', async (req) => {
    const ok = await requireAuth(req);
    return {
      user: ok
        ? { id: DEFAULT_USER_ID, role: 'admin', timezone: 'UTC' }
        : undefined,
    };
  });

  // ── 连接管理（连接平台账号） ────────────────────────────
  app.get('/api/v1/connections', async () => {
    if (!db.isAvailable) return { connections: [] };
    // 注意：永远不返回任何凭证内容
    return { connections: deps.credentialRepo.list() };
  });

  /**
   * 连接平台账号。
   *
   * 对 password 类平台：提交账号密码 → 调 adapter.auth() → 凭证加密落库。
   * 凭证明文只在这一次请求里短暂存在。
   */
  app.post('/api/v1/connections/:platformId', async (req, reply) => {
    const { platformId } = req.params as { platformId: string };
    const adapter = getAdapter(platformId);
    if (!adapter) {
      return reply
        .code(404)
        .send({ error: { code: 'NOT_FOUND', message: '未知平台' } });
    }
    if (adapter.manifest.authType !== 'password') {
      return reply.code(400).send({
        error: {
          code: 'CONFIG_ERROR',
          message:
            '平台 ' +
            platformId +
            ' 使用 ' +
            adapter.manifest.authType +
            ' 认证，M0 暂只支持 password 类',
        },
      });
    }

    const body = (req.body ?? {}) as {
      account?: string;
      password?: string;
      label?: string;
    };

    const account = body.account ?? '';

    // ① 风控闸门：冷却期内拒绝一切登录尝试（反复尝试会延长封禁）
    const minInterval = adapter.manifest.rateLimit.minLoginIntervalSec ?? 0;
    const gate = deps.riskGuard.check(platformId, account, minInterval);
    if (!gate.allowed) {
      return reply.code(429).send({
        error: {
          code: 'RATE_LIMITED',
          message: gate.reason,
        },
        retryAfterMinutes: gate.retryAfterMinutes,
        kind: gate.kind,
      });
    }

    // 稳定设备标识：同一安装实例 + 同一账号 → 每次登录都是同一个 DeviceId
    const deviceId = deriveDeviceId(
      config.masterKey,
      platformId,
      body.account,
    );

    let authResult;
    try {
      authResult = await adapter.auth({
        account: body.account,
        password: body.password,
        deviceId,
      });
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      const failure = classifyAuthFailure(raw);

      // ② 失败分类：区分「密码错」与「风控」
      //    ★ 绝不自动重试 —— 参考项目原文：输错一次即可能触发风控
      deps.riskGuard.recordFailure(platformId, account, failure);

      const status = failure.shouldCooldown ? 429 : 401;
      return reply.code(status).send({
        error: {
          code: failure.shouldCooldown ? 'RATE_LIMITED' : 'AUTH_EXPIRED',
          message:
            failure.message +
            '（原始错误：' +
            raw.slice(0, 160) +
            '）',
        },
        kind: failure.kind,
        retryAfterMinutes: failure.cooldownMinutes || undefined,
        willAutoRetry: false,
      });
    }

    // ③ 成功：清除冷却、记录登录时间
    deps.riskGuard.recordSuccess(platformId, account);

    if (!db.isAvailable) {
      return reply.code(503).send({
        error: { code: 'INTERNAL', message: '数据库不可用，无法保存凭证' },
      });
    }

    const id = await deps.credentialRepo.create({
      platformId,
      label: body.label,
      authType: adapter.manifest.authType,
      secret: authResult.secret,
      meta: authResult.meta,
      // 账号密码与 token 一起加密保存 → token 过期后能自动重新登录
      account: body.account,
      password: body.password,
      expiresAt: authResult.expiresAt,
    });

    return {
      id,
      platformId,
      status: 'active',
      // 不回传任何凭证内容
    };
  });

  /**
   * 主动校验凭证有效性。
   * 同时验证「token 过期后能否自动重新登录」这条路径。
   */
  app.post('/api/v1/connections/:id/validate', async (req, reply) => {
    const { id } = req.params as { id: string };
    const cred = deps.credentialRepo.get(id);
    if (!cred) {
      return reply
        .code(404)
        .send({ error: { code: 'NOT_FOUND', message: '凭证不存在' } });
    }
    const adapter = getAdapter(cred.platformId);
    if (!adapter) {
      return reply
        .code(404)
        .send({ error: { code: 'NOT_FOUND', message: '未知平台' } });
    }

    const health = await adapter.validate(cred);
    deps.credentialRepo.setStatus(
      id,
      health.ok ? 'active' : 'expired',
      health.ok ? undefined : health.reason,
    );
    return { ok: health.ok, reason: health.reason, checkedAt: health.checkedAt };
  });

  /**
   * 用保存的账号密码重新登录，换一个新 token。
   * 这是「token 过期 → 自动恢复」的执行体。
   */
  app.post('/api/v1/connections/:id/relogin', async (req, reply) => {
    const { id } = req.params as { id: string };
    const cred = deps.credentialRepo.get(id);
    if (!cred) {
      return reply
        .code(404)
        .send({ error: { code: 'NOT_FOUND', message: '凭证不存在' } });
    }
    const adapter = getAdapter(cred.platformId);
    if (!adapter) {
      return reply
        .code(404)
        .send({ error: { code: 'NOT_FOUND', message: '未知平台' } });
    }
    try {
      const fresh = await relogin(adapter, cred);
      await deps.credentialRepo.updateSecret(id, fresh.secret, fresh.meta);
      deps.credentialRepo.setStatus(id, 'active');
      return { ok: true };
    } catch (err) {
      deps.credentialRepo.setStatus(id, 'error', 'AUTH_EXPIRED');
      return reply.code(401).send({
        error: {
          code: 'AUTH_EXPIRED',
          message:
            '重新登录失败: ' +
            (err instanceof Error ? err.message : String(err)).slice(0, 200),
        },
      });
    }
  });

  // ── 同步 ────────────────────────────────────────────────
  /**
   * 触发一次同步。
   *
   * body: { sourcePlatforms, targetPlatforms, filters, policy, dryRun }
   */
  app.post('/api/v1/sync/run', async (req, reply) => {
    const body = (req.body ?? {}) as Partial<SyncTaskSpec> & {
      dryRun?: boolean;
    };

    const sourcePlatforms = body.sourcePlatforms ?? [];
    const targetPlatforms = body.targetPlatforms ?? [];
    if (!Array.isArray(sourcePlatforms) || sourcePlatforms.length === 0) {
      return reply.code(400).send({
        error: { code: 'CONFIG_ERROR', message: '至少指定一个来源平台' },
      });
    }

    const task: SyncTaskSpec = {
      sourcePlatforms,
      targetPlatforms: targetPlatforms ?? [],
      filters: body.filters ?? {},
      policy: { ...DEFAULT_SYNC_POLICY, ...(body.policy ?? {}) },
    };

    try {
      const summary = await runSync({
        task,
        userId: DEFAULT_USER_ID,
        dryRun: body.dryRun,
        deps: {
          adapters: listAdapters(),
          credentials: async (platformId) =>
            deps.credentialRepo.getByPlatform(platformId),
          files: deps.fileStore!,
          store: deps.store,
          events: deps.events,
          gate: async (platformId, account) => {
            const adapter = getAdapter(platformId);
            const minInterval =
              adapter?.manifest.rateLimit.minLoginIntervalSec ?? 0;
            const d = deps.riskGuard.check(platformId, account ?? '', minInterval);
            return d.allowed
              ? undefined
              : {
                  allowed: false,
                  retryAfterMinutes: d.retryAfterMinutes,
                  reason: d.reason,
                };
          },
        },
      });
      return { summary };
    } catch (err) {
      return reply.code(500).send({
        error: {
          code: 'INTERNAL',
          message: err instanceof Error ? err.message : String(err),
        },
      });
    }
  });

  // ── 活动（统一运动库） ──────────────────────────────────
  app.get('/api/v1/activities', async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const query: ActivityQuery = {
      userId: DEFAULT_USER_ID,
      limit: Math.min(Number(q.limit ?? 100), 500),
      offset: Number(q.offset ?? 0),
      sourcePlatform: q.platform ? q.platform.split(',') : undefined,
      sportType: q.sport ? q.sport.split(',') : undefined,
      since: q.since,
      until: q.until,
      keyword: q.q,
      syncState: q.state ? q.state.split(',') : undefined,
      sort: q.sort === 'created_at' ? 'created_at' : 'start_time',
      order: q.order === 'asc' ? 'asc' : 'desc',
    };
    const { items, total } = await deps.store.list(DEFAULT_USER_ID, query);
    return {
      total,
      limit: query.limit,
      offset: query.offset,
      activities: items.map((a) => ({
        id: a.id,
        source: a.source,
        name: a.name,
        sportType: a.sportType,
        startTime: a.startTime,
        durationSec: a.durationSec,
        distanceMeters: a.distanceMeters,
        elevationGainMeters: a.elevationGainMeters,
        metrics: a.metrics,
        flags: a.flags,
        syncState: a.syncState,
        syncedTargets: a.syncedTargets,
        createdAt: a.createdAt,
      })),
    };
  });

  app.get('/api/v1/activities/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const a = await deps.store.get(DEFAULT_USER_ID, id);
    if (!a) {
      return reply
        .code(404)
        .send({ error: { code: 'NOT_FOUND', message: '活动不存在' } });
    }
    const files = await deps.store.listFiles(id);
    return { activity: a, files };
  });

  /** 下载原始文件 */
  app.get('/api/v1/activities/:id/file', async (req, reply) => {
    const { id } = req.params as { id: string };
    const a = await deps.store.get(DEFAULT_USER_ID, id);
    if (!a) {
      return reply
        .code(404)
        .send({ error: { code: 'NOT_FOUND', message: '活动不存在' } });
    }
    const files = await deps.store.listFiles(id);
    const file = files[0];
    if (!file) {
      return reply
        .code(404)
        .send({ error: { code: 'NOT_FOUND', message: '没有文件' } });
    }
    if (file.expired) {
      return reply.code(410).send({
        error: { code: 'NOT_FOUND', message: '文件已过保留期被清理' },
      });
    }
    const content = await deps.fileStore!.get(file.blobKey);
    reply.header(
      'Content-Type',
      file.kind === 'fit' ? 'application/octet-stream' : 'application/octet-stream',
    );
    reply.header(
      'Content-Disposition',
      'attachment; filename="' +
        (a.name.replace(/[^\w.\u4e00-\u9fa5-]+/g, '_').slice(0, 60) || id) +
        '.' +
        (file.kind === 'fit' ? 'fit' : file.kind),
    );
    return reply.send(content);
  });

  /** 删除活动（本地副本） */
  app.delete('/api/v1/activities/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const a = await deps.store.get(DEFAULT_USER_ID, id);
    if (!a) {
      return reply
        .code(404)
        .send({ error: { code: 'NOT_FOUND', message: '活动不存在' } });
    }
    const files = await deps.store.listFiles(id);
    for (const f of files) {
      await deps.fileStore!.delete(f.blobKey).catch(() => undefined);
    }
    deps.db.run('DELETE FROM activities WHERE id = ? AND user_id = ?', [
      id,
      DEFAULT_USER_ID,
    ]);
    return { ok: true };
  });

  /**
   * 本地库状态（数据库/文件/去重统计/保留策略）。
   */
  app.get('/api/v1/storage/stats', async () => {
    const { collectStorageStats } = await import('./lib/storage-stats.js');
    return {
      stats: await collectStorageStats(deps.db, {
        dbFile: config.databaseFile,
        blobDir: config.blobDir,
        fileRetentionDays: config.fileRetentionDays,
        derivedTtlDays: config.derivedTtlDays,
      }),
    };
  });

  /** 事件历史 */
  app.get('/api/v1/events', async (req) => {
    const q = req.query as Record<string, string | undefined>;
    return {
      events: listEvents(deps.db, DEFAULT_USER_ID, {
        limit: Math.min(Number(q.limit ?? 100), 500),
        offset: Number(q.offset ?? 0),
        level: q.level,
        category: q.category,
      }),
    };
  });

  /**
   * 风控状态查询（供 UI 展示告警）。
   */
  app.get('/api/v1/risk-guard', async () => {
    return { guards: deps.riskGuard.listGuarded() };
  });

  /**
   * 手动解除冷却。
   *
   * 参考项目有「清空风控」功能，但带确认提示：
   *   「若清空风控后强行尝试登录，可能增加冷却时间」
   * 所以这里同样要求显式确认参数。
   */
  app.post('/api/v1/risk-guard/clear', async (req, reply) => {
    const body = (req.body ?? {}) as {
      platformId?: string;
      account?: string;
      confirm?: boolean;
    };
    if (!body.confirm) {
      return reply.code(400).send({
        error: {
          code: 'CONFIG_ERROR',
          message:
            '解除冷却需要 confirm=true。强行登录可能增加冷却时间，请确认账号密码正确后再操作。',
        },
      });
    }
    if (!body.platformId || !body.account) {
      return reply.code(400).send({
        error: { code: 'CONFIG_ERROR', message: '缺少 platformId / account' },
      });
    }
    deps.riskGuard.clear(body.platformId, body.account);
    return { ok: true };
  });

  app.delete('/api/v1/connections/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!db.isAvailable) {
      return reply
        .code(503)
        .send({ error: { code: 'INTERNAL', message: '数据库不可用' } });
    }
    deps.credentialRepo.remove(id);
    return { ok: true };
  });

  return app;
}
