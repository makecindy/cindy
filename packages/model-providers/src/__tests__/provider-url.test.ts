import { describe, expect, it, vi } from 'vitest';

import {
  appendProviderRequestPath,
  isLoopbackProviderUrl,
  isProviderRequestPath,
} from '../provider-url.js';

describe('isProviderRequestPath', () => {
  it('accepts an encoded same-origin path with query parameters', () => {
    expect(isProviderRequestPath('/tenant/acme/my%20path?stream=1')).toBe(true);
  });

  it('accepts the root path for providers whose base URL already names the inference endpoint', () => {
    expect(isProviderRequestPath('/')).toBe(true);
    expect(appendProviderRequestPath('https://custom.example/infer', '/'))
      .toBe('https://custom.example/infer/');
  });

  it.each([
    '//evil.example/infer',
    '/infer#fragment',
    '/my path',
    '/infer\tmode',
    '/infer\u0000mode',
    '/infer\u007fmode',
    '/infer\u0085mode',
    '/café',
    '/a"b',
    "/a'b",
    '/a<b',
    '/a>b',
    '/a^b',
    '/a`b',
    '/a{b',
    '/a}b',
    '/a|b',
    '/foo%2',
    '/%ZZ',
    '/./infer',
    '/../infer',
    '/%2e/infer',
    '/%2E%2e/infer',
    '/.%2e/infer',
    '/%2e./infer',
    '/%2e%2e%2fadmin',
    '/%2E%2E%5Cadmin',
    '/safe%2Fpart',
    '/safe%5cpart',
    '/模型',
    '/v1\\messages',
    'responses',
  ])('rejects an unsafe or unescaped request path: %j', (requestPath) => {
    expect(isProviderRequestPath(requestPath)).toBe(false);
  });

  it('does not treat dot-like query values as path segments', () => {
    expect(isProviderRequestPath('/infer?next=../other')).toBe(true);
    expect(isProviderRequestPath('/infer?next=%2e%2e')).toBe(true);
    expect(isProviderRequestPath('/infer?next=%2fadmin')).toBe(true);
  });
});

describe('isLoopbackProviderUrl', () => {
  it.each([
    'http://localhost:4000/v1',
    'https://127.0.0.1/v1',
    'http://127.42.0.7:4000/v1',
    'http://[::1]:4000/v1',
  ])('accepts a loopback provider URL: %s', (url) => {
    expect(isLoopbackProviderUrl(url)).toBe(true);
  });

  it('accepts runtimes that serialize the IPv6 loopback hostname without brackets', () => {
    const NativeUrl = URL;
    vi.stubGlobal('URL', class extends NativeUrl {
      override get hostname(): string {
        const hostname = super.hostname;
        return hostname === '[::1]' ? '::1' : hostname;
      }
    });
    try {
      expect(isLoopbackProviderUrl('http://[::1]:4000/v1')).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([
    'https://litellm.example/v1',
    'http://localhost.evil.example/v1',
    'http://128.0.0.1/v1',
    'http://user:pass@localhost:4000/v1',
    'ftp://127.0.0.1/v1',
  ])('rejects a non-loopback or unsafe provider URL: %s', (url) => {
    expect(isLoopbackProviderUrl(url)).toBe(false);
  });
});

describe('appendProviderRequestPath', () => {
  it('preserves the base query and appends the request-path query', () => {
    expect(
      appendProviderRequestPath(
        'https://custom.example/api?tenant=alpha',
        '/infer?stream=1&mode=fast',
      ),
    ).toBe(
      'https://custom.example/api/infer?tenant=alpha&stream=1&mode=fast',
    );
  });

  it('rejects base URLs with embedded credentials', () => {
    expect(() =>
      appendProviderRequestPath('https://user:pass@custom.example/api', '/infer'),
    ).toThrow('invalid provider base URL');
  });

  it('rejects invalid paths before URL construction', () => {
    expect(() => appendProviderRequestPath('https://custom.example', '/my path'))
      .toThrow('invalid provider request path');
  });
});
