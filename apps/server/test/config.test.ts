import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dataDir: string;
let restore: () => void;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'fb-cfg-'));
  const oldDir = process.env.FITBRIDGE_DATA_DIR;
  const oldKey = process.env.FITBRIDGE_MASTER_KEY;
  const oldPwd = process.env.FITBRIDGE_PASSWORD;
  process.env.FITBRIDGE_DATA_DIR = dataDir;
  delete process.env.FITBRIDGE_MASTER_KEY;
  restore = () => {
    if (oldDir === undefined) delete process.env.FITBRIDGE_DATA_DIR;
    else process.env.FITBRIDGE_DATA_DIR = oldDir;
    if (oldKey === undefined) delete process.env.FITBRIDGE_MASTER_KEY;
    else process.env.FITBRIDGE_MASTER_KEY = oldKey;
    if (oldPwd === undefined) delete process.env.FITBRIDGE_PASSWORD;
    else process.env.FITBRIDGE_PASSWORD = oldPwd;
  };
});

afterEach(() => {
  restore();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('配置加载', () => {
  it('未设置密码时 adminPassword 为 undefined（由 bootstrap 生成）', async () => {
    const { loadConfig } = await import('../src/config.js');
    delete process.env.FITBRIDGE_PASSWORD;
    const cfg = loadConfig();
    expect(cfg.adminPassword).toBeUndefined();
  });

  it('设置了密码时直接使用', async () => {
    const { loadConfig } = await import('../src/config.js');
    process.env.FITBRIDGE_PASSWORD = 'my-secret';
    const cfg = loadConfig();
    expect(cfg.adminPassword).toBe('my-secret');
  });

  it('主密钥自动生成 32 字节并持久化（重启后不变）', async () => {
    const { loadConfig } = await import('../src/config.js');
    const a = loadConfig();
    expect(a.masterKey.length).toBe(32);
    const b = loadConfig();
    expect(b.masterKey.equals(a.masterKey)).toBe(true);
  });

  it('FITBRIDGE_MASTER_KEY 优先且必须是 32 字节', async () => {
    const { loadConfig } = await import('../src/config.js');
    process.env.FITBRIDGE_MASTER_KEY = Buffer.alloc(32, 7).toString('base64');
    const cfg = loadConfig();
    expect(cfg.masterKey.length).toBe(32);
    expect(cfg.masterKey[0]).toBe(7);

    process.env.FITBRIDGE_MASTER_KEY = Buffer.alloc(16, 7).toString('base64');
    expect(() => loadConfig()).toThrow(/32 字节/);
  });

  it('数据目录下的路径齐全', async () => {
    const { loadConfig } = await import('../src/config.js');
    const cfg = loadConfig();
    expect(cfg.databaseFile).toContain('fitbridge.db');
    expect(cfg.blobDir).toContain('blobs');
    expect(cfg.masterKeyFile).toContain('master.key');
  });
});
