import { describe, expect, it } from 'vitest';

import {
  base64DecodedByteLength,
  forEachInlineBase64DataUrl,
  isCanonicalBase64,
  isLooseBase64Chars,
  isStrictBase64Chars,
  normalizeBase64Payload,
  parseBase64DataUrl,
  parseDataUrl,
  replaceInlineBase64DataUrls,
} from '../dataUrl.js';

const LARGE_BASE64_CHARS = 4_500_000; // > 2^22 (~3.375 MiB raw), above V8 Irregexp stack threshold

describe('dataUrl linear helpers', () => {
  it('parseBase64DataUrl handles > 2^22 char payloads and preserves header/line-terminator rules', () => {
    const payload = 'A'.repeat(LARGE_BASE64_CHARS);
    const parsed = parseBase64DataUrl(
      `data:Image/PNG;base64,${payload}`,
      /^data:(image\/[a-z0-9+.-]+);base64$/i,
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.header[1]).toBe('Image/PNG');
    expect(parsed!.payload).toHaveLength(LARGE_BASE64_CHARS);

    // Default single-line semantics reject CR/LF/U+2028/U+2029 unless opted in
    expect(parseBase64DataUrl('data:image/png;base64,AA\nAA', /^data:(image\/png);base64$/i)).toBeNull();
    expect(parseBase64DataUrl('data:image/png;base64,AA\u2028AA', /^data:(image\/png);base64$/i)).toBeNull();
    expect(
      parseBase64DataUrl('data:image/png;base64,AA\nAA', /^data:(image\/png);base64$/i, {
        allowLineTerminators: true,
      })?.payload,
    ).toBe('AA\nAA');

    // Empty payload rejected unless allowEmpty is true
    expect(parseBase64DataUrl('data:image/png;base64,', /^data:(image\/png);base64$/i)).toBeNull();
    expect(
      parseBase64DataUrl('data:image/png;base64,', /^data:(image\/png);base64$/i, {
        allowEmpty: true,
      })?.payload,
    ).toBe('');

    // Oversized header rejected before touching the header regex
    expect(
      parseBase64DataUrl(`data:image/${'a'.repeat(3000)};base64,AAAA`, /^data:(image\/[a-z]+);base64$/i),
    ).toBeNull();
  });

  it('isCanonicalBase64 matches the quartet grammar on edge cases and 8 MB payloads without stack overflow', () => {
    const quartetRef = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
    const cases = [
      '',
      'A',
      'AA',
      'AAA',
      'AAAA',
      '=',
      '==',
      '===',
      '====',
      'A===',
      'AA==',
      'AAA=',
      'AA=A',
      'AAAA=',
      'AAAA====',
      'AAAAAA==',
      'AAAAAAA=',
      'AAAA\n',
      'AAA!',
      'aGVsbG8=',
    ];
    for (const sample of cases) {
      expect(isCanonicalBase64(sample), `sample=${JSON.stringify(sample)}`).toBe(quartetRef.test(sample));
    }

    // 8 MB blows V8's default regex stack under the repeating quartet regex.
    const eightMb = 'A'.repeat(8 * 1024 * 1024);
    expect(isCanonicalBase64(eightMb)).toBe(true);
    expect(isCanonicalBase64(`${eightMb.slice(0, -2)}==`)).toBe(true);
    expect(isCanonicalBase64(`${eightMb.slice(0, -1)}!`)).toBe(false);
  });

  it('isStrictBase64Chars and isLooseBase64Chars match reference regex semantics', () => {
    const strictPlus = /^[A-Za-z0-9+/]+={0,2}$/;
    const strictStar = /^[A-Za-z0-9+/]*={0,2}$/;
    for (const sample of ['', '=', '==', '===', 'A', 'A=', 'A==', 'A===', 'A=B', 'AA==', 'AA!', 'AA\n']) {
      expect(isStrictBase64Chars(sample), `plus:${sample}`).toBe(strictPlus.test(sample));
      expect(isStrictBase64Chars(sample, { allowEmpty: true }), `star:${sample}`).toBe(strictStar.test(sample));
    }

    expect(isLooseBase64Chars('')).toBe(false);
    expect(isLooseBase64Chars('', { allowEmpty: true })).toBe(true);
    expect(isLooseBase64Chars('AA==\r\nBB', { allowLineBreaks: true })).toBe(true);
    expect(isLooseBase64Chars('AA== BB', { allowLineBreaks: true })).toBe(false);
    expect(isLooseBase64Chars('AA==\t BB\n', { allowWhitespace: true })).toBe(true);
    expect(isLooseBase64Chars('AA!BB', { allowWhitespace: true })).toBe(false);
  });

  it('forEachInlineBase64DataUrl and replaceInlineBase64DataUrls handle large embedded data URLs accurately', () => {
    const largePayload = 'A'.repeat(LARGE_BASE64_CHARS);
    const input = `prefix data:image/png;base64,${largePayload}== trailing data:image/png;base64,=== keep`;
    const spans: Array<[number, number]> = [];
    forEachInlineBase64DataUrl(
      input,
      { headerPattern: /^image\/[a-zA-Z0-9.+-]+$/, payloadMode: 'strict-padding' },
      (start, end) => spans.push([start, end]),
    );
    expect(spans).toEqual([[7, 7 + 'data:image/png;base64,'.length + LARGE_BASE64_CHARS + 2]]);

    const replaced = replaceInlineBase64DataUrls(
      input,
      { headerPattern: /^image\/[a-zA-Z0-9.+-]+$/, payloadMode: 'strict-padding' },
      () => '[omitted]',
    );
    expect(replaced).toBe('prefix [omitted] trailing data:image/png;base64,=== keep');

    // Stops after at most two '=' padding chars under strict-padding
    expect(
      replaceInlineBase64DataUrls(
        'x data:image/png;base64,AAA===y',
        { headerPattern: /^image\/[a-zA-Z0-9.+-]+$/, payloadMode: 'strict-padding' },
        () => '[img]',
      ),
    ).toBe('x [img]=y');

    // Case-insensitive loose-whitespace with nested bogus `data:` prefix
    expect(
      replaceInlineBase64DataUrls(
        'err: data:bad DATA:image/jpeg;BASE64,AA BB==!end',
        {
          caseInsensitive: true,
          headerPattern: /^[^\s,]{1,128}$/,
          maxHeaderLength: 128,
          payloadMode: 'loose-whitespace',
        },
        () => '[redacted]',
      ),
    ).toBe('err: data:bad [redacted]!end');

    // No-op returns exact input reference
    const clean = 'plain text without data urls';
    expect(
      replaceInlineBase64DataUrls(
        clean,
        { headerPattern: /^image\/png$/, payloadMode: 'loose' },
        () => '[x]',
      ),
    ).toBe(clean);
  });

  it('keeps parseDataUrl, normalizeBase64Payload, and base64DecodedByteLength intact', () => {
    expect(parseDataUrl('data:Image/PNG;charset=utf-8;Base64,aGk=')).toEqual({
      mimeType: 'image/png',
      base64: true,
      payload: 'aGk=',
    });
    expect(normalizeBase64Payload('aG\r\nk=')).toBe('aGk=');
    expect(base64DecodedByteLength('aG k=')).toBe(2);
  });
});
