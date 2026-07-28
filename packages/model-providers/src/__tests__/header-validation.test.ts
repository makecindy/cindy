import { describe, expect, it } from 'vitest';

import {
  isProtectedCustomProviderHeaderName,
  isValidHttpHeaderName,
  isValidHttpHeaderValue,
  validateCustomHeaderRows,
} from '../header-validation.js';

describe('isValidHttpHeaderName', () => {
  it('accepts RFC 9110 token characters', () => {
    expect(isValidHttpHeaderName('X-Provider')).toBe(true);
    expect(isValidHttpHeaderName('x-custom_header.v1')).toBe(true);
    expect(isValidHttpHeaderName('Authorization')).toBe(true);
  });

  it('rejects names with spaces, separators, or empty', () => {
    expect(isValidHttpHeaderName('X Provider')).toBe(false);
    expect(isValidHttpHeaderName('X:Provider')).toBe(false);
    expect(isValidHttpHeaderName('X/Provider')).toBe(false);
    expect(isValidHttpHeaderName('')).toBe(false);
  });
});

describe('isValidHttpHeaderValue', () => {
  it('accepts printable values, horizontal tab, and obs-text (0x80-0xff)', () => {
    expect(isValidHttpHeaderValue('cindy')).toBe(true);
    expect(isValidHttpHeaderValue('a\tb')).toBe(true);
    expect(isValidHttpHeaderValue('')).toBe(true);
    expect(isValidHttpHeaderValue('\x80\xff')).toBe(true);
  });

  it('rejects control characters and newlines (header injection)', () => {
    expect(isValidHttpHeaderValue('a\nb')).toBe(false);
    expect(isValidHttpHeaderValue('a\rb')).toBe(false);
    expect(isValidHttpHeaderValue('a\x00b')).toBe(false);
    expect(isValidHttpHeaderValue('a\x7fb')).toBe(false);
  });

  it('rejects code points above 0xFF that Headers/undici cannot encode', () => {
    // ByteString 只能承载 0x00-0xFF：中文 / emoji 存得下但发不出去，入口就该挡掉。
    expect(isValidHttpHeaderValue('中文')).toBe(false);
    expect(isValidHttpHeaderValue('🙂')).toBe(false);
    // 边界：é = U+00E9 落在 obs-text（0x80-0xFF）内，仍放行。
    expect(isValidHttpHeaderValue('café')).toBe(true);
  });
});

describe('isProtectedCustomProviderHeaderName', () => {
  it('flags protocol-integrity headers case-insensitively', () => {
    expect(isProtectedCustomProviderHeaderName('Host')).toBe(true);
    expect(isProtectedCustomProviderHeaderName('content-length')).toBe(true);
    expect(isProtectedCustomProviderHeaderName('Transfer-Encoding')).toBe(true);
    expect(isProtectedCustomProviderHeaderName('Connection')).toBe(true);
  });

  it('does not flag auth headers (handled at route layer) or custom headers', () => {
    expect(isProtectedCustomProviderHeaderName('authorization')).toBe(false);
    expect(isProtectedCustomProviderHeaderName('x-api-key')).toBe(false);
    expect(isProtectedCustomProviderHeaderName('X-Provider')).toBe(false);
  });
});

describe('validateCustomHeaderRows', () => {
  it('normalizes valid rows and skips blank-name placeholders', () => {
    const result = validateCustomHeaderRows([
      { name: 'X-Provider', value: ' cindy ' },
      { name: '  ', value: 'ignored' },
      { name: ' X-Env ', value: 'prod' },
    ]);
    expect(result).toEqual({ ok: true, headers: { 'X-Provider': 'cindy', 'X-Env': 'prod' } });
  });

  it('keeps last-wins on duplicate names (no error)', () => {
    const result = validateCustomHeaderRows([
      { name: 'X-Env', value: 'a' },
      { name: 'X-Env', value: 'b' },
    ]);
    expect(result).toEqual({ ok: true, headers: { 'X-Env': 'b' } });
  });

  it('dedupes case-insensitively so only one header reaches upstream', () => {
    const result = validateCustomHeaderRows([
      { name: 'X-Env', value: 'a' },
      { name: 'x-env', value: 'b' },
    ]);
    // Later occurrence wins both casing and value; no second `X-Env` key survives.
    expect(result).toEqual({ ok: true, headers: { 'x-env': 'b' } });
  });

  it('reports the first invalid name with its index', () => {
    const result = validateCustomHeaderRows([
      { name: 'X-Ok', value: '1' },
      { name: 'bad name', value: '2' },
    ]);
    expect(result).toEqual({ ok: false, reason: 'invalid-name', index: 1, name: 'bad name' });
  });

  it('reports protected headers', () => {
    const result = validateCustomHeaderRows([{ name: 'Content-Length', value: '10' }]);
    expect(result).toEqual({ ok: false, reason: 'protected', index: 0, name: 'Content-Length' });
  });

  it('reports invalid values', () => {
    const result = validateCustomHeaderRows([{ name: 'X-Multi', value: 'line1\nline2' }]);
    expect(result).toEqual({ ok: false, reason: 'invalid-value', index: 0, name: 'X-Multi' });
  });
});
