import type { AuthFailure } from '@fitbridge/core';
import type { Database } from './db.js';

/**
 * 风控防护（冷却 + 登录节流）。
 *
 * 设计依据来自参考项目踩过的坑：
 *   1. 密码输错一次就可能触发风控 → 登录失败不自动重试
 *   2. 冷却期内反复尝试会延长封禁 → 冷却期间硬拒绝
 *   3. 同账号多端并发也触发 → 单实例 + 账号级状态
 *   4. 频繁登录会被计数 → 成功登录后设置最小登录间隔
 */
export interface GuardState {
  platformId: string;
  account: string;
  cooldownUntil?: string;
  cooldownReason?: string;
  cooldownKind?: string;
  lastLoginAt?: string;
  failCount: number;
}

export interface GuardDecision {
  allowed: boolean;
  /** 距离允许重试还有多少分钟（向上取整） */
  retryAfterMinutes?: number;
  reason?: string;
  kind?: string;
}

export interface RiskGuardOptions {
  /** 默认冷却时长（分钟） */
  defaultCooldownMinutes: number;
}

export class RiskGuard {
  constructor(
    private readonly db: Database,
    private readonly opts: RiskGuardOptions,
  ) {}

  /**
   * 登录前检查。
   *
   * 两条硬规则：
   *   - 在冷却期 → 拒绝（并告知剩余时间）
   *   - 距上次登录不足 minIntervalSec → 拒绝（登录节流）
   */
  check(
    platformId: string,
    account: string,
    minIntervalSec = 0,
    now: Date = new Date(),
  ): GuardDecision {
    const state = this.get(platformId, account);
    if (!state) return { allowed: true };

    if (state.cooldownUntil) {
      const until = new Date(state.cooldownUntil);
      if (until.getTime() > now.getTime()) {
        return {
          allowed: false,
          retryAfterMinutes: Math.ceil(
            (until.getTime() - now.getTime()) / 60000,
          ),
          reason:
            state.cooldownReason ??
            '检测到风控信号，已进入冷却期（反复尝试会延长封禁）',
          kind: state.cooldownKind ?? 'rate-limited',
        };
      }
    }

    if (minIntervalSec > 0 && state.lastLoginAt) {
      const last = new Date(state.lastLoginAt).getTime();
      const elapsed = (now.getTime() - last) / 1000;
      if (elapsed < minIntervalSec) {
        return {
          allowed: false,
          retryAfterMinutes: Math.ceil((minIntervalSec - elapsed) / 60),
          reason:
            '距离上次登录不足 ' +
            Math.ceil(minIntervalSec / 60) +
            ' 分钟（平台对频繁登录敏感）。请稍后再试，或直接复用已有 token。',
          kind: 'throttled',
        };
      }
    }

    return { allowed: true };
  }

  /** 登录成功后：清除冷却、记录登录时间 */
  recordSuccess(platformId: string, account: string): void {
    const now = new Date().toISOString();
    this.db.run(
      'INSERT INTO auth_guard (platform_id, account, cooldown_until, cooldown_reason, ' +
        ' cooldown_kind, last_login_at, fail_count, updated_at) ' +
        'VALUES (?, ?, NULL, NULL, NULL, ?, 0, ?) ' +
        'ON CONFLICT(platform_id, account) DO UPDATE SET ' +
        'cooldown_until = NULL, cooldown_reason = NULL, cooldown_kind = NULL, ' +
        'last_login_at = excluded.last_login_at, fail_count = 0, updated_at = excluded.updated_at',
      [platformId, account, now, now],
    );
  }

  /** 登录失败后：按分类决定是否冷却 */
  recordFailure(
    platformId: string,
    account: string,
    failure: AuthFailure,
  ): void {
    const now = new Date();
    const existing = this.get(platformId, account);
    const failCount = (existing?.failCount ?? 0) + 1;

    // 连续失败会累加冷却时长，但设上限，避免无限延长
    let minutes = failure.cooldownMinutes;
    if (failure.shouldCooldown && minutes > 0 && failCount > 1) {
      minutes = Math.min(
        minutes * Math.min(failCount, 4),
        this.opts.defaultCooldownMinutes * 4,
      );
    }

    const until = failure.shouldCooldown && minutes > 0
      ? new Date(now.getTime() + minutes * 60000).toISOString()
      : null;

    this.db.run(
      'INSERT INTO auth_guard (platform_id, account, cooldown_until, cooldown_reason, ' +
        ' cooldown_kind, fail_count, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ' +
        'ON CONFLICT(platform_id, account) DO UPDATE SET ' +
        'cooldown_until = excluded.cooldown_until, cooldown_reason = excluded.cooldown_reason, ' +
        'cooldown_kind = excluded.cooldown_kind, fail_count = excluded.fail_count, ' +
        'updated_at = excluded.updated_at',
      [
        platformId,
        account,
        until,
        failure.shouldCooldown ? failure.message : null,
        failure.shouldCooldown ? failure.kind : null,
        failCount,
        now.toISOString(),
      ],
    );
  }

  /** 手动解除冷却（用户确认账号密码正确后） */
  clear(platformId: string, account: string): void {
    this.db.run(
      'UPDATE auth_guard SET cooldown_until = NULL, cooldown_reason = NULL, ' +
        'cooldown_kind = NULL, fail_count = 0, updated_at = ? WHERE platform_id = ? AND account = ?',
      [new Date().toISOString(), platformId, account],
    );
  }

  /** 查询状态 */
  get(platformId: string, account: string): GuardState | undefined {
    const row = this.db.one<{
      platform_id: string;
      account: string;
      cooldown_until: string | null;
      cooldown_reason: string | null;
      cooldown_kind: string | null;
      last_login_at: string | null;
      fail_count: number;
    }>(
      'SELECT platform_id, account, cooldown_until, cooldown_reason, cooldown_kind, ' +
        'last_login_at, fail_count FROM auth_guard WHERE platform_id = ? AND account = ?',
      [platformId, account],
    );
    if (!row) return undefined;
    return {
      platformId: row.platform_id,
      account: row.account,
      cooldownUntil: row.cooldown_until ?? undefined,
      cooldownReason: row.cooldown_reason ?? undefined,
      cooldownKind: row.cooldown_kind ?? undefined,
      lastLoginAt: row.last_login_at ?? undefined,
      failCount: row.fail_count ?? 0,
    };
  }

  /** 全部受保护的账号（用于 UI 展示告警） */
  listGuarded(): GuardState[] {
    return this.db
      .query<{
        platform_id: string;
        account: string;
        cooldown_until: string | null;
        cooldown_reason: string | null;
        cooldown_kind: string | null;
        last_login_at: string | null;
        fail_count: number;
      }>('SELECT * FROM auth_guard')
      .map((r) => ({
        platformId: r.platform_id,
        account: r.account,
        cooldownUntil: r.cooldown_until ?? undefined,
        cooldownReason: r.cooldown_reason ?? undefined,
        cooldownKind: r.cooldown_kind ?? undefined,
        lastLoginAt: r.last_login_at ?? undefined,
        failCount: r.fail_count ?? 0,
      }));
  }
}
