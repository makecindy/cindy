import { describe, expect, it } from 'vitest';

import { createBrowserControlRuntime, planDispatch } from '../runtime.js';
import { createUnavailableBrowserRuntime } from '../unavailable.js';

describe('createUnavailableBrowserRuntime', () => {
  it('reports BROWSER_RUNTIME_NOT_CONFIGURED for any action', async () => {
    const rt = createUnavailableBrowserRuntime();
    const res = await rt.call({ action: 'status' });
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('BROWSER_RUNTIME_NOT_CONFIGURED');
  });
});

describe('createBrowserControlRuntime — request planning + dispatch', () => {
  it('rejects an unknown action with INVALID_REQUEST', async () => {
    const rt = createBrowserControlRuntime();
    // Force an invalid action through the type boundary.
    const res = await rt.call({ action: 'bogus' as never });
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('BROWSER_RUNTIME_INVALID_REQUEST');
  });

  it('forwards snapshot maxChars + timeoutMs into the /snapshot query (not silently dropped)', () => {
    const plan = planDispatch({ action: 'snapshot', targetId: 't1', maxChars: 500, timeoutMs: 9000 });
    expect(plan.path).toBe('/snapshot');
    // The vendored route reads query.maxChars / query.timeoutMs; they must be
    // present or a large/slow page ignores the caller's bounds (maxChars falls
    // through to outer truncation; timeoutMs falls back to the default).
    expect(plan.query).toMatchObject({ targetId: 't1', maxChars: 500, timeoutMs: 9000 });
  });

  it('accepts proxyServer only for start and does not forward it to the vendored route', () => {
    expect(planDispatch({ action: 'start', proxyServer: 'http://proxy.test:8080' })).toEqual({
      method: 'POST',
      path: '/start',
      body: {},
    });
    expect(() => planDispatch({ action: 'status', proxyServer: 'http://proxy.test:8080' }))
      .toThrow(/only valid for action=start/);
  });

  it('rejects a credentialed proxyServer at the planning layer', () => {
    // Authenticated proxies are unsupported; the rejection must happen before
    // any dispatch is planned, not deeper in the launch path.
    expect(() => planDispatch({ action: 'start', proxyServer: 'http://u:p@proxy.test:8080' }))
      .toThrow(/authenticated proxies are not supported/);
  });

  it('validates and does not forward proxy navigation policy', () => {
    expect(planDispatch({
      action: 'start',
      proxyServer: 'http://proxy.test:8080',
      proxyAllowedHostnames: ['*.example.com'],
    })).toEqual({
      method: 'POST',
      path: '/start',
      body: {},
    });
    expect(() => planDispatch({
      action: 'status',
      proxyAllowedHostnames: ['*.example.com'],
    })).toThrow(/only valid for action=start/);
  });

  it('forwards act timeoutMs into the /act body (top-level, or nested wins)', () => {
    // The /act normalizer reads body.timeoutMs; a raw act call carries it at the
    // top level and must not be dropped.
    const top = planDispatch({ action: 'act', timeoutMs: 7000, request: { kind: 'click', selector: '.x' } });
    expect(top.path).toBe('/act');
    expect(top.body).toMatchObject({ timeoutMs: 7000 });
    // an explicit nested timeoutMs (e.g. from extract) takes precedence.
    const nested = planDispatch({ action: 'act', timeoutMs: 7000, request: { kind: 'evaluate', fn: 'x', timeoutMs: 3000 } });
    expect((nested.body as { timeoutMs?: number }).timeoutMs).toBe(3000);
  });

  it('drives the dispatcher for a real action and returns a structured result', async () => {
    // No browser is launched here; we assert the control plane wires through
    // (status hits the in-process route dispatcher and returns a structured
    // result rather than throwing). Either ok with data, or a structured error
    // — never an exception escaping the contract.
    const rt = createBrowserControlRuntime({
      config: { browser: { enabled: true } },
    });
    const res = await rt.call({ action: 'status' });
    expect(res.action).toBe('status');
    expect(typeof res.ok).toBe('boolean');
    // Result must be structured (no thrown error escaped the contract).
    expect(res).toHaveProperty('ok');
  });
});
