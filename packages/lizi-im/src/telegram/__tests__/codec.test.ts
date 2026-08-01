import { describe, expect, it } from 'vitest';

import {
  decodeCallbackData,
  decodeLaneUserId,
  decodeMessageId,
  encodeCallbackData,
  encodeLaneUserId,
  encodeMessageId,
} from '../codec.js';

describe('telegram codec', () => {
  it('messageId roundtrip', () => {
    const encoded = encodeMessageId('-1001234', '42');
    expect(encoded).toBe('-1001234|42');
    expect(decodeMessageId(encoded)).toEqual({ chatId: '-1001234', messageId: '42' });
  });

  it('messageId rejects separator in parts and malformed input', () => {
    expect(() => encodeMessageId('a|b', '1')).toThrow();
    expect(() => decodeMessageId('no-separator')).toThrow();
    expect(() => decodeMessageId('a|b|c')).toThrow();
  });

  it('lane userId roundtrip — 主群流与 topic', () => {
    expect(encodeLaneUserId('-100', null)).toBe('g/-100');
    expect(encodeLaneUserId('-100', '77')).toBe('g/-100/77');
    expect(decodeLaneUserId('g/-100')).toEqual({ chatId: '-100', threadId: '' });
    expect(decodeLaneUserId('g/-100/77')).toEqual({ chatId: '-100', threadId: '77' });
  });

  it('私聊数字 userId 不是 lane', () => {
    expect(decodeLaneUserId('12345678')).toBeNull();
    expect(decodeLaneUserId('')).toBeNull();
  });

  it('callback data 走 ref 表, 64 字节内, 可解回原 payload', () => {
    const data = encodeCallbackData('perm:allow', { requestId: 'r-1', big: 'x'.repeat(500) });
    expect(Buffer.byteLength(data, 'utf8')).toBeLessThanOrEqual(64);
    expect(decodeCallbackData(data)).toEqual({
      buttonId: 'perm:allow',
      payload: { requestId: 'r-1', big: 'x'.repeat(500) },
    });
  });

  it('未知/淘汰的 callback token 解出 null(过期卡语义)', () => {
    expect(decodeCallbackData('r:doesnotexist')).toBeNull();
    expect(decodeCallbackData('legacy-format')).toBeNull();
  });
});
