// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
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
    setCompanion: vi.fn(async (botId: string | null) => ({ ...channelState, companionBotId: botId })),
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
    setDataOwnerGeneration('owner-a');
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

  // #6492 r4318273410, unit: owner repair during the initial GET must finish
  // loading without remounting; unmount and a different owner must still drop it.
  it.each([
    'unmounted', 'same-owner-repair', 'different-owner',
  ])('handles the initial load after %s', async (boundary) => {
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
    const { result, unmount } = renderHook(() => useWechatBot());

    if (boundary === 'unmounted') unmount();
    else setDataOwnerGeneration(boundary === 'same-owner-repair' ? 'owner-a' : 'owner-b');
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

    if (boundary === 'same-owner-repair') {
      expect(result.current.state.phase).toBe('connected');
      expect(result.current.channelSettings?.workingDir).toBe('D:/late-result');
      expect(harness.api.getChannelSettings).toHaveBeenCalledTimes(1);
    } else {
      expect(__testing.getCache()).toEqual({ state: null, channelSettings: null });
    }
    unmount();
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

  // #6492 r4318178122, unit: cached A + delayed directory response + B opening
  // before its GET resolves must not expose A's binding or let A's action clear B.
  // Existing unmount coverage only fences initial GETs, not cached/mutation results.
  it('isolates cached settings and late mutations across account switches', async () => {
    const a = installWechatApi({ phase: 'connected', bound: true, queuedTasks: 0 });
    const settingsA = { version: 1 as const, workingDir: null, workingDirAvailable: true, companionBotId: 'bot-a' };
    a.api.getChannelSettings.mockResolvedValue(settingsA);
    const first = renderHook(() => useWechatBot());
    await waitFor(() => expect(first.result.current.channelSettings?.companionBotId).toBe('bot-a'));
    const staleUnlink = first.result.current.setCompanion;
    let finishDirectory!: (value: Awaited<ReturnType<typeof a.api.chooseWorkingDirectory>>) => void;
    a.api.chooseWorkingDirectory.mockReturnValueOnce(new Promise((resolve) => { finishDirectory = resolve; }));
    let pending!: Promise<void>;
    act(() => { pending = first.result.current.chooseWorkingDirectory(); });
    first.unmount();

    setDataOwnerGeneration('owner-b');
    const b = installWechatApi();
    let finishSettings!: (value: WechatChannelSettingsState) => void;
    b.api.getChannelSettings.mockReturnValueOnce(new Promise((resolve) => { finishSettings = resolve; }));
    const second = renderHook(() => useWechatBot());
    expect(second.result.current.channelSettings).toBeNull();
    expect(second.result.current.state).toEqual(disconnectedState());
    await act(async () => {
      expect(await staleUnlink(null)).toBe(false);
      expect(await second.result.current.setCompanion(null)).toBe(false);
      finishDirectory({ canceled: false, state: { ...settingsA, workingDir: 'D:/old-owner' } });
      await pending;
    });
    expect(b.api.setCompanion).not.toHaveBeenCalled();
    expect(__testing.getCache().channelSettings).toBeNull();
    await act(async () => { finishSettings({ ...settingsA, companionBotId: 'bot-b' }); });
    expect(second.result.current.channelSettings?.companionBotId).toBe('bot-b');
    await act(async () => { expect(await second.result.current.setCompanion(null)).toBe(true); });
    expect(b.api.setCompanion).toHaveBeenCalledWith(null);
    second.unmount();
  });
});

describe('useWechatBot for another computer', () => {
  it("serves that computer's WeChat through the given API and leaves this window's own cache alone", async () => {
    setDataOwnerGeneration('owner-a');
    __testing.resetCache();
    const own = installWechatApi();
    const other = installWechatApi({ phase: 'connected', bound: true, queuedTasks: 0 });
    const { result } = renderHook(() => useWechatBot(other.api as never));
    await waitFor(() => expect(result.current.state.phase).toBe('connected'));
    await act(async () => { expect(await result.current.setCompanion('bot-1')).toBe(true); });
    expect(other.api.setCompanion).toHaveBeenCalledWith('bot-1');
    expect(own.api.getState).not.toHaveBeenCalled();
    expect(own.api.setCompanion).not.toHaveBeenCalled();
    expect(__testing.getCache()).toEqual({ state: null, channelSettings: null });
  });
});

describe('useWechatBot with a window API that is not identity-stable', () => {
  it('loads once instead of re-subscribing on every render', async () => {
    setDataOwnerGeneration('owner-a');
    __testing.resetCache();
    const getState = vi.fn(async () => disconnectedState());
    // UI harnesses (and any bridge that proxies the API) hand out a fresh object per access.
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      get wechatBot() {
        return {
          getState,
          getChannelSettings: async () => ({ version: 1, workingDir: null, workingDirAvailable: true }),
          onStateChange: () => () => undefined,
          onChannelSettingsChange: () => () => undefined,
        };
      },
    };
    const { result } = renderHook(() => useWechatBot());
    await waitFor(() => expect(result.current.channelSettings).not.toBeNull());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); }); // real-wait: let a would-be render loop show itself
    expect(getState).toHaveBeenCalledTimes(1);
  });
});

function disconnectedState(): WechatBotState {
  return {
    phase: 'disconnected',
    bound: false,
    queuedTasks: 0,
  };
}
