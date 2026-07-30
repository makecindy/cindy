// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { __testing, useWechatBot } from '../useWechatBot';

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

function installWechatApi(initial: WechatBotState = disconnectedState()) {
  const listeners = new Set<(state: WechatBotState) => void>();
  const channelState: WechatChannelSettingsState = {
    version: 1,
    workingDir: null,
    workingDirAvailable: true,
  };
  const api = {
    getState: vi.fn(async () => initial),
    authorize: vi.fn(async () => ({ started: true as const })),
    cancelAuthorization: vi.fn(async () => ({ ok: true as const })),
    unbind: vi.fn(async () => ({ ok: true as const })),
    getChannelSettings: vi.fn(async () => channelState),
    chooseWorkingDirectory: vi.fn(async () => ({
      canceled: false,
      state: { ...channelState, workingDir: 'D:/project' },
    })),
    resetWorkingDirectory: vi.fn(async () => channelState),
    onStateChange: vi.fn((callback: (state: WechatBotState) => void) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    }),
  };
  (
    window as unknown as {
      electronAPI: { wechatBot: typeof api };
    }
  ).electronAPI = { wechatBot: api };
  return {
    api,
    push(state: WechatBotState) {
      for (const listener of listeners) listener(state);
    },
  };
}

describe('useWechatBot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __testing.resetCache();
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });

  it('subscribes before loading and does not overwrite a newer pushed state', async () => {
    let resolveInitial!: (state: WechatBotState) => void;
    const harness = installWechatApi();
    harness.api.getState.mockReturnValueOnce(
      new Promise<WechatBotState>((resolve) => {
        resolveInitial = resolve;
      }),
    );
    const { result } = renderHook(() => useWechatBot());

    const connected: WechatBotState = {
      phase: 'connected',
      bound: true,
      queuedTasks: 2,
    };
    act(() => harness.push(connected));
    resolveInitial(disconnectedState());

    await waitFor(() => expect(result.current.state).toEqual(connected));
  });

  it('ignores the initial load after unmounting', async () => {
    let resolveState!: (state: WechatBotState) => void;
    let resolveChannelSettings!: (state: WechatChannelSettingsState) => void;
    const harness = installWechatApi();
    harness.api.getState.mockReturnValueOnce(
      new Promise<WechatBotState>((resolve) => {
        resolveState = resolve;
      }),
    );
    harness.api.getChannelSettings.mockReturnValueOnce(
      new Promise<WechatChannelSettingsState>((resolve) => {
        resolveChannelSettings = resolve;
      }),
    );
    const { unmount } = renderHook(() => useWechatBot());

    unmount();
    await act(async () => {
      resolveState({
        phase: 'connected',
        bound: true,
        queuedTasks: 1,
      });
      resolveChannelSettings({
        version: 1,
        workingDir: 'D:/late-result',
        workingDirAvailable: true,
      });
      await Promise.resolve();
    });

    expect(__testing.getCache()).toEqual({
      state: null,
      channelSettings: null,
    });
  });

  it('starts and cancels authorization through the credential-free bridge', async () => {
    const { api } = installWechatApi();
    const { result } = renderHook(() => useWechatBot());
    await waitFor(() => expect(api.getState).toHaveBeenCalled());

    await act(async () => {
      expect(await result.current.authorize()).toBe(true);
      await result.current.cancelAuthorization();
    });

    expect(api.authorize).toHaveBeenCalledTimes(1);
    expect(api.cancelAuthorization).toHaveBeenCalledTimes(1);
  });

  it('updates and resets the user-picked working directory', async () => {
    const { api } = installWechatApi();
    const { result } = renderHook(() => useWechatBot());
    await waitFor(() => expect(result.current.channelSettings).not.toBeNull());

    await act(async () => {
      await result.current.chooseWorkingDirectory();
    });
    expect(result.current.channelSettings?.workingDir).toBe('D:/project');

    await act(async () => {
      await result.current.resetWorkingDirectory();
    });
    expect(result.current.channelSettings?.workingDir).toBeNull();
    expect(api.resetWorkingDirectory).toHaveBeenCalledTimes(1);
  });
});

function disconnectedState(): WechatBotState {
  return {
    phase: 'disconnected',
    bound: false,
    queuedTasks: 0,
  };
}
