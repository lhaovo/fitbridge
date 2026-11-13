import { randomUUID } from 'node:crypto';
import type { Credential } from '@fitbridge/core';
import type { Database } from './db.js';
import { openSecret, sealSecret } from './crypto.js';
import { DEFAULT_USER_ID } from './constants.js';

export { DEFAULT_USER_ID };

/**
 * 凭证仓储。
 *
 * 落库结构（整体加密）：
 *   { secret: { ...平台 token... }, credentials: { account, password } }
 *
 * 账号密码与 token 放在同一个 AES-256-GCM 密文里 —— 不引入新的攻击面
 * （能读密文的人本来就持有同一个 master.key）。
 *
 * 存在的意义：平台 token 过期后能自动重新登录，实现无人值守同步。
 */
export interface StoredCredential {
  id: string;
  platformId: string;
  label?: string;
  status: string;
  meta: Record<string, unknown>;
  lastValidatedAt?: string;
  expiresAt?: string;
  createdAt: string;
}

export class CredentialRepository {
  constructor(
    private readonly db: Database,
    private readonly masterKey: Buffer,
    private readonly storePassword: boolean,
  ) {}

  /** 保存（新增） */
  async create(input: {
    platformId: string;
    label?: string;
    authType: string;
    secret: Record<string, unknown>;
    meta?: Record<string, unknown>;
    account?: string;
    password?: string;
    expiresAt?: string;
  }): Promise<string> {
    const payload = JSON.stringify({
      secret: input.secret,
      credentials: this.storePassword
        ? { account: input.account, password: input.password }
        : {},
    });
    const sealed = sealSecret(payload, this.masterKey);
    const id = randomUUID();

    this.db.run(
      'INSERT INTO credentials ' +
        '(id, user_id, platform_id, label, auth_type, secret_cipher, secret_iv, ' +
        ' secret_tag, key_version, meta, status, expires_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        id,
        DEFAULT_USER_ID,
        input.platformId,
        input.label ?? null,
        input.authType,
        sealed.cipher,
        sealed.iv,
        sealed.tag,
        sealed.keyVersion,
        JSON.stringify(input.meta ?? {}),
        'active',
        input.expiresAt ?? null,
      ],
    );
    return id;
  }

  /** 更新密文（重新登录后） */
  async updateSecret(
    id: string,
    secret: Record<string, unknown>,
    meta?: Record<string, unknown>,
  ): Promise<void> {
    const row = this.db.one<{
      secret_cipher: Buffer;
      secret_iv: Buffer;
      secret_tag: Buffer;
      meta: string;
    }>('SELECT secret_cipher, secret_iv, secret_tag, meta FROM credentials WHERE id = ?', [id]);
    if (!row) throw new Error('凭证不存在: ' + id);

    const current = this.decrypt(row);
    const payload = JSON.stringify({
      secret,
      credentials: current.credentials ?? {},
    });
    const sealed = sealSecret(payload, this.masterKey);

    this.db.run(
      'UPDATE credentials SET secret_cipher = ?, secret_iv = ?, secret_tag = ?, ' +
        ' key_version = ?, meta = ?, status = ?, last_validated_at = ? WHERE id = ?',
      [
        sealed.cipher,
        sealed.iv,
        sealed.tag,
        sealed.keyVersion,
        JSON.stringify({ ...(current.meta ?? {}), ...(meta ?? {}) }),
        'active',
        new Date().toISOString(),
        id,
      ],
    );
  }

  /** 列出（不含任何凭证内容） */
  list(): StoredCredential[] {
    const rows = this.db.query<{
      id: string;
      platform_id: string;
      label: string | null;
      status: string;
      meta: string;
      last_validated_at: string | null;
      expires_at: string | null;
      created_at: string;
    }>(
      'SELECT id, platform_id, label, status, meta, last_validated_at, expires_at, created_at ' +
        'FROM credentials WHERE user_id = ? ORDER BY created_at DESC',
      [DEFAULT_USER_ID],
    );
    return rows.map((r) => ({
      id: r.id,
      platformId: r.platform_id,
      label: r.label ?? undefined,
      status: r.status,
      meta: safeJson(r.meta),
      lastValidatedAt: r.last_validated_at ?? undefined,
      expiresAt: r.expires_at ?? undefined,
      createdAt: r.created_at,
    }));
  }

  /** 读取并解密（给 worker 用） */
  get(id: string): Credential | undefined {
    const row = this.db.one<{
      id: string;
      platform_id: string;
      secret_cipher: Buffer;
      secret_iv: Buffer;
      secret_tag: Buffer;
      meta: string;
      expires_at: string | null;
    }>(
      'SELECT id, platform_id, secret_cipher, secret_iv, secret_tag, meta, expires_at ' +
        'FROM credentials WHERE id = ? AND user_id = ?',
      [id, DEFAULT_USER_ID],
    );
    if (!row) return undefined;

    const payload = this.decrypt(row);
    return {
      id: row.id,
      userId: DEFAULT_USER_ID,
      platformId: row.platform_id,
      secret: payload.secret ?? {},
      credentials: payload.credentials,
      meta: safeJson(row.meta),
      expiresAt: row.expires_at ?? undefined,
    };
  }

  /** 按平台取第一个可用凭证 */
  getByPlatform(platformId: string): Credential | undefined {
    const row = this.db.one<{ id: string }>(
      "SELECT id FROM credentials WHERE user_id = ? AND platform_id = ? AND status = 'active' " +
        'ORDER BY created_at DESC LIMIT 1',
      [DEFAULT_USER_ID, platformId],
    );
    return row ? this.get(row.id) : undefined;
  }

  /** 删除 */
  remove(id: string): void {
    this.db.run('DELETE FROM credentials WHERE id = ? AND user_id = ?', [
      id,
      DEFAULT_USER_ID,
    ]);
  }

  /** 标记状态 */
  setStatus(id: string, status: string, errorCode?: string): void {
    this.db.run(
      'UPDATE credentials SET status = ?, error_code = ?, last_validated_at = ? WHERE id = ?',
      [status, errorCode ?? null, new Date().toISOString(), id],
    );
  }

  private decrypt(row: {
    secret_cipher: Buffer;
    secret_iv: Buffer;
    secret_tag: Buffer;
  }): {
    secret: Record<string, unknown>;
    credentials?: { account?: string; password?: string };
    meta?: Record<string, unknown>;
  } {
    const plaintext = openSecret(
      {
        cipher: row.secret_cipher,
        iv: row.secret_iv,
        tag: row.secret_tag,
        keyVersion: 1,
      },
      this.masterKey,
    );
    try {
      return JSON.parse(plaintext) as {
        secret: Record<string, unknown>;
        credentials?: { account?: string; password?: string };
      };
    } catch {
      return { secret: {} };
    }
  }
}

function safeJson(s: string | null | undefined): Record<string, unknown> {
  if (!s) return {};
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return {};
  }
}
