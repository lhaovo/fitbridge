import { describe, expect, it } from 'vitest';
import {
  hashPassword,
  openSecret,
  safeEqual,
  sealSecret,
  signToken,
  verifyToken,
} from '../src/lib/crypto.js';

const KEY = Buffer.from('0'.repeat(64), 'hex');

describe('凭证信封加密', () => {
  it('加解密往返一致', () => {
    const plaintext = JSON.stringify({ token: 'jwt-abc', password: 'p@ss' });
    const sealed = sealSecret(plaintext, KEY);
    expect(openSecret(sealed, KEY)).toBe(plaintext);
  });

  it('密文里不含明文', () => {
    const sealed = sealSecret('super-secret-token', KEY);
    expect(sealed.cipher.toString('utf8')).not.toContain('super-secret-token');
    expect(sealed.cipher.toString('hex')).not.toContain('7375706572');
  });

  it('IV 每次不同（避免相同明文产生相同密文）', () => {
    const a = sealSecret('same', KEY);
    const b = sealSecret('same', KEY);
    expect(a.iv.toString('hex')).not.toBe(b.iv.toString('hex'));
    expect(a.cipher.toString('hex')).not.toBe(b.cipher.toString('hex'));
  });

  it('密钥不对时解密失败', () => {
    const sealed = sealSecret('data', KEY);
    const other = Buffer.from('1'.repeat(64), 'hex');
    expect(() => openSecret(sealed, other)).toThrow();
  });

  it('密文被篡改时解密失败', () => {
    const sealed = sealSecret('data', KEY);
    const tampered = { ...sealed, cipher: Buffer.from(sealed.cipher) };
    tampered.cipher[0] = tampered.cipher[0]! ^ 0xff;
    expect(() => openSecret(tampered, KEY)).toThrow();
  });
});

describe('会话 token', () => {
  it('签名可验证', () => {
    const token = signToken('{"uid":"default"}', KEY);
    expect(verifyToken(token, KEY)).toBe('{"uid":"default"}');
  });

  it('被篡改的 token 验证失败', () => {
    const token = signToken('{"uid":"default"}', KEY);
    expect(verifyToken(token + 'x', KEY)).toBeUndefined();
    expect(verifyToken('garbage', KEY)).toBeUndefined();
  });

  it('换密钥后验证失败', () => {
    const token = signToken('x', KEY);
    expect(verifyToken(token, Buffer.from('1'.repeat(64), 'hex'))).toBeUndefined();
  });
});

describe('口令哈希', () => {
  it('同密码同盐结果一致，不同盐结果不同', () => {
    const a = hashPassword('pw', 'salt1');
    const b = hashPassword('pw', 'salt1');
    const c = hashPassword('pw', 'salt2');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toContain('pw');
  });

  it('恒定时间比较', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});
