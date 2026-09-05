import nodePath from 'node:path';
import { describe, expect, it } from 'vitest';

import { buildManagedConfig, managedBrowserGuardIdentity } from '../browser-managed-config.js';

/** Netscape PAC `isInNet` over already-resolved IPv4, for the Node PAC harness. */
function isInNet(host: string, pattern: string, mask: string): boolean {
  const toInt = (value: string): number | null => {
    const parts = value.split('.');
    if (parts.length !== 4) return null;
    let n = 0;
    for (const part of parts) {
      if (!/^\d+$/.test(part)) return null;
      const octet = Number(part);
      if (octet > 255) return null;
      n = (n << 8) + octet;
    }
    return n >>> 0;
  };
  const ip = toInt(host);
  const net = toInt(pattern);
  const bits = toInt(mask);
  if (ip === null || net === null || bits === null) return false;
  return (ip & bits) === (net & bits);
}

describe('managed browser runtime config', () => {
  it('allows only proxy fake-IP ranges without disabling private-network protection', () => {
    expect(buildManagedConfig().browser?.ssrfPolicy).toEqual({
      allowRfc2544BenchmarkRange: true,
      allowIpv6UniqueLocalRange: true,
    });
  });

  it('points the CDP guard at Cindy-real and a relocated port', () => {
    expect(managedBrowserGuardIdentity({
      runtimeDir: '/runtime',
      useRealProfile: false,
    })).toEqual({
      cdpHttpUrl: 'http://127.0.0.1:18800',
      managedUserDataDir: nodePath.join('/runtime', 'browser', 'Cindy', 'user-data'),
    });
    expect(managedBrowserGuardIdentity({
      runtimeDir: '/runtime',
      useRealProfile: true,
      cdpPort: 18801,
    })).toEqual({
      cdpHttpUrl: 'http://127.0.0.1:18801',
      managedUserDataDir: nodePath.join('/runtime', 'browser', 'Cindy-real', 'user-data'),
    });
  });

  it('labels both isolated and snapshot profiles Cindy on the Chrome chip', () => {
    const isolated = buildManagedConfig().browser;
    expect(isolated?.defaultProfile).toBe('Cindy');
    expect(isolated?.profiles?.Cindy?.displayName).toBe('Cindy');

    const snapshot = buildManagedConfig({ useRealProfile: true }).browser;
    expect(snapshot?.defaultProfile).toBe('Cindy-real');
    expect(snapshot?.profiles?.['Cindy-real']?.displayName).toBe('Cindy');
    expect(Object.keys(snapshot?.profiles ?? {})).toEqual(['Cindy-real']);
  });

  it('maps an explicit proxy server to a PAC-only Chrome launch', () => {
    // Chromium applies exactly one proxy mode from the command line, and
    // `--proxy-pac-url` outranks `--proxy-server` (ApplyProxyMode). Emitting
    // both would leave a dead `--proxy-server` that reads as if fixed-proxy
    // semantics applied; the proxy address belongs inside the PAC directive.
    for (const [proxyServer, directive] of [
      ['http://127.0.0.1:7890', 'PROXY 127.0.0.1:7890'],
      ['socks5://[::1]:1080', 'SOCKS5 [::1]:1080'],
    ] as const) {
      const extraArgs = buildManagedConfig({ proxyServer }).browser?.extraArgs ?? [];
      expect(extraArgs.some((arg) => arg.startsWith('--proxy-server'))).toBe(false);
      expect(extraArgs.some((arg) => arg.startsWith('--no-proxy-server'))).toBe(false);
      const pacArg = extraArgs.find((arg) => arg.startsWith('--proxy-pac-url=')) ?? '';
      const decodedPac = Buffer.from(
        pacArg.slice(pacArg.indexOf('base64,') + 'base64,'.length),
        'base64',
      ).toString('utf8');
      expect(decodedPac).toContain(JSON.stringify(directive));
    }
  });

  describe('launch-time PAC allowlist', () => {
    /**
     * Evaluate the generated PAC with Netscape builtins injected. Default
     * `dnsResolve` answers a public IPv4 so hostname tests stay independent of
     * the address gate; pass `dns` to pin a private/empty answer.
     */
    const evaluatePac = (
      options: Parameters<typeof buildManagedConfig>[0],
      host: string,
      scheme = 'https',
      dns: Record<string, string> = {},
    ): string => {
      const pacArg = buildManagedConfig(options).browser?.extraArgs
        ?.find((arg) => arg.startsWith('--proxy-pac-url='));
      if (!pacArg) throw new Error('no PAC arg emitted');
      const encoded = pacArg.slice(pacArg.indexOf('base64,') + 'base64,'.length);
      const source = Buffer.from(encoded, 'base64').toString('utf8');
      const dnsResolve = (name: string): string => {
        const key = String(name || '').toLowerCase().replace(/\.+$/, '');
        if (Object.prototype.hasOwnProperty.call(dns, key)) return dns[key] ?? '';
        return '93.184.216.34';
      };
      // eslint-disable-next-line no-new-func
      const findProxyForURL = new Function(
        'dnsResolve',
        'isInNet',
        `${source}; return FindProxyForURL;`,
      )(dnsResolve, isInNet) as (url: string, host: string) => string;
      return findProxyForURL(`${scheme}://${host}/`, host);
    };

    const proxied = {
      proxyServer: 'http://proxy.example.test:8080',
      proxyAllowedHostnames: ['auth.example.com', '*.wild.example'],
    };

    it.each([
      ['auth.example.com', 'PROXY proxy.example.test:8080'],
      ['AUTH.example.com', 'PROXY proxy.example.test:8080'],
      ['auth.example.com.', 'PROXY proxy.example.test:8080'],
      ['sub.wild.example', 'PROXY proxy.example.test:8080'],
      ['deep.sub.wild.example', 'PROXY proxy.example.test:8080'],
      // Apex of a wildcard pattern, unrelated hosts, and suffix-confusion
      // attempts must all hit the unreachable directive, never DIRECT.
      ['wild.example', 'PROXY 0.0.0.0:0'],
      ['evil.example', 'PROXY 0.0.0.0:0'],
      ['auth.example.com.evil.test', 'PROXY 0.0.0.0:0'],
      ['notauth.example.com', 'PROXY 0.0.0.0:0'],
    ])('routes %s to %s', (host, expected) => {
      expect(evaluatePac(proxied, host)).toBe(expected);
    });

    it.each([
      ['http', 'auth.example.com'],
      ['ws', 'auth.example.com'],
      ['ftp', 'auth.example.com'],
      ['HTTP', 'auth.example.com'],
    ])('refuses %s requests to an allowlisted host at the launch floor', (scheme, host) => {
      expect(evaluatePac(proxied, host, scheme)).toBe('PROXY 0.0.0.0:0');
    });

    // Chrome hands PAC the wss:/ws: scheme unrewritten, and CDP Fetch does not
    // intercept WebSocket handshakes, so the PAC is the only gate these get:
    // encrypted ones must pass the same hostname rules, cleartext must not.
    it.each([
      ['wss', 'auth.example.com', 'PROXY proxy.example.test:8080'],
      ['wss', 'sub.wild.example', 'PROXY proxy.example.test:8080'],
      ['WSS', 'auth.example.com', 'PROXY proxy.example.test:8080'],
      ['wss', 'evil.example', 'PROXY 0.0.0.0:0'],
      ['wss', 'wild.example', 'PROXY 0.0.0.0:0'],
      ['ws', 'auth.example.com', 'PROXY 0.0.0.0:0'],
    ])('routes %s://%s to %s', (scheme, host, expected) => {
      expect(evaluatePac(proxied, host, scheme)).toBe(expected);
    });

    it.each([
      ['127.0.0.1', 'loopback'],
      ['10.1.2.3', 'RFC1918'],
      ['192.168.0.9', 'RFC1918'],
      ['172.16.4.1', 'RFC1918'],
      ['169.254.169.254', 'link-local/metadata'],
      ['100.64.1.1', 'CGNAT'],
    ])('refuses an allowlisted name whose DNS is %s (%s)', (ip) => {
      expect(evaluatePac(proxied, 'auth.example.com', 'https', { 'auth.example.com': ip }))
        .toBe('PROXY 0.0.0.0:0');
      expect(evaluatePac(proxied, 'auth.example.com', 'wss', { 'auth.example.com': ip }))
        .toBe('PROXY 0.0.0.0:0');
    });

    it('still allows Clash/Surge fake-IP answers in 198.18.0.0/15', () => {
      expect(evaluatePac(proxied, 'auth.example.com', 'https', { 'auth.example.com': '198.18.0.2' }))
        .toBe('PROXY proxy.example.test:8080');
      expect(evaluatePac(proxied, 'auth.example.com', 'wss', { 'auth.example.com': '198.18.255.1' }))
        .toBe('PROXY proxy.example.test:8080');
    });

    it('fails closed when PAC dnsResolve returns empty', () => {
      expect(evaluatePac(proxied, 'auth.example.com', 'https', { 'auth.example.com': '' }))
        .toBe('PROXY 0.0.0.0:0');
      expect(evaluatePac(proxied, 'auth.example.com', 'wss', { 'auth.example.com': '' }))
        .toBe('PROXY 0.0.0.0:0');
    });

    it('embeds IPv6 loopback and link-local literal checks in the PAC source', () => {
      const extraArgs = buildManagedConfig({
        proxyServer: 'http://proxy.example.test:8080',
        proxyAllowedHostnames: ['auth.example.com'],
      }).browser?.extraArgs ?? [];
      const pacArg = extraArgs.find((arg) => arg.startsWith('--proxy-pac-url=')) ?? '';
      const decodedPac = Buffer.from(
        pacArg.slice(pacArg.indexOf('base64,') + 'base64,'.length),
        'base64',
      ).toString('utf8');
      expect(decodedPac).toContain('::1');
      expect(decodedPac).toContain('fe80:');
    });

    it('blocks everything when a proxied launch has no allowlist', () => {
      expect(evaluatePac({ proxyServer: 'http://proxy.example.test:8080' }, 'anything.example'))
        .toBe('PROXY 0.0.0.0:0');
    });

    it('emits scheme-appropriate PAC directives', () => {
      expect(evaluatePac(
        { proxyServer: 'socks5://[::1]:1080', proxyAllowedHostnames: ['auth.example.com'] },
        'auth.example.com',
      )).toBe('SOCKS5 [::1]:1080');
      expect(evaluatePac(
        { proxyServer: 'https://proxy.example.test:8443', proxyAllowedHostnames: ['auth.example.com'] },
        'auth.example.com',
      )).toBe('HTTPS proxy.example.test:8443');
    });

    it('does not emit PAC args for a direct launch', () => {
      expect(buildManagedConfig().browser?.extraArgs).toBeUndefined();
    });

    it('keeps hostile hostname patterns as data, not PAC source', () => {
      const directive = evaluatePac({
        proxyServer: 'http://proxy.example.test:8080',
        proxyAllowedHostnames: ['auth.example.com'],
      }, '";return "DIRECT');
      expect(directive).toBe('PROXY 0.0.0.0:0');
    });
  });

  it('maps proxy navigation hostnames to the strict SSRF hostname allowlist', () => {
    expect(buildManagedConfig({
      proxyServer: 'http://127.0.0.1:7890',
      proxyAllowedHostnames: ['*.example.com', 'auth.example.com'],
    }).browser?.ssrfPolicy).toEqual({
      allowRfc2544BenchmarkRange: true,
      allowIpv6UniqueLocalRange: true,
      hostnameAllowlist: ['*.example.com', 'auth.example.com'],
    });
  });

  it.each([
    'ftp://proxy.example.test:21',
    'http://proxy.example.test:8080/path',
    'not a proxy URL',
  ])('rejects unsafe or unsupported proxy server %s', (proxyServer) => {
    expect(() => buildManagedConfig({ proxyServer })).toThrow(/invalid proxyServer/);
  });

  it('blocks non-proxied WebRTC egress on a proxied launch', () => {
    // WebRTC uses UDP outside the proxy, so neither the PAC nor the CDP request
    // gate can see it; without this policy an allowlisted page can disclose the
    // machine's real IP while status reports a proxied route.
    const proxied = buildManagedConfig({
      proxyServer: 'http://proxy.example.test:8080',
      proxyAllowedHostnames: ['auth.example.com'],
    }).browser?.extraArgs ?? [];
    expect(proxied).toContain('--webrtc-ip-handling-policy=disable_non_proxied_udp');
    // Chrome ignores a --force- prefixed variant; guard against reintroducing it.
    expect(proxied.join(' ')).not.toContain('--force-webrtc-ip-handling-policy');

    // A direct launch has no proxy to bypass, so it keeps default behavior.
    expect(buildManagedConfig().browser?.extraArgs).toBeUndefined();
  });

  it('rejects a credentialed proxy URL before building any launch args', () => {
    // Authenticated proxies are unsupported, so credentials never reach launch
    // args by construction: the config builder refuses the URL outright rather
    // than stripping userinfo and launching a browser that cannot authenticate.
    expect(() => buildManagedConfig({
      proxyServer: 'http://user:p%40ss@proxy.example.test:8080',
      proxyAllowedHostnames: ['auth.example.com'],
    })).toThrow(/authenticated proxies are not supported/);
  });

  it('keeps a credential-free proxy in the PAC directive', () => {
    const extraArgs = buildManagedConfig({
      proxyServer: 'http://proxy.example.test:8080',
      proxyAllowedHostnames: ['auth.example.com'],
    }).browser?.extraArgs ?? [];
    expect(extraArgs.some((arg) => arg.startsWith('--proxy-server'))).toBe(false);
    const pacArg = extraArgs.find((arg) => arg.startsWith('--proxy-pac-url=')) ?? '';
    const decodedPac = Buffer.from(
      pacArg.slice(pacArg.indexOf('base64,') + 'base64,'.length),
      'base64',
    ).toString('utf8');
    expect(decodedPac).toContain('proxy.example.test:8080');
    expect(decodedPac).toContain('dnsResolve');
    // No userinfo can appear in a launch arg — the process command line is
    // world-readable on every platform we ship.
    expect(extraArgs.join(' ')).not.toContain('@');
  });
});
