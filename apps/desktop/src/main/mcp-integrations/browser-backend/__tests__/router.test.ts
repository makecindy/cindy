// Router contract:
//  - `.call` delegates to the currently-installed backend
//  - `setBackend` disposes the OUTGOING backend (not the incoming)
//  - same-instance swap is a no-op (idempotent)
//  - outgoing-dispose failures are logged and swallowed (swap always succeeds)
//  - `dispose` cleans up the active backend

import { describe, expect, it, vi } from 'vitest';

import type { BrowserControlRequest, BrowserControlResult } from '@cindy/browser-control-runtime';

import { BackendRouter } from '../router.js';
import type { BackendKind, BrowserBackend } from '../types.js';

function fakeLogger() {
  return { info: vi.fn(), warn: vi.fn() };
}

function fakeBackend(kind: BackendKind, opts?: { disposeImpl?: () => Promise<void> }): BrowserBackend & {
  call: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
} {
  const call = vi.fn(
    async (_req: BrowserControlRequest): Promise<BrowserControlResult> => ({
      ok: true,
      action: 'status',
      data: { kind },
    }),
  );
  const dispose = vi.fn(opts?.disposeImpl ?? (async () => undefined));
  return { kind, call, dispose };
}

describe('BackendRouter', () => {
  it('delegates call() to the current backend', async () => {
    const ext = fakeBackend('external');
    const router = new BackendRouter(ext, fakeLogger());

    const got = await router.call({ action: 'status' });

    expect(ext.call).toHaveBeenCalledTimes(1);
    expect(got).toMatchObject({ data: { kind: 'external' } });
  });

  it('reports the active backend kind', () => {
    const ext = fakeBackend('external');
    const router = new BackendRouter(ext, fakeLogger());

    expect(router.kind).toBe('external');
    expect(router.getCurrentBackendKind()).toBe('external');
  });

  it('swap disposes the OUTGOING backend, never the incoming', async () => {
    const ext = fakeBackend('external');
    const rsb = fakeBackend('rsb-webview');
    const router = new BackendRouter(ext, fakeLogger());

    await router.setBackend(rsb);

    expect(ext.dispose).toHaveBeenCalledTimes(1);
    expect(rsb.dispose).not.toHaveBeenCalled();
    expect(router.getCurrentBackendKind()).toBe('rsb-webview');
  });

  it('post-swap calls reach the new backend', async () => {
    const ext = fakeBackend('external');
    const rsb = fakeBackend('rsb-webview');
    const router = new BackendRouter(ext, fakeLogger());

    await router.setBackend(rsb);
    await router.call({ action: 'status' });

    expect(rsb.call).toHaveBeenCalledTimes(1);
    expect(ext.call).not.toHaveBeenCalled();
  });

  it('same-instance swap is a no-op (no dispose, no log)', async () => {
    const ext = fakeBackend('external');
    const logger = fakeLogger();
    const router = new BackendRouter(ext, logger);

    await router.setBackend(ext);

    expect(ext.dispose).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('swallows outgoing-dispose failures (swap still succeeds)', async () => {
    const ext = fakeBackend('external', {
      disposeImpl: async () => {
        throw new Error('dispose exploded');
      },
    });
    const rsb = fakeBackend('rsb-webview');
    const logger = fakeLogger();
    const router = new BackendRouter(ext, logger);

    await expect(router.setBackend(rsb)).resolves.toBeUndefined();

    expect(router.getCurrentBackendKind()).toBe('rsb-webview');
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('dispose() forwards to the current backend', async () => {
    const ext = fakeBackend('external');
    const router = new BackendRouter(ext, fakeLogger());

    await router.dispose();

    expect(ext.dispose).toHaveBeenCalledTimes(1);
  });

  it('dispose() swallows a contract-violating backend throw (quit path must not stall)', async () => {
    const ext = fakeBackend('external', {
      disposeImpl: async () => {
        throw new Error('backend dispose violated no-throw contract');
      },
    });
    const logger = fakeLogger();
    const router = new BackendRouter(ext, logger);

    await expect(router.dispose()).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('after swap, dispose() goes to the NEW backend (not the disposed old one)', async () => {
    const ext = fakeBackend('external');
    const rsb = fakeBackend('rsb-webview');
    const router = new BackendRouter(ext, fakeLogger());

    await router.setBackend(rsb);
    // ext already disposed by the swap; dispose() now should dispose rsb.
    await router.dispose();

    expect(ext.dispose).toHaveBeenCalledTimes(1);
    expect(rsb.dispose).toHaveBeenCalledTimes(1);
  });

  it('an in-flight call against the outgoing backend resolves against that backend even after swap', async () => {
    // The .call dispatches synchronously and reads `this.current` at call-time.
    // Once a call is in flight, swapping the router does not retarget it — its
    // promise resolves through the original (outgoing) backend's own promise.
    let resolveExt: (v: BrowserControlResult) => void = () => undefined;
    const extPending = new Promise<BrowserControlResult>((res) => {
      resolveExt = res;
    });
    const ext: BrowserBackend = {
      kind: 'external',
      call: vi.fn(async () => extPending),
      dispose: vi.fn(async () => undefined),
    };
    const rsb = fakeBackend('rsb-webview');
    const router = new BackendRouter(ext, fakeLogger());

    const inflight = router.call({ action: 'status' });
    await router.setBackend(rsb);
    resolveExt({ ok: true, action: 'status', data: { from: 'external' } });

    const got = await inflight;
    expect(got).toMatchObject({ data: { from: 'external' } });
    expect(rsb.call).not.toHaveBeenCalled();
  });
});
