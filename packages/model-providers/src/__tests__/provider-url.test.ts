import { describe, expect, it } from 'vitest';

import { appendProviderRequestPath, isProviderRequestPath } from '../provider-url.js';

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
    '/foo%2',
    '/%ZZ',
    '/./infer',
    '/../infer',
    '/%2e/infer',
    '/%2E%2e/infer',
    '/.%2e/infer',
    '/%2e./infer',
    '/模型',
    '/v1\\messages',
    'responses',
  ])('rejects an unsafe or unescaped request path: %j', (requestPath) => {
    expect(isProviderRequestPath(requestPath)).toBe(false);
  });

  it('does not treat dot-like query values as path segments', () => {
    expect(isProviderRequestPath('/infer?next=../other')).toBe(true);
    expect(isProviderRequestPath('/infer?next=%2e%2e')).toBe(true);
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
