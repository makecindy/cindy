import { describe, expect, it, vi } from 'vitest';
import {
  extractConsoleTargetPath,
  matchConsoleTarget,
  resolveConsoleExternalUrl,
  sharesConsoleDiscoverySite,
  validateConsoleHandoffUrl,
} from '../consoleHandoff';

const AUTH_BASE = 'https://auth.cindy.com.cn';
const CONSOLE_ORIGIN = 'https://console.cindy.com.cn';
const VALID_CODE = 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6';

describe('consoleHandoff matching and validation', () => {
  it('matches auth /console/* prefix links and standalone Console links with query and hash preserved', () => {
    expect(
      matchConsoleTarget(`${AUTH_BASE}/console/orgs/org-1/personal/cloud?region=tokyo#map`, {
        authBaseUrl: AUTH_BASE,
      }),
    ).toEqual({
      targetPath: '/orgs/org-1/personal/cloud?region=tokyo#map',
      entry: 'console_prefix',
    });

    expect(
      matchConsoleTarget(`${AUTH_BASE}/console`, { authBaseUrl: AUTH_BASE }),
    ).toEqual({
      targetPath: '/',
      entry: 'console_prefix',
    });

    expect(
      matchConsoleTarget(`${CONSOLE_ORIGIN}/personal/cloud?view=legacy&region=sg#top`, {
        authBaseUrl: AUTH_BASE,
        consolePublicOrigin: CONSOLE_ORIGIN,
      }),
    ).toEqual({
      targetPath: '/personal/cloud?region=sg#top',
      entry: 'standalone',
    });

    expect(
      matchConsoleTarget(`${CONSOLE_ORIGIN}/personal`, {
        authBaseUrl: AUTH_BASE,
        consolePublicOrigin: CONSOLE_ORIGIN,
      }),
    ).toEqual({
      targetPath: '/personal/overview',
      entry: 'standalone',
    });
  });

  it('rejects auth loops, API/webhook paths, credentials in URL, and unrelated domains', () => {
    for (const url of [
      `${AUTH_BASE}/console/login?next=/personal/cloud`,
      `${AUTH_BASE}/console/callback?code=123`,
      `${AUTH_BASE}/console/handoff#code=${VALID_CODE}`,
      `${AUTH_BASE}/console/support`,
      `${AUTH_BASE}/api/auth/client-config`,
      `${AUTH_BASE}/console/directory/webhooks/feishu/src-1`,
      `${AUTH_BASE}/console/unknown-section`,
      `https://user:pass@auth.cindy.com.cn/console/personal/cloud`,
      'https://auth.cindy.app/console/personal/cloud',
      'https://github.com/makecindy/cindy',
      'http://auth.cindy.com.cn/console/personal/cloud',
    ]) {
      expect(
        matchConsoleTarget(url, { authBaseUrl: AUTH_BASE, consolePublicOrigin: CONSOLE_ORIGIN }),
        url,
      ).toBeNull();
    }
  });

  it('allows loopback http only for local development', () => {
    expect(
      matchConsoleTarget('http://localhost:3344/console/personal/cloud', {
        authBaseUrl: 'http://localhost:3344',
      }),
    ).toEqual({
      targetPath: '/personal/cloud',
      entry: 'console_prefix',
    });
    expect(extractConsoleTargetPath('/orgs/%E0%A4%A/personal/cloud')).toBeNull();
  });

  it('limits standalone Console discovery hints to same parent domain or loopback', () => {
    expect(sharesConsoleDiscoverySite('console.cindy.com.cn', 'auth.cindy.com.cn')).toBe(true);
    expect(sharesConsoleDiscoverySite('console.cindy.app', 'auth.cindy.app')).toBe(true);
    expect(sharesConsoleDiscoverySite('127.0.0.1', 'localhost')).toBe(true);
    expect(sharesConsoleDiscoverySite('github.com', 'auth.cindy.com.cn')).toBe(false);
    expect(sharesConsoleDiscoverySite('cindy.com.cn.evil.test', 'auth.cindy.com.cn')).toBe(false);
    expect(sharesConsoleDiscoverySite('auth.cindy.app', 'auth.cindy.com.cn')).toBe(false);
  });

  it('validates server-returned handoffUrl strictly against allowed origins, paths, and fragment code', () => {
    const prefixHandoff = `${AUTH_BASE}/console/handoff#code=${VALID_CODE}`;
    const standaloneHandoff = `${CONSOLE_ORIGIN}/handoff#code=${VALID_CODE}`;

    expect(
      validateConsoleHandoffUrl(prefixHandoff, { authBaseUrl: AUTH_BASE }),
    ).toBe(prefixHandoff);
    expect(
      validateConsoleHandoffUrl(standaloneHandoff, {
        authBaseUrl: AUTH_BASE,
        consolePublicOrigin: CONSOLE_ORIGIN,
      }),
    ).toBe(standaloneHandoff);

    for (const invalid of [
      `https://evil.example.test/console/handoff#code=${VALID_CODE}`,
      `${AUTH_BASE}/handoff#code=${VALID_CODE}`,
      `${CONSOLE_ORIGIN}/console/handoff#code=${VALID_CODE}`,
      `${AUTH_BASE}/console/handoff?code=${VALID_CODE}`,
      `${AUTH_BASE}/console/handoff#code=short`,
      `${AUTH_BASE}/console/handoff`,
      `javascript:alert(1)`,
      null,
    ]) {
      expect(
        validateConsoleHandoffUrl(invalid, {
          authBaseUrl: AUTH_BASE,
          consolePublicOrigin: CONSOLE_ORIGIN,
        }),
        String(invalid),
      ).toBeNull();
    }
  });
});

describe('resolveConsoleExternalUrl', () => {
  it('upgrades a trusted org-session /console/* link to the one-time handoff URL', async () => {
    const rawUrl = `${AUTH_BASE}/console/orgs/org-1/personal/cloud?region=tokyo#map`;
    const handoffUrl = `${AUTH_BASE}/console/handoff#code=${VALID_CODE}`;
    const requestHandoff = vi.fn().mockResolvedValue({ handoffUrl });
    const getConsolePublicOrigin = vi.fn();

    const resolved = await resolveConsoleExternalUrl(rawUrl, {
      trustedSender: true,
      getSessionMode: () => 'org',
      getAuthBaseUrl: () => AUTH_BASE,
      getConsolePublicOrigin,
      requestHandoff,
    });

    expect(resolved).toBe(handoffUrl);
    expect(getConsolePublicOrigin).not.toHaveBeenCalled();
    expect(requestHandoff).toHaveBeenCalledWith({
      authBaseUrl: AUTH_BASE,
      targetPath: '/orgs/org-1/personal/cloud?region=tokyo#map',
      entry: 'console_prefix',
      sessionMode: 'org',
    });
  });

  it('upgrades a trusted personal account-session link using account mode', async () => {
    const rawUrl = `${AUTH_BASE}/console/personal/cloud?region=tokyo`;
    const handoffUrl = `${AUTH_BASE}/console/handoff#code=${VALID_CODE}`;
    const requestHandoff = vi.fn().mockResolvedValue({ handoffUrl });

    const resolved = await resolveConsoleExternalUrl(rawUrl, {
      trustedSender: true,
      getSessionMode: () => 'account',
      getAuthBaseUrl: () => AUTH_BASE,
      requestHandoff,
    });

    expect(resolved).toBe(handoffUrl);
    expect(requestHandoff).toHaveBeenCalledWith({
      authBaseUrl: AUTH_BASE,
      targetPath: '/personal/cloud?region=tokyo',
      entry: 'console_prefix',
      sessionMode: 'account',
    });
  });

  it('discovers standalone consolePublicOrigin for same-site hosts and requests standalone entry', async () => {
    const rawUrl = `${CONSOLE_ORIGIN}/personal/cloud?region=sg`;
    const handoffUrl = `${CONSOLE_ORIGIN}/handoff#code=${VALID_CODE}`;
    const getConsolePublicOrigin = vi.fn().mockResolvedValue(CONSOLE_ORIGIN);
    const requestHandoff = vi.fn().mockResolvedValue({ handoffUrl });

    const resolved = await resolveConsoleExternalUrl(rawUrl, {
      trustedSender: true,
      getSessionMode: () => 'org',
      getAuthBaseUrl: () => AUTH_BASE,
      getConsolePublicOrigin,
      requestHandoff,
    });

    expect(resolved).toBe(handoffUrl);
    expect(getConsolePublicOrigin).toHaveBeenCalledWith(AUTH_BASE);
    expect(requestHandoff).toHaveBeenCalledWith({
      authBaseUrl: AUTH_BASE,
      targetPath: '/personal/cloud?region=sg',
      entry: 'standalone',
      sessionMode: 'org',
    });
  });

  it('skips handoff with zero network calls for untrusted senders, ineligible sessions, and third-party URLs', async () => {
    const requestHandoff = vi.fn();
    const getConsolePublicOrigin = vi.fn();
    const consoleUrl = `${AUTH_BASE}/console/personal/cloud`;

    expect(
      await resolveConsoleExternalUrl(consoleUrl, {
        trustedSender: false,
        getSessionMode: () => 'org',
        getAuthBaseUrl: () => AUTH_BASE,
        getConsolePublicOrigin,
        requestHandoff,
      }),
    ).toBe(consoleUrl);

    expect(
      await resolveConsoleExternalUrl(consoleUrl, {
        trustedSender: true,
        getSessionMode: () => null,
        getAuthBaseUrl: () => AUTH_BASE,
        getConsolePublicOrigin,
        requestHandoff,
      }),
    ).toBe(consoleUrl);

    const externalUrl = 'https://github.com/makecindy/cindy';
    expect(
      await resolveConsoleExternalUrl(externalUrl, {
        trustedSender: true,
        getSessionMode: () => 'account',
        getAuthBaseUrl: () => AUTH_BASE,
        getConsolePublicOrigin,
        requestHandoff,
      }),
    ).toBe(externalUrl);

    expect(getConsolePublicOrigin).not.toHaveBeenCalled();
    expect(requestHandoff).not.toHaveBeenCalled();
  });

  it('gracefully falls back to the original URL on server errors or malicious handoffUrl responses', async () => {
    const rawUrl = `${AUTH_BASE}/console/personal/cloud`;
    const onFallback = vi.fn();

    expect(
      await resolveConsoleExternalUrl(rawUrl, {
        trustedSender: true,
        getSessionMode: () => 'account',
        getAuthBaseUrl: () => AUTH_BASE,
        requestHandoff: vi.fn().mockRejectedValue(new Error('404 Not Found')),
        onFallback,
      }),
    ).toBe(rawUrl);
    expect(onFallback).toHaveBeenCalledWith('request_failed');

    onFallback.mockClear();
    expect(
      await resolveConsoleExternalUrl(rawUrl, {
        trustedSender: true,
        getSessionMode: () => 'org',
        getAuthBaseUrl: () => AUTH_BASE,
        requestHandoff: vi.fn().mockResolvedValue({
          handoffUrl: `https://evil.example.test/console/handoff#code=${VALID_CODE}`,
        }),
        onFallback,
      }),
    ).toBe(rawUrl);
    expect(onFallback).toHaveBeenCalledWith('invalid_handoff_url');
  });
});
