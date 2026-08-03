import { describe, expect, it, vi } from 'vitest';

import type { BrowserControlRequest, BrowserControlResult } from '@cindy/browser-control-runtime';

import { BrowserBackendController } from '../controller.js';
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
