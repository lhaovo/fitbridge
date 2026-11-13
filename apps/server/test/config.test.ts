import { describe, expect, it } from 'vitest';

describe('配置加载', () => {
  it('未设置密码时生成随机密码', async () => {
    const { loadConfig } = await import('../src/config.js');
    const old = process.env.FITBRIDGE_PASSWORD;
    delete process.env.FITBRIDGE_PASSWORD;
    const cfg = loadConfig();
    expect(cfg.adminPassword.length).toBeGreaterThan(8);
    expect(cfg.generatedPassword).toBe(cfg.adminPassword);
    if (old !== undefined) process.env.FITBRIDGE_PASSWORD = old;
  });

  it('设置了密码时直接使用', async () => {
    const { loadConfig } = await import('../src/config.js');
    const old = process.env.FITBRIDGE_PASSWORD;
    process.env.FITBRIDGE_PASSWORD = 'my-secret';
    const cfg = loadConfig();
    expect(cfg.adminPassword).toBe('my-secret');
    expect(cfg.generatedPassword).toBeUndefined();
    if (old === undefined) {
      delete process.env.FITBRIDGE_PASSWORD;
    } else {
      process.env.FITBRIDGE_PASSWORD = old;
    }
  });
});
