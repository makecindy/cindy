import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  isBrowserProxyRequestUrlAllowed,
  isBrowserProxyRequestUrlAllowedAsync,
  parseBrowserProxyServer,
  redactBrowserProxyRoute,
  redactBrowserProxyText,
  resetBrowserProxyDnsVerdictCache,
} from '../proxy.js';

describe('browser proxy normalization', () => {
  it('canonicalizes Chromium-supported proxy URL forms', () => {
    expect(parseBrowserProxyServer('HTTP://Proxy.Example:80')).toEqual({
      mode: 'proxied',
      server: 'http://proxy.example',
    });
    expect(parseBrowserProxyServer('socks5://[2001:db8::1]:1080')).toEqual({
      mode: 'proxied',
      server: 'socks5://[2001:db8::1]:1080',
    });
    expect(parseBrowserProxyServer(undefined)).toEqual({ mode: 'direct' });
  });

  it('canonicalizes and carries a bounded public hostname allowlist', () => {
    expect(parseBrowserProxyServer('http://proxy.example:8080', [
      '*.EXAMPLE.COM',
      'auth.example.com',
      'auth.example.com',
    ])).toEqual({
      mode: 'proxied',
      server: 'http://proxy.example:8080',
      allowedHostnames: ['*.example.com', 'auth.example.com'],
    });
  });

  it('rejects authenticated proxy URLs (userinfo is not supported)', () => {
    // Authenticated proxies cannot be supported safely over connectOverCDP —
    // the only credential channel also leaks to untrusted origins — so userinfo
    // is a loud parse-time rejection rather than a silent no-auth launch.
    for (const raw of [
      'http://u%2Fser:p%40ss%3Aword%23x@proxy.example:8080',
      'http://user:pass@proxy.example:8080',
      'http://user@proxy.example:8080',
      'https://user:pass@proxy.example:8443',
      'socks5://user:pass@proxy.example:1080',
    ]) {
      expect(() => parseBrowserProxyServer(raw), raw).toThrow(/invalid proxyServer/);
    }
  });

  it('rejects oversized proxy input before any destructive route change', () => {
    // WHATWG URL happily accepts a hostname of hundreds of thousands of chars.
    // Parsing must reject it, because a route switch stops the running browser
    // FIRST and only then builds the PAC/argv — so oversized input that fails
    // later costs the user their tabs.
    const longLabel = 'a'.repeat(64); // one over the 63-char DNS label limit
    const longName = `${'a'.repeat(60)}.`.repeat(5) + 'example.com';
    expect(() => parseBrowserProxyServer(`http://${longLabel}.example.com:8080`))
      .toThrow(/at most 63 characters/);
    expect(() => parseBrowserProxyServer(`http://${'a'.repeat(300)}:8080`))
      .toThrow(/invalid proxyServer/);
    expect(() => parseBrowserProxyServer(`http://proxy.example:8080?${'a'.repeat(5000)}`))
      .toThrow(/invalid proxyServer/);
    // Allowlist entries are bounded the same way.
    expect(() => parseBrowserProxyServer('http://proxy.example:8080', [`${longLabel}.example.com`]))
      .toThrow(/at most 63 characters/);
    expect(() => parseBrowserProxyServer('http://proxy.example:8080', [longName + '.' + 'b'.repeat(250)]))
      .toThrow(/at most 253 characters/);
    // A normal name at the boundary still parses.
    expect(parseBrowserProxyServer('http://proxy.example:8080', ['a'.repeat(63) + '.example.com']))
      .toMatchObject({ mode: 'proxied' });
  });

  it('rejects empty and non-LDH DNS labels before any destructive route change', () => {
    // WHATWG URL preserves these hostnames verbatim, so without a label check
    // they pass parsing, the route switch stops the running browser, and only
    // then does PAC/DNS matching fail — losing the user's tabs.
    for (const hostname of [
      'example..com',
      '_foo.example.com',
      '-foo.example.com',
      'foo-.example.com',
      'foo_bar.example.com',
    ]) {
      expect(() => parseBrowserProxyServer('http://proxy.example:8080', [hostname]), hostname)
        .toThrow(/invalid proxyServer/);
      expect(() => parseBrowserProxyServer('http://proxy.example:8080', [`*.${hostname}`]), hostname)
        .toThrow(/invalid proxyServer/);
      expect(() => parseBrowserProxyServer(`http://${hostname}:8080`), hostname)
        .toThrow(/invalid proxyServer/);
    }
    // Trailing-dot FQDNs have an empty final label; strictness beats a dead route.
    expect(() => parseBrowserProxyServer('http://proxy.example.:8080'))
      .toThrow(/invalid proxyServer/);
    // Hyphens inside a label stay legal, as do IP-literal proxy hosts.
    expect(parseBrowserProxyServer('http://proxy.example:8080', ['foo-bar.example.com']))
      .toMatchObject({ mode: 'proxied', allowedHostnames: ['foo-bar.example.com'] });
    expect(parseBrowserProxyServer('http://10.0.0.1:8080'))
      .toEqual({ mode: 'proxied', server: 'http://10.0.0.1:8080' });
    expect(parseBrowserProxyServer('socks5://[2001:db8::1]:1080'))
      .toEqual({ mode: 'proxied', server: 'socks5://[2001:db8::1]:1080' });
  });

  it('never surfaces credentials in the redacted route', () => {
    const route = parseBrowserProxyServer('http://proxy.example:8080');
    expect(route).toEqual({ mode: 'proxied', server: 'http://proxy.example:8080' });
    expect(redactBrowserProxyRoute(route)).toEqual({
      mode: 'proxied',
      server: 'http://proxy.example:8080',
    });
  });

  it.each([
    '',
    'proxy.example:8080',
    'http://proxy.example:',
    'ftp://proxy.example:21',
    'http://proxy.example:8080/path',
    'http://proxy.example:8080/.',
    'http://proxy.example:8080/%2e',
    'http://proxy.example:8080//',
    'http://proxy.example:8080?token=secret',
    'http://proxy.example:8080#fragment',
    'http://proxy.example:8080,direct://',
    'http://proxy.example:99999',
    'socks5://user:secret@proxy.example:1080',
  ])('rejects ambiguous or unsupported value %s', (value) => {
    expect(() => parseBrowserProxyServer(value)).toThrow(/invalid proxyServer/);
  });

  it.each([
    ['http://proxy.example:8080', ['localhost']],
    ['http://proxy.example:8080', ['127.0.0.1']],
    ['http://proxy.example:8080', ['example.com:443']],
    ['http://proxy.example:8080', ['https://example.com']],
    ['http://proxy.example:8080', ['example.com/path']],
    [undefined, ['example.com']],
  ] as const)('rejects unsafe or detached hostname allowlists', (proxy, hostnames) => {
    expect(() => parseBrowserProxyServer(proxy, hostnames)).toThrow(/invalid proxyServer/);
  });

  describe('request-level proxy policy', () => {
    const proxied = parseBrowserProxyServer('http://proxy.example:8080', [
      'allowed.example',
      '*.wild.example',
    ]);

    it.each([
      ['https://allowed.example/page', true],
      ['https://ALLOWED.example./page', true],
      ['https://sub.wild.example/a', true],
      ['https://deep.sub.wild.example/a', true],
      ['https://wild.example/a', false],
      ['https://notallowed.example/a', false],
      ['https://allowed.example.evil.test/a', false],
      ['http://allowed.example/page', false],
      ['ftp://allowed.example/page', false],
      ['not a url', false],
      ['', false],
    ])('applies HTTPS + allowlist policy to %s', (url, expected) => {
      expect(isBrowserProxyRequestUrlAllowed(url, proxied)).toBe(expected);
    });

    it('blocks private literals and internal names that slip past the allowlist', () => {
      // The allowlist is a NAME list, so it cannot by itself keep a request off
      // a private target. Apply the same host/IP policy the navigation guard
      // uses, so an allowlisted-looking request cannot reach loopback, RFC1918
      // or cloud-metadata addresses through the proxy.
      const route = parseBrowserProxyServer('http://proxy.example:8080', [
        '*.example.com',
        'metadata.google.internal.example.com',
      ]);
      // A wildcard cannot be exploited into a literal/internal target.
      for (const host of ['127.0.0.1', '192.168.1.1', '10.0.0.1', 'localhost']) {
        expect(
          isBrowserProxyRequestUrlAllowed(`https://${host}/`, route),
          host,
        ).toBe(false);
      }
      // A genuinely public allowlisted host is still permitted.
      expect(isBrowserProxyRequestUrlAllowed('https://auth.example.com/', route)).toBe(true);
    });

    it('blocks everything when a proxied route carries no allowlist', () => {
      const noAllowlist = parseBrowserProxyServer('http://proxy.example:8080');
      expect(isBrowserProxyRequestUrlAllowed('https://anything.example/', noAllowlist)).toBe(false);
    });

    it('does not constrain direct routes', () => {
      expect(isBrowserProxyRequestUrlAllowed('http://anything.example/', { mode: 'direct' })).toBe(
        true,
      );
    });
  });

  describe('request-level DNS verification', () => {
    const route = parseBrowserProxyServer('http://proxy.example:8080', [
      'allowed.example',
      '*.wild.example',
    ]);
    const lookupOf = (address: string) =>
      vi.fn(async () => [{ address, family: address.includes(':') ? 6 : 4 }]) as never;

    beforeEach(() => {
      resetBrowserProxyDnsVerdictCache();
    });

    it('rejects an allowlisted name that resolves to a private address', async () => {
      // The textual allowlist cannot see this: `allowed.example` matches, but
      // the answer points inward (the `127.0.0.1.nip.io` class of bypass).
      expect(isBrowserProxyRequestUrlAllowed('https://allowed.example/', route)).toBe(true);
      await expect(
        isBrowserProxyRequestUrlAllowedAsync('https://allowed.example/', route, {
          lookupFn: lookupOf('127.0.0.1'),
        }),
      ).resolves.toBe(false);
    });

    it.each(['10.0.0.5', '192.168.1.10', '169.254.169.254', '::1'])(
      'rejects a private answer %s',
      async (address) => {
        await expect(
          isBrowserProxyRequestUrlAllowedAsync('https://sub.wild.example/', route, {
            lookupFn: lookupOf(address),
          }),
        ).resolves.toBe(false);
      },
    );

    it('permits an allowlisted name that resolves publicly', async () => {
      await expect(
        isBrowserProxyRequestUrlAllowedAsync('https://allowed.example/', route, {
          lookupFn: lookupOf('93.184.216.34'),
        }),
      ).resolves.toBe(true);
    });

    it('denies name-level failures without paying a lookup', async () => {
      const lookupFn = lookupOf('93.184.216.34');
      // Not on the allowlist, and plain HTTP: both must be refused by the cheap
      // check, so DNS is never consulted.
      await expect(
        isBrowserProxyRequestUrlAllowedAsync('https://notallowed.example/', route, { lookupFn }),
      ).resolves.toBe(false);
      await expect(
        isBrowserProxyRequestUrlAllowedAsync('http://allowed.example/', route, { lookupFn }),
      ).resolves.toBe(false);
      expect(lookupFn).not.toHaveBeenCalled();
    });

    it('fails closed when the name does not resolve at all', async () => {
      await expect(
        isBrowserProxyRequestUrlAllowedAsync('https://allowed.example/', route, {
          lookupFn: vi.fn(async () => { throw new Error('ENOTFOUND'); }) as never,
        }),
      ).resolves.toBe(false);
    });

    it('never caches an allow, so a rebind is caught on the very next request', async () => {
      // Caching a positive verdict would hand an attacker a stable bypass:
      // answer publicly once, then repoint at loopback and every request in the
      // window skips resolution while the proxy connects to the new answer.
      let clock = 1_000;
      const now = () => clock;
      const publicLookup = lookupOf('93.184.216.34');
      for (let i = 0; i < 3; i += 1) {
        await expect(
          isBrowserProxyRequestUrlAllowedAsync('https://allowed.example/page', route, {
            lookupFn: publicLookup,
            now,
          }),
        ).resolves.toBe(true);
      }
      // Every allowed request re-resolves — no window where the answer is assumed.
      expect(publicLookup).toHaveBeenCalledTimes(3);

      // Rebind with the clock UNCHANGED: no TTL has lapsed, and it is still
      // refused immediately.
      await expect(
        isBrowserProxyRequestUrlAllowedAsync('https://allowed.example/page', route, {
          lookupFn: lookupOf('127.0.0.1'),
          now,
        }),
      ).resolves.toBe(false);
    });

    it('caches denials, then re-resolves once the TTL lapses', async () => {
      let clock = 1_000;
      const now = () => clock;
      const privateLookup = lookupOf('127.0.0.1');
      for (let i = 0; i < 3; i += 1) {
        await expect(
          isBrowserProxyRequestUrlAllowedAsync('https://allowed.example/page', route, {
            lookupFn: privateLookup,
            now,
          }),
        ).resolves.toBe(false);
      }
      // A denial IS cached: repeated blocked requests must not each pay a lookup.
      expect(privateLookup).toHaveBeenCalledTimes(1);

      // But a stale denial must not outlive its TTL — a name can recover.
      clock += 30_001;
      await expect(
        isBrowserProxyRequestUrlAllowedAsync('https://allowed.example/page', route, {
          lookupFn: lookupOf('93.184.216.34'),
          now,
        }),
      ).resolves.toBe(true);
    });

    it('permits fake-IP DNS answers used by Clash/Surge/sing-box', async () => {
      // These stacks resolve ordinary public hostnames into 198.18.0.0/15 or
      // IPv6 ULA. The managed config grants the navigation guard both range
      // exemptions; without the same grant here proxy mode is unusable on such
      // a machine, and the two layers would disagree about the same hostname.
      for (const address of ['198.18.0.5', 'fd00::1']) {
        resetBrowserProxyDnsVerdictCache();
        await expect(
          isBrowserProxyRequestUrlAllowedAsync('https://allowed.example/', route, {
            lookupFn: lookupOf(address),
          }),
          address,
        ).resolves.toBe(true);
      }
      // The exemptions are narrow: ordinary private ranges stay blocked.
      resetBrowserProxyDnsVerdictCache();
      await expect(
        isBrowserProxyRequestUrlAllowedAsync('https://allowed.example/', route, {
          lookupFn: lookupOf('192.168.1.10'),
        }),
      ).resolves.toBe(false);
    });

    it('does not constrain direct routes', async () => {
      const lookupFn = lookupOf('127.0.0.1');
      await expect(
        isBrowserProxyRequestUrlAllowedAsync('http://anything.example/', { mode: 'direct' }, {
          lookupFn,
        }),
      ).resolves.toBe(true);
      expect(lookupFn).not.toHaveBeenCalled();
    });
  });

  it('redacts reserved-character credentials from arbitrary errors', () => {
    const raw =
      'dial http://u%2Fser:p%40ss%3Aword%23x@proxy.example:8080 and http://user:p@ss@other.example failed';
    const redacted = redactBrowserProxyText(raw);
    expect(redacted).not.toContain('u%2Fser');
    expect(redacted).not.toContain('p%40ss');
    expect(redacted).not.toContain('p@ss');
    expect(redacted).toContain('http://[REDACTED]@proxy.example:8080');
    expect(redacted).toContain('http://[REDACTED]@other.example');
  });
});
