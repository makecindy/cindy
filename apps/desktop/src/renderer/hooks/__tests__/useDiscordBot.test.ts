// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useDiscordBot } from '../useDiscordBot';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, string>) =>
      vars?.message ? `${key}:${vars.message}` : key,
  }),
}));

vi.mock('@/lib/toast', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function installDiscordApi(
  status: DiscordBotTransportStatus = { kind: 'idle' },
  lifecycleAnnouncement = true,
  getStatusOverride?: () => Promise<{
    status: DiscordBotTransportStatus;
    ownerUserId: string | null;
    lifecycleAnnouncement: boolean;
  }>,
) {
  const listeners = new Set<(update: { status: DiscordBotTransportStatus }) => void>();
  const api = {
    getStatus: vi.fn(
      getStatusOverride ?? (async () => ({
        status,
        ownerUserId: '12345678901234567',
        lifecycleAnnouncement,
      })),
    ),
    setConfig: vi.fn(async (payload: { token: string; ownerUserId: string }) => ({
      status: { kind: 'connecting' } as DiscordBotTransportStatus,
      saveErrorStatus: undefined as DiscordBotTransportStatus | undefined,
      ownerUserId: payload.ownerUserId,
      payload,
    })),
    disconnect: vi.fn(async () => ({ status: { kind: 'idle' } as DiscordBotTransportStatus })),
    setLifecycleAnnouncement: vi.fn(async (enabled: boolean) => ({
      ok: true,
      lifecycleAnnouncement: enabled,
    })),
    onStatusChange: vi.fn((cb: (update: { status: DiscordBotTransportStatus }) => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    }),
  };
  (window as unknown as { electronAPI: { discordBot: typeof api } }).electronAPI = {
    discordBot: api,
  };
  return api;
}

describe('useDiscordBot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });

  it('validates owner user id before saving config', async () => {
    installDiscordApi();
    const { result } = renderHook(() => useDiscordBot());

    await waitFor(() => expect(result.current.ownerUserId).toBe('12345678901234567'));
    act(() => {
      result.current.setToken('bot-token');
      result.current.setOwnerUserId('abc');
    });

    await act(async () => {
      const ok = await result.current.connect();
      expect(ok).toBe(false);
    });

    expect(result.current.validationError).toBe('logic.validation.discordOwnerUserIdFormat');
  });

  it('sends token and owner user id to the discord config bridge', async () => {
    const api = installDiscordApi();
    const { result } = renderHook(() => useDiscordBot());

    await waitFor(() => expect(result.current.ownerUserId).toBe('12345678901234567'));
    act(() => {
      result.current.setToken(' bot-token ');
      result.current.setOwnerUserId('123456789012345678');
    });

    await act(async () => {
      const ok = await result.current.connect();
      expect(ok).toBe(true);
    });

    expect(api.setConfig).toHaveBeenCalledWith({
      token: 'bot-token',
      ownerUserId: '123456789012345678',
    });
  });

  it('keeps the restored runtime status when config save reports a save error', async () => {
    const api = installDiscordApi();
    api.setConfig.mockResolvedValueOnce({
      status: {
        kind: 'connected',
        appId: 'bot#0000',
      } as DiscordBotTransportStatus,
      saveErrorStatus: {
        kind: 'error',
        reason: 'Discord authentication failed: invalid bot token',
      } as DiscordBotTransportStatus,
      ownerUserId: '12345678901234567',
      payload: {
        token: 'bad-token',
        ownerUserId: '123456789012345678',
      },
    });
    const { result } = renderHook(() => useDiscordBot());

    await waitFor(() => expect(result.current.ownerUserId).toBe('12345678901234567'));
    act(() => {
      result.current.setToken('bad-token');
      result.current.setOwnerUserId('123456789012345678');
    });

    await act(async () => {
      const ok = await result.current.connect();
      expect(ok).toBe(false);
    });

    expect(result.current.ownerUserId).toBe('12345678901234567');
    expect(result.current.status.kind).toBe('connected');
  });

  it('disconnects and clears local fields', async () => {
    const api = installDiscordApi({ kind: 'connected', appId: 'MakerBot#1234' });
    const { result } = renderHook(() => useDiscordBot());

    await waitFor(() => expect(result.current.status.kind).toBe('connected'));
    act(() => {
      result.current.setToken('bot-token');
    });

    await act(async () => {
      await result.current.disconnect();
    });

    expect(api.disconnect).toHaveBeenCalledTimes(1);
    expect(result.current.token).toBe('');
    expect(result.current.ownerUserId).toBe('');
    expect(result.current.status.kind).toBe('idle');
  });

  it('loads and updates the lifecycle announcement preference', async () => {
    const api = installDiscordApi({ kind: 'connected', appId: 'MakerBot#1234' }, false);
    const { result } = renderHook(() => useDiscordBot());

    await waitFor(() => expect(result.current.lifecycleAnnouncement).toBe(false));

    act(() => {
      result.current.setLifecycleAnnouncement(true);
    });

    expect(result.current.lifecycleAnnouncement).toBe(true);
    expect(api.setLifecycleAnnouncement).toHaveBeenCalledWith(true);
  });

  it('preserves a newer lifecycle toggle in cache after an in-flight status read resolves', async () => {
    let resolveStatus!: (value: {
      status: DiscordBotTransportStatus;
      ownerUserId: string | null;
      lifecycleAnnouncement: boolean;
    }) => void;
    const statusPromise = new Promise<{
      status: DiscordBotTransportStatus;
      ownerUserId: string | null;
      lifecycleAnnouncement: boolean;
    }>((resolve) => {
      resolveStatus = resolve;
    });
    const api = installDiscordApi();
    const hydrated = renderHook(() => useDiscordBot());

    await waitFor(() => expect(hydrated.result.current.ownerUserId).toBe('12345678901234567'));
    hydrated.unmount();

    api.getStatus.mockReturnValueOnce(statusPromise);
    const current = renderHook(() => useDiscordBot());

    await waitFor(() => expect(api.getStatus).toHaveBeenCalledTimes(2));
    act(() => {
      current.result.current.setLifecycleAnnouncement(false);
    });

    await act(async () => {
      resolveStatus({
        status: { kind: 'connected', appId: 'MakerBot#1234' },
        ownerUserId: '12345678901234567',
        lifecycleAnnouncement: true,
      });
      await statusPromise;
      await Promise.resolve();
    });

    expect(current.result.current.lifecycleAnnouncement).toBe(false);
    expect(api.setLifecycleAnnouncement).toHaveBeenCalledWith(false);
    current.unmount();

    api.getStatus.mockImplementationOnce(() => new Promise(() => {}));
    const remounted = renderHook(() => useDiscordBot());
    expect(remounted.result.current.lifecycleAnnouncement).toBe(false);
  });

  it('preserves a newer lifecycle toggle in cache after an in-flight connect resolves', async () => {
    const api = installDiscordApi();
    const connectResult = deferred<{
      status: DiscordBotTransportStatus;
      saveErrorStatus: DiscordBotTransportStatus | undefined;
      ownerUserId: string;
      payload: { token: string; ownerUserId: string };
    }>();
    api.setConfig.mockReturnValueOnce(connectResult.promise);
    const current = renderHook(() => useDiscordBot());

    await waitFor(() => expect(current.result.current.ownerUserId).toBe('12345678901234567'));
    act(() => {
      current.result.current.setToken('bot-token');
    });

    let pendingConnect!: Promise<boolean>;
    act(() => {
      pendingConnect = current.result.current.connect();
    });
    await waitFor(() => expect(api.setConfig).toHaveBeenCalledTimes(1));

    act(() => {
      current.result.current.setLifecycleAnnouncement(false);
    });

    await act(async () => {
      connectResult.resolve({
        status: { kind: 'connected', appId: 'MakerBot#1234' },
        saveErrorStatus: undefined,
        ownerUserId: '12345678901234567',
        payload: { token: 'bot-token', ownerUserId: '12345678901234567' },
      });
      await pendingConnect;
    });

    current.unmount();
    api.getStatus.mockImplementationOnce(() => new Promise(() => {}));
    const remounted = renderHook(() => useDiscordBot());
    expect(remounted.result.current.lifecycleAnnouncement).toBe(false);
  });

  it('preserves a newer lifecycle toggle in cache after an in-flight disconnect resolves', async () => {
    const api = installDiscordApi({ kind: 'connected', appId: 'MakerBot#1234' });
    const disconnectResult = deferred<{ status: DiscordBotTransportStatus }>();
    api.disconnect.mockReturnValueOnce(disconnectResult.promise);
    const current = renderHook(() => useDiscordBot());

    await waitFor(() => expect(current.result.current.status.kind).toBe('connected'));

    let pendingDisconnect!: Promise<void>;
    act(() => {
      pendingDisconnect = current.result.current.disconnect();
    });
    await waitFor(() => expect(api.disconnect).toHaveBeenCalledTimes(1));

    act(() => {
      current.result.current.setLifecycleAnnouncement(false);
    });

    await act(async () => {
      disconnectResult.resolve({ status: { kind: 'idle' } });
      await pendingDisconnect;
    });

    current.unmount();
    api.getStatus.mockImplementationOnce(() => new Promise(() => {}));
    const remounted = renderHook(() => useDiscordBot());
    expect(remounted.result.current.lifecycleAnnouncement).toBe(false);
  });
});
