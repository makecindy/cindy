import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import type { WechatEncryptedContext } from '../../localDb/client/tx/types.js';

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export class WechatContextCryptoError extends Error {
  readonly code = 'WECHAT_CONTEXT_CRYPTO_FAILED';

  constructor(message: string) {
    super(message);
    this.name = 'WechatContextCryptoError';
  }
}

export function encryptWechatContextToken(
  token: string,
  dataKey: Uint8Array,
  bindingEpoch: string,
  taskId: string,
): WechatEncryptedContext {
  if (!token) throw new WechatContextCryptoError('Context token is empty.');
  const key = normalizeKey(dataKey);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(contextAad(bindingEpoch, taskId));
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return {
    nonce: nonce.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

export function decryptWechatContextToken(
  encrypted: WechatEncryptedContext,
  dataKey: Uint8Array,
  bindingEpoch: string,
  taskId: string,
): string {
  try {
    const key = normalizeKey(dataKey);
    const nonce = decodeExactBase64(encrypted.nonce, NONCE_BYTES, 'nonce');
    const tag = decodeExactBase64(encrypted.tag, TAG_BYTES, 'tag');
    const ciphertext = decodeBase64(encrypted.ciphertext, 'ciphertext');
    const decipher = createDecipheriv('aes-256-gcm', key, nonce, {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(contextAad(bindingEpoch, taskId));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch (error) {
    if (error instanceof WechatContextCryptoError) throw error;
    throw new WechatContextCryptoError('Stored WeChat context could not be decrypted.');
  }
}

function normalizeKey(dataKey: Uint8Array): Buffer {
  if (dataKey.byteLength !== KEY_BYTES) {
    throw new WechatContextCryptoError('WeChat data key must be 32 bytes.');
  }
  return Buffer.from(dataKey);
}

function contextAad(bindingEpoch: string, taskId: string): Buffer {
  if (!bindingEpoch || !taskId) {
    throw new WechatContextCryptoError('Binding epoch and task id are required.');
  }
  return Buffer.from(`cindy-wechat-context-v1\0${bindingEpoch}\0${taskId}`, 'utf8');
}

function decodeBase64(value: string, label: string): Buffer {
  if (!value || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new WechatContextCryptoError(`Stored ${label} is invalid.`);
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) {
    throw new WechatContextCryptoError(`Stored ${label} is not canonical base64.`);
  }
  return decoded;
}

function decodeExactBase64(value: string, bytes: number, label: string): Buffer {
  const decoded = decodeBase64(value, label);
  if (decoded.byteLength !== bytes) {
    throw new WechatContextCryptoError(`Stored ${label} has an invalid length.`);
  }
  return decoded;
}
