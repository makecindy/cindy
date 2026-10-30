import { gzip } from 'pako';
import { describe, expect, it } from 'vitest';
import { decodeGzipBase64Text, decodeGzipBase64TextBounded } from '../gzipBase64';

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
