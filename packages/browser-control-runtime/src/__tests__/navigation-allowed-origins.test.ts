import { describe, expect, it } from 'vitest';

import { resolveSsrFPolicyForUrl } from '../_generated/leaf/src/infra/net/ssrf.js';
import { assertBrowserNavigationAllowed } from '../_generated/extension/src/browser/navigation-guard.js';
import { gotoPageWithNavigationGuard } from '../_generated/extension/src/browser/pw-session.js';
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

/**
 * Persistent navigation guard (LOCAL PATCH, via sync.mjs): a page whose URL
 * sits on an exact-origin allowlist entry (the sandboxed local HTML preview
 * origin) keeps its route guard alive after the initial goto, so
 * page-initiated navigations to other origins / loopback services stay
 * blocked for the page's whole lifetime. Other pages keep the upstream
 * short-lived guard (removed right after goto).
 */
describe('persistent navigation guard (preview origin)', () => {
  function fakePage() {
    const unrouteCalls: Array<{ pattern: string; handler: unknown }> = [];
    const page = {
      route: async () => {},
      unroute: async (pattern: string, handler: unknown) => {
        unrouteCalls.push({ pattern, handler });
      },
      goto: async () => null,
      addInitScript: async () => {},
    };
    return {
      unrouteCalls,
      patterns: () => unrouteCalls.map((c) => c.pattern),
      page: page as unknown as Parameters<typeof gotoPageWithNavigationGuard>[0]['page'],
    };
  }

  it('keeps the route guard alive for a preview-origin page', async () => {
    const { unrouteCalls, page } = fakePage();
    await gotoPageWithNavigationGuard({
      cdpUrl: 'ws://127.0.0.1:1/devtools/browser/0',
      page,
      url: `${PREVIEW_ORIGIN}/preview/<token>/index.html`,
      timeoutMs: 1000,
      ssrfPolicy: POLICY,
    });
    expect(unrouteCalls).toEqual([]); // guard must NOT be removed
  });

  it('still removes the guard for non-preview pages (upstream behavior)', async () => {
    const { patterns, page } = fakePage();
    await gotoPageWithNavigationGuard({
      cdpUrl: 'ws://127.0.0.1:1/devtools/browser/0',
      page,
      url: 'https://example.com/',
      timeoutMs: 1000,
      ssrfPolicy: POLICY,
    });
    expect(patterns()).toEqual(['**']); // guard removed after goto
  });

  it('a later navigation takes over a previously kept preview guard (no stale guard)', async () => {
    const { unrouteCalls, patterns, page } = fakePage();
    // 1) preview navigation keeps its persistent guard
    await gotoPageWithNavigationGuard({
      cdpUrl: 'ws://127.0.0.1:1/devtools/browser/0',
      page,
      url: `${PREVIEW_ORIGIN}/preview/<token>/index.html`,
      timeoutMs: 1000,
      ssrfPolicy: POLICY,
    });
    expect(unrouteCalls).toEqual([]);
    // 2) a later NORMAL navigation on the same page must unroute the stale
    // preview guard first (playwright's route.continue() does not fall back
    // to older matching handlers), then remove its own guard
    await gotoPageWithNavigationGuard({
      cdpUrl: 'ws://127.0.0.1:1/devtools/browser/0',
      page,
      url: 'https://example.com/',
      timeoutMs: 1000,
      ssrfPolicy: POLICY,
    });
    expect(patterns()).toEqual(['**', '**']);
    expect(unrouteCalls[0].handler).not.toBe(unrouteCalls[1].handler);
  });
});
