/**
 * 敏感配置加密工具（AES-256-GCM）
 *
 * - 密钥独立存放在 data/secrets.key（首次启动自动生成，权限 600）
 * - app.db 中的密文与 secrets.key 分离，单独偷走任一文件都无法解密
 * - 加密的是 CSV 上传的 prompt_config 值（接口地址、访问密钥等）
 */
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

let key: Buffer | null = null;

/** 初始化加密密钥（幂等）。返回当前密钥。 */
export function initCrypto(dataDir: string): Buffer {
  const keyFile = join(dataDir, 'secrets.key');
  if (existsSync(keyFile)) {
    key = Buffer.from(readFileSync(keyFile, 'utf8').trim(), 'hex');
    return key;
  }
  key = randomBytes(32);
  writeFileSync(keyFile, key.toString('hex'), { mode: 0o600 });
  chmodSync(keyFile, 0o600);
  return key;
}

export interface EncryptedValue {
  enc: string; // base64 密文
  iv: string;  // base64 IV
  tag: string; // base64 auth tag
}

/** 加密一段明文 */
export function encryptValue(plain: string): EncryptedValue {
  if (!key) throw new Error('crypto 未初始化');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    enc: enc.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
  };
}

/** 解密一段密文，失败返回 null（密钥不匹配等场景） */
export function decryptValue(enc: string, iv: string, tag: string): string | null {
  if (!key) throw new Error('crypto 未初始化');
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(enc, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    return null;
  }
}
