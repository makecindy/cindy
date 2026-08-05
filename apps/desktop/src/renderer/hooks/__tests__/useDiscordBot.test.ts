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

function installDiscordApi(status: DiscordBotTransportStatus = { kind: 'idle' }) {
  const listeners = new Set<(update: { status: DiscordBotTransportStatus }) => void>();
  const api = {
    getStatus: vi.fn(async () => ({ status, ownerUserId: '12345678901234567' })),
    setConfig: vi.fn(async (payload: { token: string; ownerUserId: string }) => ({
      status: { kind: 'connecting' } as DiscordBotTransportStatus,
      saveErrorStatus: undefined as DiscordBotTransportStatus | undefined,
      ownerUserId: payload.ownerUserId,
      payload,
    })),
    disconnect: vi.fn(async () => ({ status: { kind: 'idle' } as DiscordBotTransportStatus })),
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
});
