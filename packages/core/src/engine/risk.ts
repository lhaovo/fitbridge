/**
 * 风控识别与错误分类。
 *
 * 背景：参考项目 sports-data-sync-multiplatform 在佳明上踩过完整的坑，
 * 它的 LoginWebActivity.kt 里维护了一张风控关键词表：
 *   ['password','invalid','incorrect','two-step','two step','verification','security code',
 *    'rate limit','too many','429','密码','无效','用户名','验证码','两步','频繁','风控','限流']
 *
 * 本模块把这套经验固化成平台无关的分类器。
 *
 * ★ 最重要的一条规则（来自参考项目原文）：
 *   「佳明对错误密码敏感：输错一次即可能触发风控」
 *   「冷却期内反复尝试会延长封禁」
 * → 识别为「可能的风控」时，绝不自动重试，必须进入冷却并让用户手动确认。
 */

export type AuthFailureKind =
  /** 明确的风控/限流：429、too many、风控、限流 */
  | 'rate-limited'
  /** 需要验证码 / 两步验证 / MFA */
  | 'challenge-required'
  /** 明确的账号密码错误 */
  | 'invalid-credential'
  /** 只是含 "invalid/password" 等模糊词，无法判定 */
  | 'ambiguous'
  /** 其他 */
  | 'unknown';

export interface AuthFailure {
  kind: AuthFailureKind;
  /** 是否应该立刻进入冷却、停止一切自动重试 */
  shouldCooldown: boolean;
  /** 建议冷却时长（分钟）；0 表示不冷却 */
  cooldownMinutes: number;
  /** 给用户看的提示 */
  message: string;
  /** 原始错误文本 */
  raw: string;
}

/** 风控/限流关键词 —— 优先级最高 */
const RATE_LIMIT_KEYWORDS = [
  'rate limit',
  'ratelimit',
  'too many',
  '429',
  'temporarily blocked',
  'try again later',
  '频繁',
  '风控',
  '限流',
  '冷却',
  '封禁',
  'locked',
];

/** 验证码 / 两步验证 / MFA 关键词 */
const CHALLENGE_KEYWORDS = [
  'two-step',
  'two step',
  'two_step',
  'verification code',
  'security code',
  'captcha',
  'mfa',
  '二次验证',
  '两步验证',
  '验证码',
  '短信验证码',
];

/** 明确的密码错误关键词（强信号） */
const INVALID_CREDENTIAL_KEYWORDS = [
  'invalid password',
  'incorrect password',
  'wrong password',
  'password is incorrect',
  '账号或密码',
  '密码错误',
  '用户名或密码',
  '账号不存在',
  '用户不存在',
  'account not found',
];

/** 模糊词：出现但不足以判定（可能只是"请输入密码"） */
const AMBIGUOUS_KEYWORDS = ['password', 'invalid', 'incorrect', '密码', '无效'];

export interface ClassifyOptions {
  /** HTTP 状态码 */
  status?: number;
  /** 冷却时长覆盖（分钟） */
  cooldownMinutes?: number;
}

/**
 * 分类一次登录/请求失败。
 *
 * 判断顺序很重要：
 *   1. 限流/风控（最高优先级）
 *   2. 验证码/MFA
 *   3. 明确的密码错误
 *   4. 模糊词 → ambiguous（可能其实是风控，不能贸然当成密码错误）
 *   5. 未知
 */
export function classifyAuthFailure(
  raw: string,
  opts: ClassifyOptions = {},
): AuthFailure {
  const text = (raw ?? '').toLowerCase();
  const cooldown = opts.cooldownMinutes ?? 60;

  const hit = (list: string[]) => list.some((k) => text.includes(k));

  // 明确的 401：凭证失效（而不是密码错）
  const looksUnauthorized =
    opts.status === 401 ||
    /\b401\b/.test(text) ||
    text.includes('unauthorized') ||
    text.includes('token expired') ||
    text.includes('token invalid');
  if (looksUnauthorized) {
    return {
      kind: 'invalid-credential',
      shouldCooldown: false,
      cooldownMinutes: 0,
      message: '凭证已失效（401），需要重新登录。',
      raw,
    };
  }

  if (opts.status === 429 || hit(RATE_LIMIT_KEYWORDS)) {
    return {
      kind: 'rate-limited',
      shouldCooldown: true,
      cooldownMinutes: cooldown,
      message:
        '平台返回限流/风控信号（可能触发了账号风控）。' +
        '系统已停止自动重试并进入冷却，请等待后再试。',
      raw,
    };
  }

  if (hit(CHALLENGE_KEYWORDS)) {
    return {
      kind: 'challenge-required',
      shouldCooldown: true,
      cooldownMinutes: cooldown,
      message:
        '该平台要求验证码 / 两步验证，纯接口登录无法通过。' +
        '需要在平台官网或 App 侧完成一次验证。',
      raw,
    };
  }

  if (hit(INVALID_CREDENTIAL_KEYWORDS)) {
    return {
      kind: 'invalid-credential',
      // 明确是密码错时不冷却，但同样不自动重试（输错一次就可能触发风控）
      shouldCooldown: false,
      cooldownMinutes: 0,
      message: '账号或密码不正确。请确认后再试，系统不会自动重试。',
      raw,
    };
  }

  if (hit(AMBIGUOUS_KEYWORDS)) {
    return {
      kind: 'ambiguous',
      // 模糊词可能是风控被包装成了"密码错误"，按保守处理：冷却但不长
      shouldCooldown: true,
      cooldownMinutes: Math.max(10, Math.floor(cooldown / 4)),
      message:
        '登录失败原因不明确（可能包含风控信号）。' +
        '为避免触发风控，系统已冷却一段时间，请确认账号密码后手动重试。',
      raw,
    };
  }

  return {
    kind: 'unknown',
    shouldCooldown: false,
    cooldownMinutes: 0,
    message: raw || '登录失败',
    raw,
  };
}

/** 是否属于「可以自动重试」的技术性失败（网络/5xx） */
export function isTransientFailure(raw: string, status?: number): boolean {
  if (status !== undefined) {
    return status >= 500 || status === 408 || status === 429;
  }
  const t = raw.toLowerCase();
  return (
    t.includes('econnreset') ||
    t.includes('etimedout') ||
    t.includes('econnrefused') ||
    t.includes('socket hang up') ||
    t.includes('network')
  );
}
