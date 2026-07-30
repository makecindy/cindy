import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  decryptWechatContextToken,
  encryptWechatContextToken,
  WechatContextCryptoError,
} from '../contextCrypto.js';

describe('WeChat context token encryption', () => {
  it('round-trips with AES-256-GCM without persisting plaintext', () => {
    const key = randomBytes(32);
    const encrypted = encryptWechatContextToken('context-token-secret', key, 'epoch-1', 'task-1');

    expect(JSON.stringify(encrypted)).not.toContain('context-token-secret');
    expect(decryptWechatContextToken(encrypted, key, 'epoch-1', 'task-1')).toBe(
      'context-token-secret',
    );
  });

  it('binds ciphertext to both binding epoch and task id', () => {
    const key = randomBytes(32);
    const encrypted = encryptWechatContextToken('secret', key, 'epoch-1', 'task-1');

    expect(() => decryptWechatContextToken(encrypted, key, 'epoch-2', 'task-1')).toThrowError(
      WechatContextCryptoError,
    );
    expect(() => decryptWechatContextToken(encrypted, key, 'epoch-1', 'task-2')).toThrowError(
      WechatContextCryptoError,
    );
  });

  it('fails closed for malformed values and invalid key length', () => {
    expect(() =>
      encryptWechatContextToken('secret', randomBytes(16), 'epoch-1', 'task-1'),
    ).toThrowError(WechatContextCryptoError);
    expect(() =>
      decryptWechatContextToken(
        { nonce: 'bad', ciphertext: 'bad', tag: 'bad' },
        randomBytes(32),
        'epoch-1',
        'task-1',
      ),
    ).toThrowError(WechatContextCryptoError);
  });
});
