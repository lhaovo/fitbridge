import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';

/**
 * 凭证信封加密。
 *
 * 明文凭证只在 worker 内存中短暂存在；落库一律 AES-256-GCM 密文。
 * key_version 字段用于将来轮换主密钥时区分密文。
 */
const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_VERSION = 1;

export interface SealedSecret {
  cipher: Buffer;
  iv: Buffer;
  tag: Buffer;
  keyVersion: number;
}

export function sealSecret(
  plaintext: string,
  masterKey: Buffer,
): SealedSecret {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, masterKey, iv);
  const enc = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  return {
    cipher: enc,
    iv,
    tag: cipher.getAuthTag(),
    keyVersion: KEY_VERSION,
  };
}

export function openSecret(
  sealed: SealedSecret,
  masterKey: Buffer,
): string {
  const decipher = createDecipheriv(ALGO, masterKey, sealed.iv);
  decipher.setAuthTag(sealed.tag);
  return Buffer.concat([decipher.update(sealed.cipher), decipher.final()]).toString(
    'utf8',
  );
}

/** 口令哈希（scrypt + 随机盐），用于单用户登录 */
export function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 64).toString('hex');
}

/** 恒定时间比较 */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** 会话 token 签名：payload.signature */
export function signToken(payload: string, secret: Buffer): string {
  const mac = createHmac('sha256', secret).update(payload).digest('base64url');
  return payload + '.' + mac;
}

export function verifyToken(
  token: string,
  secret: Buffer,
): string | undefined {
  const idx = token.lastIndexOf('.');
  if (idx <= 0) return undefined;
  const payload = token.slice(0, idx);
  const mac = token.slice(idx + 1);
  const expected = createHmac('sha256', secret)
    .update(payload)
    .digest('base64url');
  if (!safeEqual(mac, expected)) return undefined;
  return payload;
}
