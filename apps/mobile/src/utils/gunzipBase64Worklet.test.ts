import { gzipSync, constants } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { decodeGzipBase64TextBounded } from './gzipBase64';
import { gunzipBase64Worklet } from './gunzipBase64Worklet';

const encode = (text: string, options: Parameters<typeof gzipSync>[1] = {}) =>
  gzipSync(Buffer.from(text, 'utf8'), options).toString('base64');

function pseudoRandomText(length: number): string {
  let seed = 7;
  let text = '';
  while (text.length < length) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    text += String.fromCodePoint(32 + (seed % 20_000));
  }
  return text;
}

const SAMPLES: [string, string][] = [
  ['ascii JSON', JSON.stringify({ rows: Array.from({ length: 2000 }, (_, id) => ({ id, name: `row-${id}` })) })],
  ['Chinese and emoji', '手机端回到前台时卡死了 🧊🚀 '.repeat(5000)],
  ['a long overlapping run', 'a'.repeat(300_000)],
  ['poorly compressible text', pseudoRandomText(120_000)],
  ['empty', ''],
];

describe('gunzipBase64Worklet', () => {
  it.each(SAMPLES)('matches pako for %s', (_name, text) => {
    const base64 = encode(text);
    expect(gunzipBase64Worklet(base64, text.length + 1)).toEqual({ ok: true, text });
    expect(decodeGzipBase64TextBounded(base64, text.length + 1)).toBe(text);
  });

  it.each([
    ['stored blocks', { level: 0 }],
    ['fixed huffman blocks', { strategy: constants.Z_FIXED }],
    ['dynamic huffman blocks', { level: 9 }],
  ])('decodes %s', (_name, options) => {
    const text = '{"k":"手机值"}'.repeat(20_000);
    expect(gunzipBase64Worklet(encode(text, options), text.length)).toEqual({ ok: true, text });
  });

  it('skips optional gzip header fields', () => {
    const body = gzipSync(Buffer.from('payload', 'utf8'));
    const extra = Buffer.from([2, 0, 0xaa, 0xbb]);
    const name = Buffer.from('file.json\0', 'latin1');
    const header = Buffer.from(body.subarray(0, 10));
    header[3] = 4 | 8;
    const stream = Buffer.concat([header, extra, name, body.subarray(10)]);
    expect(gunzipBase64Worklet(stream.toString('base64'), 100)).toEqual({ ok: true, text: 'payload' });
  });

  it('flags results over the limit without expanding them', () => {
    const result = gunzipBase64Worklet(encode('a'.repeat(5_000_000)), 1_000);
    expect(result).toMatchObject({ ok: false, limitExceeded: true });
  });

  it('counts UTF-16 code units for the limit, like the pako decoder', () => {
    const text = '🧊'.repeat(10);
    expect(gunzipBase64Worklet(encode(text), 20)).toEqual({ ok: true, text });
    expect(gunzipBase64Worklet(encode(text), 19)).toMatchObject({ ok: false, limitExceeded: true });
  });

  it('rejects altered bytes that keep the same length, as pako does', () => {
    // A stored block copies bytes verbatim, so flipping one keeps the stream and ISIZE valid.
    const stream = gzipSync(Buffer.from('{"balance":1000,"owner":"alice"}', 'utf8'), { level: 0 });
    const at = stream.indexOf(Buffer.from('1000'));
    expect(at).toBeGreaterThan(0);
    const altered = Buffer.from(stream);
    altered[at] = '9'.charCodeAt(0);
    expect(gunzipBase64Worklet(altered.toString('base64'), 1_000))
      .toMatchObject({ ok: false, limitExceeded: false, message: 'gzip crc mismatch' });
    expect(() => decodeGzipBase64TextBounded(altered.toString('base64'), 1_000)).toThrow();
  });

  it('reports corrupt streams as ordinary failures', () => {
    const valid = gzipSync(Buffer.from('hello world, hello world', 'utf8'));
    for (const [name, stream] of [
      ['not gzip', Buffer.from('this is not a gzip stream at all')],
      ['truncated', valid.subarray(0, valid.length - 6)],
    ] as const) {
      const result = gunzipBase64Worklet(stream.toString('base64'), 1_000);
      expect(result, name).toMatchObject({ ok: false, limitExceeded: false });
    }
    expect(gunzipBase64Worklet('@@@@', 10)).toMatchObject({ ok: false, limitExceeded: false });
  });
});
