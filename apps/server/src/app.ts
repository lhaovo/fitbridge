import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppConfig } from './config.js';
import { Database } from './lib/db.js';
import type { FileStore } from '@fitbridge/core';
import { listManifests, getAdapter } from './lib/platforms.js';
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
    const rows = await db.query(
      `SELECT id, platform_id, label, status, last_validated_at, expires_at, created_at
         FROM credentials
        WHERE user_id = ?
        ORDER BY created_at DESC`,
      [DEFAULT_USER_ID],
    );
    return {
      connections: rows.map((r) => ({
        id: (r as { id: string }).id,
        platformId: (r as { platform_id: string }).platform_id,
        label: (r as { label?: string }).label,
        status: (r as { status: string }).status,
        lastValidatedAt: (r as { last_validated_at?: string }).last_validated_at,
        expiresAt: (r as { expires_at?: string }).expires_at,
        // 注意：永远不返回任何凭证内容
      })),
    };
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

    let authResult;
    try {
      authResult = await adapter.auth({
        account: body.account,
        password: body.password,
      });
    } catch (err) {
      return reply.code(401).send({
        error: {
          code: 'AUTH_EXPIRED',
          message:
            '平台认证失败: ' +
            (err instanceof Error ? err.message : String(err)).slice(0, 200),
        },
      });
    }

    if (!db.isAvailable) {
      return reply.code(503).send({
        error: { code: 'INTERNAL', message: '数据库不可用，无法保存凭证' },
      });
    }

    const { sealSecret } = await import('./lib/crypto.js');
    const sealed = sealSecret(
      JSON.stringify(authResult.secret),
      config.masterKey,
    );

    const id = await db.one<{ id: string }>(
      `INSERT INTO credentials
         (id, user_id, platform_id, label, auth_type, secret_cipher, secret_iv,
          secret_tag, key_version, meta, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
       RETURNING id`,
      [
        randomUUID(),
        DEFAULT_USER_ID,
        platformId,
        body.label ?? null,
        adapter.manifest.authType,
        sealed.cipher,
        sealed.iv,
        sealed.tag,
        sealed.keyVersion,
        JSON.stringify(authResult.meta ?? {}),
      ],
    );

    return {
      id: id?.id,
      platformId,
      status: 'active',
      // 不回传任何凭证内容
    };
  });

  app.delete('/api/v1/connections/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!db.isAvailable) {
      return reply
        .code(503)
        .send({ error: { code: 'INTERNAL', message: '数据库不可用' } });
    }
    await db.query(
      'DELETE FROM credentials WHERE id = ? AND user_id = ?',
      [id, DEFAULT_USER_ID],
    );
    return { ok: true };
  });

  return app;
}
