import { afterEach, describe, expect, it } from 'vitest';

import { resolveSsrFPolicyForUrl } from '../_generated/leaf/src/infra/net/ssrf.js';
import { assertBrowserNavigationAllowed } from '../_generated/extension/src/browser/navigation-guard.js';
import { gotoPageWithNavigationGuard } from '../_generated/extension/src/browser/pw-session.js';
import { setBrowserRuntimeConfig } from '../shim/runtime-config-snapshot.js';
import type { LookupFn } from '../_generated/leaf/src/infra/net/ssrf.js';

afterEach(() => {
  setBrowserRuntimeConfig({}); // reset the host-settable config between tests
});

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
  function fakePage(gotoImpl?: () => Promise<unknown>) {
    const unrouteCalls: Array<{ pattern: string; handler: unknown }> = [];
    const routedHandlers: Array<(route: unknown, request: unknown) => Promise<void>> = [];
    const closeCalls: Array<unknown> = [];
    const swUnregisterCalls: Array<string> = [];
    const cdpSends: Array<{ method: string; params?: unknown }> = [];
    // mainFrame identity shared with fakeTopLevelRequest so the handler's
    // top-level detection (request.frame() === page.mainFrame()) matches.
    const mainFrame = {};
    const page = {
      mainFrame: () => mainFrame,
      route: async (_pattern: string, handler: (route: unknown, request: unknown) => Promise<void>) => {
        routedHandlers.push(handler);
      },
      unroute: async (pattern: string, handler: unknown) => {
        unrouteCalls.push({ pattern, handler });
      },
      goto: gotoImpl ?? (async () => null),
      close: async () => {
        closeCalls.push(true);
      },
      addInitScript: async () => {},
      context: () => ({
        newCDPSession: async () => ({
          send: async (method: string, params?: unknown) => {
            cdpSends.push({ method, params });
            if (method === 'ServiceWorker.unregister') {
              swUnregisterCalls.push((params as { scopeURL: string }).scopeURL);
            }
            return {};
          },
          detach: async () => {},
        }),
      }),
    };
    return {
      unrouteCalls,
      patterns: () => unrouteCalls.map((c) => c.pattern),
      routedHandlers,
      closeCalls,
      swUnregisterCalls,
      cdpSends,
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

  function fakeTopLevelRequest(url: string, mainFrame: unknown) {
    // isTopLevelNavigationRequest needs request.frame() === page.mainFrame()
    // and request.isNavigationRequest() to classify a top-level document
    // navigation; without them the handler treats the request as a
    // non-top-level subresource and continues it (not what we assert).
    // `mainFrame` must be the SAME object the fake page reports. Playwright
    // Request exposes url()/frame()/isNavigationRequest() as METHODS.
    return {
      url: () => url,
      frame: () => mainFrame,
      isNavigationRequest: () => true,
      resourceType: () => 'document',
    };
  }

  it('aborts a SAME-ORIGIN navigation after the host revokes the preview origin (round 26 live-config recheck)', async () => {
    // The guard captured `previewOrigin` at goto time, but the host may have
    // revoked the preview since (freed port, possibly seized by another local
    // process). The persistent guard must re-check the LIVE config on every
    // request: with the allowlist entry gone, even a same-origin navigation
    // must abort — never load the seizer's content.
    // Simulate the host flow: install the config BEFORE goto (the host calls
    // setBrowserRuntimeConfig when granting the preview origin).
    setBrowserRuntimeConfig({ browser: { ssrfPolicy: { allowedOrigins: [PREVIEW_ORIGIN] } } });
    const { page, routedHandlers } = fakePage();
    await gotoPageWithNavigationGuard({
      cdpUrl: 'ws://127.0.0.1:1/devtools/browser/0',
      page,
      url: `${PREVIEW_ORIGIN}/preview/<token>/index.html`,
      timeoutMs: 1000,
      ssrfPolicy: POLICY,
    });
    expect(routedHandlers.length).toBe(1);
    const handler = routedHandlers[0];

    // With the origin still authorized, a same-origin navigation continues.
    const aborted1: Array<unknown> = [];
    await handler(
      { abort: async () => aborted1.push('abort'), continue: async () => aborted1.push('continue') },
      fakeTopLevelRequest(`${PREVIEW_ORIGIN}/preview/<token>/other.html`, page.mainFrame()),
    );
    expect(aborted1).toEqual(['continue']);

    // Revoke: the host config no longer lists the origin → abort even though
    // the URL is same-origin with the goto-time preview origin.
    setBrowserRuntimeConfig({ browser: { ssrfPolicy: { allowedOrigins: [] } } });
    const aborted2: Array<unknown> = [];
    await handler(
      { abort: async () => aborted2.push('abort'), continue: async () => aborted2.push('continue') },
      fakeTopLevelRequest(`${PREVIEW_ORIGIN}/preview/<token>/other.html`, page.mainFrame()),
    );
    expect(aborted2).toEqual(['abort']);
  });

  it('aborts a cross-origin navigation after revocation (round 26)', async () => {
    setBrowserRuntimeConfig({ browser: { ssrfPolicy: { allowedOrigins: [PREVIEW_ORIGIN] } } });
    const { page, routedHandlers } = fakePage();
    await gotoPageWithNavigationGuard({
      cdpUrl: 'ws://127.0.0.1:1/devtools/browser/0',
      page,
      url: `${PREVIEW_ORIGIN}/preview/<token>/index.html`,
      timeoutMs: 1000,
      ssrfPolicy: POLICY,
    });
    const handler = routedHandlers[0];
    setBrowserRuntimeConfig({ browser: { ssrfPolicy: { allowedOrigins: [] } } });
    const aborted: Array<unknown> = [];
    await handler(
      { abort: async () => aborted.push('abort'), continue: async () => aborted.push('continue') },
      fakeTopLevelRequest('https://evil.example/exfil', page.mainFrame()),
    );
    expect(aborted).toEqual(['abort']);
  });

  it('fail-closed on malformed config: missing browser slice aborts (round 26)', async () => {
    setBrowserRuntimeConfig({ browser: { ssrfPolicy: { allowedOrigins: [PREVIEW_ORIGIN] } } });
    const { page, routedHandlers } = fakePage();
    await gotoPageWithNavigationGuard({
      cdpUrl: 'ws://127.0.0.1:1/devtools/browser/0',
      page,
      url: `${PREVIEW_ORIGIN}/preview/<token>/index.html`,
      timeoutMs: 1000,
      ssrfPolicy: POLICY,
    });
    const handler = routedHandlers[0];
    // Config replaced with something that has no browser slice — the live
    // allowlist is unreadable → fail-closed (abort).
    setBrowserRuntimeConfig({ gateway: {} } as never);
    const aborted: Array<unknown> = [];
    await handler(
      { abort: async () => aborted.push('abort'), continue: async () => aborted.push('continue') },
      fakeTopLevelRequest(`${PREVIEW_ORIGIN}/preview/<token>/other.html`, page.mainFrame()),
    );
    expect(aborted).toEqual(['abort']);
  });

  it('closes the page when goto fails on a PREVIEW target (Greptile P1, round 27)', async () => {
    // goto fails with a NON-policy error (slow-resource timeout etc.) after
    // the untrusted HTML may already be executing. The guard is removed and
    // the page MUST be closed — createPageViaPlaywright swallows non-policy
    // errors and would otherwise return the alive, guard-less tab.
    setBrowserRuntimeConfig({ browser: { ssrfPolicy: { allowedOrigins: [PREVIEW_ORIGIN] } } });
    const { unrouteCalls, closeCalls, page } = fakePage(async () => {
      throw new Error('Timeout 30000ms exceeded');
    });
    await expect(
      gotoPageWithNavigationGuard({
        cdpUrl: 'ws://127.0.0.1:1/devtools/browser/0',
        page,
        url: `${PREVIEW_ORIGIN}/preview/<token>/index.html`,
        timeoutMs: 1000,
        ssrfPolicy: POLICY,
      }),
    ).rejects.toThrow('Timeout');
    expect(unrouteCalls).toHaveLength(1); // stale guard removed (round 18)
    expect(closeCalls).toHaveLength(1); // no guard-less survivor (round 27)
  });

  it('keeps round-18 behavior when goto fails on a NON-preview target (no close)', async () => {
    // A normal page whose goto failed must not be closed — the user may
    // retry or inspect the error page. The finally-block cleanup (guard
    // installed for the goto attempt, removed for a non-preview page) still
    // runs, but the round-27 close must NOT: only preview-target failures
    // close the page (untrusted HTML may already be executing).
    const { unrouteCalls, closeCalls, page } = fakePage(async () => {
      throw new Error('Timeout 30000ms exceeded');
    });
    await expect(
      gotoPageWithNavigationGuard({
        cdpUrl: 'ws://127.0.0.1:1/devtools/browser/0',
        page,
        url: 'https://example.com/slow',
        timeoutMs: 1000,
        ssrfPolicy: POLICY,
      }),
    ).rejects.toThrow('Timeout');
    expect(unrouteCalls).toHaveLength(1); // finally cleanup, round 18 semantics
    expect(closeCalls).toHaveLength(0); // no round-27 close for non-preview
  });

  it('unregisters a stale scope=/ SW on the preview origin BEFORE goto (round 27)', async () => {
    // worker-src 'none' only blocks NEW registrations; a persistent profile
    // may hold a scope=/ SW from an earlier local service on the same
    // 127.0.0.1:<port>, which would intercept /preview/<token>/... before
    // the server responds and answer with a synthetic document carrying no
    // CSP (codex-connector P1, round 27). The CDP unregister must run for
    // the preview origin, before the navigation proceeds.
    const { swUnregisterCalls, cdpSends, page } = fakePage();
    await gotoPageWithNavigationGuard({
      cdpUrl: 'ws://127.0.0.1:1/devtools/browser/0',
      page,
      url: `${PREVIEW_ORIGIN}/preview/<token>/index.html`,
      timeoutMs: 1000,
      ssrfPolicy: POLICY,
    });
    expect(swUnregisterCalls).toEqual([`${PREVIEW_ORIGIN}/`]);
    const unregister = cdpSends.find((s) => s.method === 'ServiceWorker.unregister');
    expect(unregister?.params).toEqual({ scopeURL: `${PREVIEW_ORIGIN}/` });
  });

  it('does NOT unregister SW for non-preview targets (round 27)', async () => {
    const { swUnregisterCalls, page } = fakePage();
    await gotoPageWithNavigationGuard({
      cdpUrl: 'ws://127.0.0.1:1/devtools/browser/0',
      page,
      url: 'https://example.com/',
      timeoutMs: 1000,
      ssrfPolicy: POLICY,
    });
    expect(swUnregisterCalls).toHaveLength(0);
  });
});
