import { gzip } from 'pako';
import { describe, expect, it } from 'vitest';
import { PUSH_TRANSFER_DICTIONARY_V1 } from '@cindy/device-link';
import { deflateRawBase64Sync } from '@cindy/device-link/node-compression';
import { decodeDeflateRawBase64TextBounded, decodeGzipBase64Text, decodeGzipBase64TextBounded } from '../gzipBase64';

const toBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

describe('gzip base64 decoding', () => {
  it('decodes UTF-8 text within the limit', () => {
    const text = JSON.stringify({ title: '弱网任务 ✓', rows: 'x'.repeat(50_000) });
    const encoded = toBase64(gzip(text));
    expect(decodeGzipBase64TextBounded(encoded, text.length)).toBe(text);
    expect(decodeGzipBase64Text(encoded)).toBe(text);
  });

  it('aborts a highly compressible payload once it passes the limit', () => {
    const encoded = toBase64(gzip('a'.repeat(2_000_000)));
    expect(encoded.length).toBeLessThan(10_000);
    expect(() => decodeGzipBase64TextBounded(encoded, 100_000)).toThrow(RangeError);
  });

  it('rejects corrupt input', () => {
    expect(() => decodeGzipBase64TextBounded(toBase64(new Uint8Array([1, 2, 3, 4])), 1_000)).toThrow();
  });
});

// push-deflate-v1 跨实现契约：Desktop 被控端用 Node zlib 编码，手机用 pako 解码，两端必须按字节
// 使用同一份预置字典；字典不一致或上限失效时，手机会丢掉推送或无界展开。
describe('push-deflate decoding', () => {
  const text = JSON.stringify({ sessionId: 's', events: [{ event: { type: 'text', data: { text: '弱网下的流式正文 ✓', isFinal: false } } }] });
  const encoded = deflateRawBase64Sync(text, 4, PUSH_TRANSFER_DICTIONARY_V1).compressed.toString('base64');

  it('decodes the Desktop encoder output with the shared dictionary and keeps the output limit', () => {
    expect(decodeDeflateRawBase64TextBounded(encoded, text.length, PUSH_TRANSFER_DICTIONARY_V1)).toBe(text);
    expect(() => decodeDeflateRawBase64TextBounded(encoded, text.length - 1, PUSH_TRANSFER_DICTIONARY_V1)).toThrow(RangeError);
    expect(() => decodeDeflateRawBase64TextBounded(encoded, text.length, '')).toThrow();
  });
});
