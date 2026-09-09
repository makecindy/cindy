import { describe, expect, it, vi } from 'vitest';

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
    setKind: vi.fn(async (kind: 'external' | 'rsb-webview') => kind),
    setUseRealProfile: vi.fn(async (enabled: boolean) => enabled),
    reset: vi.fn(async () => 'external' as const),
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
    expect(() => handlers.getHealth(untrusted)).toThrow(/untrusted renderer/);
    expect(() => handlers.recover(untrusted)).toThrow(/untrusted renderer/);
    expect(() => handlers.probeSourceRead(untrusted)).toThrow(/untrusted renderer/);

    expect(deps.getState).not.toHaveBeenCalled();
    expect(deps.setKind).not.toHaveBeenCalled();
    expect(deps.setUseRealProfile).not.toHaveBeenCalled();
    expect(deps.reset).not.toHaveBeenCalled();
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
});
