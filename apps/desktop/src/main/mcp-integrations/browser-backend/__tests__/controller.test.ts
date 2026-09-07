import { describe, expect, it, vi } from 'vitest';

import type { BrowserControlRequest, BrowserControlResult } from '@cindy/browser-control-runtime';

import { BrowserBackendController } from '../controller.js';
import { createBrowserProfileLifecycleQueue } from '../../browser-real-profile/runtime-stop.js';
import type { BackendKind, BrowserBackend } from '../types.js';

function fakeLogger() {
  return { info: vi.fn(), warn: vi.fn() };
}

function fakeBackend(kind: BackendKind): BrowserBackend & {
  call: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
} {
  let disposed = false;
  const call = vi.fn(async (request: BrowserControlRequest): Promise<BrowserControlResult> =>
    disposed
      ? {
          ok: false,
          action: request.action,
          errorCode: 'BROWSER_RUNTIME_UNAVAILABLE',
          message: 'browser backend is disposing',
        }
      : { ok: true, action: request.action, status: 200, data: { kind } },
  );
  const dispose = vi.fn(async () => {
    disposed = true;
  });
  return { kind, call, dispose };
}

describe('BrowserBackendController', () => {
  it('serializes reset cleanup after outgoing profile disposal without deadlocking', async () => {
    const queue = createBrowserProfileLifecycleQueue();
    const external = fakeBackend('external');
    const events: string[] = [];
    let release!: () => void;
    const busy = queue.run(() => new Promise<void>((resolve) => { release = resolve; }));
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    external.dispose.mockImplementation(() => queue.run(async () => { events.push('dispose'); }));
    const controller = new BrowserBackendController({
      initialKind: 'external', externalBackend: external,
      createRsbBackend: () => fakeBackend('rsb-webview'), logger: fakeLogger(),
    });
    const change = controller.setKind('rsb-webview');
    await vi.waitFor(() => expect(external.dispose).toHaveBeenCalledOnce());
    const reset = controller.setKind('external', () => queue.run(async () => { events.push('reset'); }));
    release();
    await Promise.all([busy, change, reset]);
    expect(events).toEqual(['dispose', 'reset']);
    expect(controller.kind).toBe('external');
    await expect(controller.setKind('rsb-webview', async () => { throw new Error('cleanup failed'); }))
      .rejects.toThrow('cleanup failed');
    expect(controller.kind).toBe('external');
  });

  it('does not save a selection when its backend factory fails', async () => {
    const persistKind = vi.fn();
    const controller = new BrowserBackendController({
      initialKind: 'external', externalBackend: fakeBackend('external'),
      createRsbBackend: () => { throw new Error('factory failed'); }, persistKind, logger: fakeLogger(),
    });
    await expect(controller.setKind('rsb-webview')).rejects.toThrow('factory failed');
    expect(persistKind).not.toHaveBeenCalled();
    expect(controller.kind).toBe('external');
  });

  it('clears an override on reset without losing a later same-kind explicit choice', async () => {
    let override: BackendKind | undefined = 'external';
    const persistKind = vi.fn((kind: BackendKind) => { override = kind; });
    const clearOverride = vi.fn(() => { override = undefined; });
    const controller = new BrowserBackendController({
      initialKind: 'external', externalBackend: fakeBackend('external'),
      createRsbBackend: () => fakeBackend('rsb-webview'), persistKind, logger: fakeLogger(),
    });
    await controller.setKind('external', clearOverride);
    expect(override).toBeUndefined();
    expect(persistKind).not.toHaveBeenCalled();
    await Promise.all([
      controller.setKind('external', clearOverride),
      controller.setKind('external'),
    ]);
    expect(override).toBe('external');
    expect(persistKind).toHaveBeenCalledOnce();
  });

  it('keeps the active backend usable when saving fails, then retries the selection', async () => {
    const external = fakeBackend('external');
    const embedded = fakeBackend('rsb-webview');
    const createRsbBackend = vi.fn(() => embedded);
    const persistKind = vi.fn().mockImplementationOnce(() => { throw new Error('disk full'); });
    const controller = new BrowserBackendController({
      initialKind: 'external', externalBackend: external, createRsbBackend, persistKind, logger: fakeLogger(),
    });
    await expect(controller.setKind('rsb-webview')).rejects.toThrow('disk full');
    expect(controller.kind).toBe('external');
    expect(await controller.call({ action: 'status' })).toMatchObject({ data: { kind: 'external' } });
    expect(external.dispose).not.toHaveBeenCalled();
    await expect(controller.setKind('rsb-webview')).resolves.toBe(true);
    expect(persistKind.mock.calls).toEqual([['rsb-webview'], ['rsb-webview']]);
    expect(createRsbBackend).toHaveBeenCalledTimes(2);
    expect(external.dispose).toHaveBeenCalledOnce();
    expect(embedded.dispose).not.toHaveBeenCalled();
  });

  it('persists overlapping selections in the same order as activation', async () => {
    const external = fakeBackend('external');
    let release!: () => void;
    external.dispose.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    const persistKind = vi.fn();
    const controller = new BrowserBackendController({
      initialKind: 'external', externalBackend: external,
      createRsbBackend: () => fakeBackend('rsb-webview'), persistKind, logger: fakeLogger(),
    });
    const first = controller.setKind('rsb-webview');
    await vi.waitFor(() => expect(external.dispose).toHaveBeenCalledOnce());
    const second = controller.setKind('external');
    expect(persistKind.mock.calls).toEqual([['rsb-webview']]);
    release();
    await Promise.all([first, second]);
    expect(persistKind.mock.calls).toEqual([['rsb-webview'], ['external']]);
    expect(controller.kind).toBe('external');
  });

  it('creates a fresh embedded backend when switching away and back', async () => {
    const external = fakeBackend('external');
    const embedded: ReturnType<typeof fakeBackend>[] = [];
    const controller = new BrowserBackendController({
      initialKind: 'external',
      externalBackend: external,
      createRsbBackend: () => {
        const backend = fakeBackend('rsb-webview');
        embedded.push(backend);
        return backend;
      },
      logger: fakeLogger(),
    });

    await controller.setKind('rsb-webview');
    await controller.setKind('external');
    await controller.setKind('rsb-webview');
    const status = await controller.call({ action: 'status' });

    expect(embedded).toHaveLength(2);
    expect(embedded[0]?.dispose).toHaveBeenCalledOnce();
    expect(embedded[1]?.dispose).not.toHaveBeenCalled();
    expect(status).toMatchObject({ ok: true, data: { kind: 'rsb-webview' } });
  });

  it('recovery replaces a terminal embedded instance and reconnects calls', async () => {
    const embedded: ReturnType<typeof fakeBackend>[] = [];
    const controller = new BrowserBackendController({
      initialKind: 'rsb-webview',
      externalBackend: fakeBackend('external'),
      createRsbBackend: () => {
        const backend = fakeBackend('rsb-webview');
        embedded.push(backend);
        return backend;
      },
      logger: fakeLogger(),
    });

    await expect(controller.restartEmbedded()).resolves.toBe(true);
    const status = await controller.call({ action: 'status' });

    expect(embedded).toHaveLength(2);
    expect(embedded[0]?.dispose).toHaveBeenCalledOnce();
    expect(status.ok).toBe(true);
    expect(embedded[1]?.call).toHaveBeenCalledWith({ action: 'status' });
  });

  it('does not reinterpret recovery as an external-browser restart', async () => {
    const external = fakeBackend('external');
    const controller = new BrowserBackendController({
      initialKind: 'external',
      externalBackend: external,
      createRsbBackend: () => fakeBackend('rsb-webview'),
      logger: fakeLogger(),
    });

    await expect(controller.restartEmbedded()).resolves.toBe(false);
    expect(external.dispose).not.toHaveBeenCalled();
  });

  it('routes a health handshake to the active replacement generation', async () => {
    const first = fakeBackend('rsb-webview');
    const second = fakeBackend('rsb-webview');
    first.probeControl = vi.fn(async () => undefined);
    second.probeControl = vi.fn(async () => undefined);
    const embedded = [first, second];
    const controller = new BrowserBackendController({
      initialKind: 'rsb-webview',
      externalBackend: fakeBackend('external'),
      createRsbBackend: () => embedded.shift()!,
      logger: fakeLogger(),
    });

    await controller.restartEmbedded();
    await controller.probeActiveControl();

    expect(first.probeControl).not.toHaveBeenCalled();
    expect(second.probeControl).toHaveBeenCalledOnce();
  });
});
