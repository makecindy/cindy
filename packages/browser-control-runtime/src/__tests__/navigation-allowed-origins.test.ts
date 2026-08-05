import { describe, expect, it } from 'vitest';

import { resolveSsrFPolicyForUrl } from '../_generated/leaf/src/infra/net/ssrf.js';
import { assertBrowserNavigationAllowed } from '../_generated/extension/src/browser/navigation-guard.js';
import type { LookupFn } from '../_generated/leaf/src/infra/net/ssrf.js';

const PREVIEW_ORIGIN = 'http://127.0.0.1:49152';
const POLICY = { allowedOrigins: [PREVIEW_ORIGIN] };

const loopbackLookup: LookupFn = (async () => [
  { address: '127.0.0.1', family: 4 },
]) as unknown as LookupFn;

/**
 * Navigation-level exact-origin preview allowlist (sandboxed local HTML
 * preview). These assert the vendored guard honors `allowedOrigins` ONLY for
 * the exact scheme+host+port — same host on another port, another scheme, or
 * a missing allowlist must keep failing closed.
 */
describe('exact-origin preview allowlist (navigation level)', () => {
  it('promotes only the matching request origin hostname', () => {
    const promoted = resolveSsrFPolicyForUrl(new URL(`${PREVIEW_ORIGIN}/preview/token/index.html`), POLICY);
    expect(promoted?.allowedHostnames).toContain('127.0.0.1');

    // Same host, different port → no promotion.
    const otherPort = resolveSsrFPolicyForUrl(new URL('http://127.0.0.1:9999/index.html'), POLICY);
    expect(otherPort?.allowedHostnames).toBeUndefined();

    // Different scheme, same host/port → no promotion.
    const otherScheme = resolveSsrFPolicyForUrl(new URL('https://127.0.0.1:49152/index.html'), POLICY);
    expect(otherScheme?.allowedHostnames).toBeUndefined();

    // Different loopback hostname → no promotion.
    const otherHost = resolveSsrFPolicyForUrl(new URL('http://localhost:49152/index.html'), POLICY);
    expect(otherHost?.allowedHostnames).toBeUndefined();
  });

  it('navigates the exact preview origin', async () => {
    await expect(
      assertBrowserNavigationAllowed({
        url: `${PREVIEW_ORIGIN}/preview/<token>/index.html`,
        ssrfPolicy: POLICY,
        lookupFn: loopbackLookup,
      }),
    ).resolves.toBeUndefined();
  });

  it('blocks the same host on a different port', async () => {
    await expect(
      assertBrowserNavigationAllowed({
        url: 'http://127.0.0.1:9999/secret.html',
        ssrfPolicy: POLICY,
        lookupFn: loopbackLookup,
      }),
    ).rejects.toThrow();
  });

  it('blocks a different loopback host on the same port', async () => {
    await expect(
      assertBrowserNavigationAllowed({
        url: 'http://localhost:49152/index.html',
        ssrfPolicy: POLICY,
        lookupFn: loopbackLookup,
      }),
    ).rejects.toThrow();
  });

  it('keeps loopback blocked when no allowedOrigins is configured (default posture)', async () => {
    await expect(
      assertBrowserNavigationAllowed({
        url: `${PREVIEW_ORIGIN}/index.html`,
        ssrfPolicy: {},
        lookupFn: loopbackLookup,
      }),
    ).rejects.toThrow();
  });
});
