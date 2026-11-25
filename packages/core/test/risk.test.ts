import { describe, expect, it } from 'vitest';
import { classifyAuthFailure, isTransientFailure, isNetworkFailure } from '../src/index.js';

describe('登录失败分类（参考项目的风控经验固化）', () => {
  it('识别 429 / 限流', () => {
    const f = classifyAuthFailure('HTTP 429 Too Many Requests');
    expect(f.kind).toBe('rate-limited');
    expect(f.shouldCooldown).toBe(true);
  });

  it('识别中文风控关键词', () => {
    for (const s of ['账号触发风控，请稍后再试', '请求过于频繁', '已限流', '冷却中']) {
      expect(classifyAuthFailure(s).kind).toBe('rate-limited');
    }
  });

  it('识别验证码 / 两步验证 / MFA', () => {
    for (const s of [
      '需要输入验证码',
      'two-step verification required',
      '请完成两步验证',
      'security code needed',
    ]) {
      const f = classifyAuthFailure(s);
      expect(f.kind).toBe('challenge-required');
      expect(f.shouldCooldown).toBe(true);
    }
  });

  it('识别明确的密码错误（不冷却）', () => {
    const f = classifyAuthFailure('invalid password');
    expect(f.kind).toBe('invalid-credential');
    expect(f.shouldCooldown).toBe(false);
  });

  it('中文密码错误也识别', () => {
    expect(classifyAuthFailure('密码错误').kind).toBe('invalid-credential');
    expect(classifyAuthFailure('账号或密码错误').kind).toBe('invalid-credential');
  });

  it('★ 模糊词按风控保守处理（参考项目：输错一次即可能触发风控）', () => {
    const f = classifyAuthFailure('invalid');
    expect(f.kind).toBe('ambiguous');
    expect(f.shouldCooldown).toBe(true);

    const g = classifyAuthFailure('password');
    expect(g.kind).toBe('ambiguous');
    expect(g.shouldCooldown).toBe(true);
  });

  it('限流关键词优先于密码关键词', () => {
    const f = classifyAuthFailure('invalid password, rate limit exceeded');
    expect(f.kind).toBe('rate-limited');
  });

  it('未知错误不冷却', () => {
    const f = classifyAuthFailure('something odd happened');
    expect(f.kind).toBe('unknown');
    expect(f.shouldCooldown).toBe(false);
  });

  it('HTTP 429 状态码直接判定限流', () => {
    expect(classifyAuthFailure('whatever', { status: 429 }).kind).toBe(
      'rate-limited',
    );
  });
});

describe('技术性失败识别', () => {
  it('网络类错误可重试', () => {
    expect(isTransientFailure('ECONNRESET')).toBe(true);
    expect(isTransientFailure('ETIMEDOUT')).toBe(true);
    expect(isTransientFailure('socket hang up')).toBe(true);
  });

  it('5xx / 408 可重试，4xx 不可', () => {
    expect(isTransientFailure('x', 503)).toBe(true);
    expect(isTransientFailure('x', 408)).toBe(true);
    expect(isTransientFailure('x', 401)).toBe(false);
    expect(isTransientFailure('x', 400)).toBe(false);
  });
});


describe('网络故障分类', () => {
  it('连接被重置 → network，不冷却、不算凭证问题', () => {
    const f = classifyAuthFailure(
      '连接被重置（services.mywhoosh.com）：read ECONNRESET',
    );
    expect(f.kind).toBe('network');
    // ★ 绝不因为网络故障给账号记风控冷却
    expect(f.shouldCooldown).toBe(false);
    expect(f.cooldownMinutes).toBe(0);
    expect(f.message).toContain('不是账号密码问题');
  });

  it('TLS 握手超时（代理上游不通）→ network', () => {
    const f = classifyAuthFailure(
      'TCP 已连通但 TLS 握手失败（TLS 握手超时）—— 通常是本机代理的上游节点不通',
    );
    expect(f.kind).toBe('network');
    expect(f.shouldCooldown).toBe(false);
  });

  it('密码错仍然是 invalid-credential，不被网络分类误伤', () => {
    const f = classifyAuthFailure('账号或密码不正确');
    expect(f.kind).toBe('invalid-credential');
    expect(f.shouldCooldown).toBe(false);
  });

  it('限流信号仍然触发冷却', () => {
    const f = classifyAuthFailure('请求过于频繁，请稍后再试');
    expect(f.kind).toBe('rate-limited');
    expect(f.shouldCooldown).toBe(true);
  });

  it('isNetworkFailure 覆盖常见网络错误', () => {
    for (const t of [
      'read ECONNRESET',
      'connect ECONNREFUSED 1.2.3.4:443',
      'socket hang up',
      'fetch failed',
      'getaddrinfo ENOTFOUND api.example.com',
      '连接超时（api.example.com）',
      '连接被重置（api.example.com）',
      '域名解析失败（api.example.com）',
    ]) {
      expect(isNetworkFailure(t), t).toBe(true);
    }
    expect(isNetworkFailure('账号或密码不正确')).toBe(false);
    expect(isNetworkFailure('请求过于频繁')).toBe(false);
  });
});
