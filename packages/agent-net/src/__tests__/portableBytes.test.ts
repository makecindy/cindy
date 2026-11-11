/**
 * Regression: Hermes has no dependable global text codec. Exercise the actual
 * shared binary/message codecs without Node's TextEncoder/TextDecoder globals.
 * Unit tier; deterministic bytes, no sockets, credentials or native library.
 */
import { afterEach, expect, it, vi } from 'vitest';
import { decodeDatagrams, encodeDatagrams } from '@cindy/agent-net-protocol';
import { concatBytes, decodeUtf8, fromBase64Url, toBase64Url, utf8 } from '../portableBytes.js';
afterEach(() => vi.unstubAllGlobals());
it('preserves multilingual and non-BMP frames without global text codecs', () => {
  const value = 'Cindy \u4e2d\u6587 \ud83d\udcf1 \u00e4\u00f6\u00fc ' + String.fromCharCode(0xd800);
  const expected = Buffer.from(value), normalized = expected.toString('utf8');
  vi.stubGlobal('TextEncoder', undefined); vi.stubGlobal('TextDecoder', undefined);
  expect(utf8(value)).toEqual(new Uint8Array(expected));
  expect(decodeUtf8(utf8(value))).toBe(normalized);
  expect(fromBase64Url(toBase64Url(expected))).toEqual(new Uint8Array(expected));
  const packets = [utf8(value), Uint8Array.of(0, 255, 128)];
  const frame = encodeDatagrams('dev-1.test', packets);
  const decoded = decodeDatagrams(frame);
  expect(decoded?.deviceId).toBe('dev-1.test');
  expect(concatBytes(decoded!.datagrams)).toEqual(concatBytes(packets));
});
it.each([[0xc0, 0x80], [0xe0, 0x80, 0x80], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80], [0xe2, 0x82]])(
  'rejects malformed or truncated UTF-8 without a platform decoder: %j', (...bytes) => {
    vi.stubGlobal('TextDecoder', undefined);
    expect(() => decodeUtf8(Uint8Array.from(bytes))).toThrow('INVALID_UTF8');
  },
);
