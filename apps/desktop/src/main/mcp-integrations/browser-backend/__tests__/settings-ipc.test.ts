import { describe, expect, it, vi } from 'vitest';

import { extractIpcError } from '../../../../shared/ipcError.js';
import { RealProfileError } from '../../browser-real-profile/types.js';
import { createBrowserBackendIpcHandlers } from '../settings-ipc.js';

function buildHandlers() {
  const trustedEvent = { sender: 'trusted' };
  const deps = {
    assertTrusted: vi.fn((event: typeof trustedEvent) => {
      if (event !== trustedEvent) throw new Error('untrusted renderer');
    }),
    getState: vi.fn(() => ({
      active: 'rsb-webview' as const,
      systemDefault: 'external' as const,
      isOverride: true,
      useRealProfile: false,
    })),
    setKind: vi.fn(async (kind: 'external' | 'rsb-webview' | 'user-browser') => kind),
    setUseRealProfile: vi.fn(async (enabled: boolean) => enabled),
    reset: vi.fn(async () => 'external' as const),
    pickCustomBrowser: vi.fn(async (_event: typeof trustedEvent): Promise<string | null> => null),
    setCustomBrowser: vi.fn(async (_path: string, assertCurrent: () => void) => assertCurrent()),
    resetCustomBrowser: vi.fn(async (assertCurrent: () => void) => assertCurrent()),
    getHealth: vi.fn(async () => ({
      active: 'rsb-webview' as const,
      status: 'ready' as const,
      canRecover: true,
    })),
    recover: vi.fn(async () => ({
      ok: true,
      health: {
        active: 'rsb-webview' as const,
        status: 'ready' as const,
        canRecover: true,
      },
    })),
    probeSourceRead: vi.fn(() => ({ readable: true })),
    openExtensionStore: vi.fn(async () => ({ ok: true as const })),
  };
  return {
    trustedEvent,
    deps,
    handlers: createBrowserBackendIpcHandlers(deps),
  };
}

describe('browser backend Settings IPC handlers', () => {
  it('rejects an untrusted sender before every dependency is reached', async () => {
    const { deps, handlers } = buildHandlers();
    const untrusted = { sender: 'untrusted' };

    expect(() => handlers.getState(untrusted)).toThrow(/untrusted renderer/);
    await expect(handlers.setKind(untrusted, { kind: 'external' })).rejects.toThrow(
      /untrusted renderer/,
    );
    await expect(handlers.setUseRealProfile(untrusted, { enabled: true })).rejects.toThrow(
      /untrusted renderer/,
    );
    await expect(handlers.reset(untrusted)).rejects.toThrow(/untrusted renderer/);
    await expect(handlers.pickCustomBrowser(untrusted)).rejects.toThrow(/untrusted renderer/);
    await expect(handlers.resetCustomBrowser(untrusted)).rejects.toThrow(/untrusted renderer/);
    expect(() => handlers.getHealth(untrusted)).toThrow(/untrusted renderer/);
    expect(() => handlers.recover(untrusted)).toThrow(/untrusted renderer/);
    expect(() => handlers.probeSourceRead(untrusted)).toThrow(/untrusted renderer/);

    expect(deps.getState).not.toHaveBeenCalled();
    expect(deps.setKind).not.toHaveBeenCalled();
    expect(deps.setUseRealProfile).not.toHaveBeenCalled();
    expect(deps.reset).not.toHaveBeenCalled();
    expect(deps.pickCustomBrowser).not.toHaveBeenCalled();
    expect(deps.resetCustomBrowser).not.toHaveBeenCalled();
    expect(deps.getHealth).not.toHaveBeenCalled();
    expect(deps.recover).not.toHaveBeenCalled();
    expect(deps.probeSourceRead).not.toHaveBeenCalled();
  });

  it('validates set-kind and returns stable response contracts', async () => {
    const { trustedEvent, deps, handlers } = buildHandlers();

    expect(handlers.getState(trustedEvent)).toEqual({
      active: 'rsb-webview',
      systemDefault: 'external',
      isOverride: true,
      useRealProfile: false,
    });
    await expect(handlers.setKind(trustedEvent, { kind: 'external' })).resolves.toEqual({
      ok: true,
      active: 'external',
    });
    await expect(handlers.reset(trustedEvent)).resolves.toEqual({
      ok: true,
      active: 'external',
    });
    await expect(handlers.getHealth(trustedEvent)).resolves.toMatchObject({ status: 'ready' });
    await expect(handlers.recover(trustedEvent)).resolves.toMatchObject({ ok: true });
    expect(deps.setKind).toHaveBeenCalledWith('external');
    await expect(handlers.setUseRealProfile(trustedEvent, { enabled: true })).resolves.toEqual({
      ok: true,
      enabled: true,
    });
    expect(deps.setUseRealProfile).toHaveBeenCalledWith(true);
    expect(handlers.probeSourceRead(trustedEvent)).toEqual({ readable: true });
    expect(deps.probeSourceRead).toHaveBeenCalledTimes(1);

    await expect(handlers.setKind(trustedEvent, { kind: 'unknown' })).rejects.toThrow();
  });

  // #8899 / Electron IPC §5. An approved app must come from the native result,
  // not a payload or a renderer which lost trust while the picker was open.
  // Unit: production handlers with deferred dialog output; no native process.
  it('rejects caller-supplied program and arguments even from trusted settings', async () => {
    const { handlers, trustedEvent, deps } = buildHandlers();
    const payload = { executablePath: 'supplied-by-renderer', args: ['--user-data-dir=other'] };
    await expect(handlers.pickCustomBrowser(trustedEvent, payload)).rejects.toThrow(/INVALID_ARGUMENT/);
    await expect(handlers.resetCustomBrowser(trustedEvent, payload)).rejects.toThrow(/INVALID_ARGUMENT/);
    expect(deps.pickCustomBrowser).not.toHaveBeenCalled();
    expect(deps.setCustomBrowser).not.toHaveBeenCalled();
    expect(deps.resetCustomBrowser).not.toHaveBeenCalled();
  });

  it('does not change the selection on cancel or after the requesting frame loses trust', async () => {
    const { handlers, trustedEvent, deps } = buildHandlers();
    await expect(handlers.pickCustomBrowser(trustedEvent)).resolves.toEqual({ canceled: true });
    const { promise, resolve } = Promise.withResolvers<string>();
    deps.pickCustomBrowser.mockReturnValueOnce(promise);
    const selection = handlers.pickCustomBrowser(trustedEvent);
    deps.assertTrusted.mockImplementation(() => { throw new Error('frame navigated'); });
    resolve('native-result');
    await expect(selection).rejects.toThrow(/frame navigated/);
    expect(deps.setCustomBrowser).not.toHaveBeenCalled();
  });

  // The login-copy switch failed with only a generic toast; a known cause such as another Cindy
  // holding the agent browser must reach Settings as its code so the toast can name it.
  it('keeps the code of a known login-copy failure for Settings', async () => {
    const { trustedEvent, deps, handlers } = buildHandlers();
    deps.setUseRealProfile.mockRejectedValueOnce(
      new RealProfileError('FOREIGN_AGENT_BROWSER', 'Another Cindy is using the agent browser port.'),
    );
    const err = await handlers.setUseRealProfile(trustedEvent, { enabled: true }).catch((e) => e);
    expect(extractIpcError(err)?.code).toBe('FOREIGN_AGENT_BROWSER');
  });
});
