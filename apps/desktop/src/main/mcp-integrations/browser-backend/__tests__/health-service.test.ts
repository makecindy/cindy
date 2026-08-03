import { describe, expect, it, vi } from 'vitest';
import type { BrowserControlRequest, BrowserControlResult } from '@cindy/browser-control-runtime';

import { BrowserBackendHealthService } from '../health-service.js';

function controller() {
  return {
    getCurrentBackendKind: vi.fn(
      (): 'external' | 'rsb-webview' => 'rsb-webview',
    ),
    call: vi.fn(
      async (request: BrowserControlRequest): Promise<BrowserControlResult> => ({
        ok: true,
        action: request.action,
        status: 200,
        data: { ready: true },
      }),
    ),
    restartEmbedded: vi.fn(async () => true),
    probeActiveControl: vi.fn(async () => undefined),
  };
}

const logger = () => ({ warn: vi.fn() });

describe('BrowserBackendHealthService', () => {
  it('automatically rebuilds a failed generation and verifies the real bridge', async () => {
    const ctl = controller();
    ctl.probeActiveControl
      .mockRejectedValueOnce(new Error('host renderer not available'))
      .mockResolvedValueOnce(undefined);
    const service = new BrowserBackendHealthService(ctl, logger());

    await expect(service.getHealth()).resolves.toEqual({
      active: 'rsb-webview',
      status: 'ready',
      canRecover: true,
    });

    expect(ctl.restartEmbedded).toHaveBeenCalledOnce();
    expect(ctl.call).toHaveBeenCalledWith({ action: 'start' });
    expect(ctl.probeActiveControl).toHaveBeenCalledTimes(2);
    expect(ctl.probeActiveControl).toHaveBeenNthCalledWith(1, { ensureHost: false });
    expect(ctl.probeActiveControl).toHaveBeenNthCalledWith(2, { ensureHost: false });
  });

  it('does not report recovery success when the replacement bridge is unreachable', async () => {
    const ctl = controller();
    ctl.probeActiveControl.mockRejectedValue(new Error('host renderer not available'));
    const service = new BrowserBackendHealthService(ctl, logger());

    await expect(service.recover()).resolves.toEqual({
      ok: false,
      health: {
        active: 'rsb-webview',
        status: 'error',
        canRecover: true,
        reason: 'host-unavailable',
      },
    });
    expect(ctl.probeActiveControl).toHaveBeenCalledWith({ ensureHost: true });
  });

  it('keeps concurrent recovery requests single-flight', async () => {
    const ctl = controller();
    let finishRestart: ((value: boolean) => void) | undefined;
    ctl.restartEmbedded.mockImplementationOnce(
      () => new Promise<boolean>((resolve) => {
        finishRestart = resolve;
      }),
    );
    const service = new BrowserBackendHealthService(ctl, logger());

    const first = service.recover();
    const second = service.recover();
    expect(second).toBe(first);
    expect(ctl.restartEmbedded).toHaveBeenCalledOnce();

    finishRestart?.(true);
    await expect(first).resolves.toMatchObject({ ok: true });
    expect(ctl.restartEmbedded).toHaveBeenCalledOnce();
  });

  it('upgrades a concurrent explicit recovery to strict host verification', async () => {
    const ctl = controller();
    let finishRestart: ((value: boolean) => void) | undefined;
    ctl.restartEmbedded.mockImplementationOnce(
      () => new Promise<boolean>((resolve) => {
        finishRestart = resolve;
      }),
    );
    ctl.probeActiveControl
      .mockRejectedValueOnce(new Error('host renderer not available'))
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('sidebar window ready timeout'));
    const service = new BrowserBackendHealthService(ctl, logger());

    const passive = service.getHealth();
    await vi.waitFor(() => expect(ctl.restartEmbedded).toHaveBeenCalledOnce());
    const explicit = service.recover();
    finishRestart?.(true);

    await expect(passive).resolves.toMatchObject({ status: 'ready' });
    await expect(explicit).resolves.toMatchObject({
      ok: false,
      health: { status: 'error', reason: 'host-unavailable' },
    });
    expect(ctl.restartEmbedded).toHaveBeenCalledOnce();
    expect(ctl.probeActiveControl).toHaveBeenNthCalledWith(1, { ensureHost: false });
    expect(ctl.probeActiveControl).toHaveBeenNthCalledWith(2, { ensureHost: false });
    expect(ctl.probeActiveControl).toHaveBeenNthCalledWith(3, { ensureHost: true });
  });

  it('preserves a concurrent switch to a ready external backend during strict verification', async () => {
    const ctl = controller();
    let finishRestart: ((value: boolean) => void) | undefined;
    ctl.restartEmbedded.mockImplementationOnce(
      () => new Promise<boolean>((resolve) => {
        finishRestart = resolve;
      }),
    );
    ctl.probeActiveControl
      .mockRejectedValueOnce(new Error('host renderer not available'))
      .mockImplementationOnce(async () => {
        ctl.getCurrentBackendKind.mockReturnValue('external');
      });
    const service = new BrowserBackendHealthService(ctl, logger());

    const passive = service.getHealth();
    await vi.waitFor(() => expect(ctl.restartEmbedded).toHaveBeenCalledOnce());
    const explicit = service.recover();
    finishRestart?.(true);

    await expect(passive).resolves.toMatchObject({
      active: 'rsb-webview',
      status: 'ready',
    });
    await expect(explicit).resolves.toEqual({
      ok: false,
      health: {
        active: 'external',
        status: 'ready',
        canRecover: false,
      },
    });
    expect(ctl.restartEmbedded).toHaveBeenCalledOnce();
    expect(ctl.probeActiveControl).toHaveBeenCalledTimes(2);
  });

  it('returns a fixed start failure reason without exposing raw runtime text', async () => {
    const ctl = controller();
    ctl.call.mockResolvedValueOnce({
      ok: false,
      action: 'start',
      errorCode: 'BROWSER_RUNTIME_UNAVAILABLE',
      message: 'secret low-level path',
    });
    const service = new BrowserBackendHealthService(ctl, logger());

    const result = await service.recover();
    expect(result).toEqual({
      ok: false,
      health: {
        active: 'rsb-webview',
        status: 'error',
        canRecover: true,
        reason: 'start-failed',
        errorCode: 'BROWSER_RUNTIME_UNAVAILABLE',
      },
    });
    expect(result.health).not.toHaveProperty('message');
  });

  it('classifies a replacement restart as disposing instead of a generic status failure', async () => {
    const ctl = controller();
    ctl.call
      .mockResolvedValueOnce({
        ok: true,
        action: 'start',
        status: 200,
        data: { ready: true },
      })
      .mockResolvedValueOnce({
        ok: false,
        action: 'status',
        errorCode: 'BROWSER_RUNTIME_UNAVAILABLE',
        message: 'embedded browser control is restarting; retry shortly',
      });
    const service = new BrowserBackendHealthService(ctl, logger());

    await expect(service.recover()).resolves.toEqual({
      ok: false,
      health: {
        active: 'rsb-webview',
        status: 'error',
        canRecover: true,
        reason: 'disposing',
        errorCode: 'BROWSER_RUNTIME_UNAVAILABLE',
      },
    });
  });

  it('does not claim embedded recovery when a queued setting switch wins the race', async () => {
    const ctl = controller();
    ctl.getCurrentBackendKind.mockReturnValue('external');
    const service = new BrowserBackendHealthService(ctl, logger());

    await expect(service.recover()).resolves.toEqual({
      ok: false,
      health: {
        active: 'external',
        status: 'ready',
        canRecover: false,
      },
    });
    expect(ctl.call).not.toHaveBeenCalled();
  });
});
