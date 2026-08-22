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

function authState(dataOwnerId: string, ownerGeneration = 1): AuthStateChangePayload {
  return {
    user: null,
    mode: 'cloud',
    dataOwnerId,
    ownerGeneration,
    canEnterApp: true,
    isAuthenticated: true,
    isCanary: false,
    deviceId: 'dev-test',
    hasAccountDeletionReceipt: false,
    accountDeletionRestored: false,
  } as AuthStateChangePayload;
}

function installWechatApi(initial: WechatBotState = disconnectedState()) {
  const listeners = new Set<(state: WechatBotState) => void>();
  const authListeners = new Set<(auth: AuthStateChangePayload) => void>();
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
      electronAPI: {
        wechatBot: typeof api;
        onAuthStateChange: (cb: (auth: AuthStateChangePayload) => void) => () => void;
      };
    }
  ).electronAPI = {
    wechatBot: api,
    onAuthStateChange: vi.fn((callback: (auth: AuthStateChangePayload) => void) => {
      authListeners.add(callback);
      return () => authListeners.delete(callback);
    }),
  };
  return {
    api,
    push(state: WechatBotState) {
      for (const listener of listeners) listener(state);
    },
    pushAuth(auth: AuthStateChangePayload) {
      for (const listener of authListeners) listener(auth);
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

    expect(__testing.getCache()).toEqual({ state: null });
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

  it('drops the stale mount read that returns after a working-dir update (choose)', async () => {
    // 挂载读取会异步探测已配置目录(网络盘可挂数秒), 可能晚于用户的选择落定 —
    // 携带提交前旧配置的迟到读取不得覆盖较新的结果。
    const { api } = installWechatApi();
    let resolveMountRead!: (state: WechatChannelSettingsState) => void;
    api.getChannelSettings.mockReturnValueOnce(
      new Promise<WechatChannelSettingsState>((resolve) => {
        resolveMountRead = resolve;
      }),
    );
    const { result } = renderHook(() => useWechatBot());
    api.chooseWorkingDirectory.mockResolvedValueOnce({
      canceled: false,
      state: { version: 1, workingDir: 'D:/new-pick', workingDirAvailable: true },
    });
    await act(async () => {
      await result.current.chooseWorkingDirectory();
    });
    expect(result.current.channelSettings?.workingDir).toBe('D:/new-pick');

    await act(async () => {
      resolveMountRead({ version: 1, workingDir: 'D:/old', workingDirAvailable: true });
      await Promise.resolve();
    });
    expect(result.current.channelSettings?.workingDir).toBe('D:/new-pick');
  });

  it('drops the stale mount read that returns after a working-dir reset', async () => {
    const { api } = installWechatApi();
    let resolveMountRead!: (state: WechatChannelSettingsState) => void;
    api.getChannelSettings.mockReturnValueOnce(
      new Promise<WechatChannelSettingsState>((resolve) => {
        resolveMountRead = resolve;
      }),
    );
    const { result } = renderHook(() => useWechatBot());
    api.resetWorkingDirectory.mockResolvedValueOnce({
      version: 1,
      workingDir: null,
      workingDirAvailable: true,
    });
    await act(async () => {
      await result.current.resetWorkingDirectory();
    });
    expect(result.current.channelSettings?.workingDir).toBeNull();

    await act(async () => {
      resolveMountRead({ version: 1, workingDir: 'D:/old', workingDirAvailable: true });
      await Promise.resolve();
    });
    expect(result.current.channelSettings?.workingDir).toBeNull();
  });

  it('invalidates the displayed path immediately when the Cindy account switches', async () => {
    // 微信状态推送不含任何 Cindy 身份 — 不订阅 auth 的话旧账号路径会一直
    // 留在界面上(Main 守卫只拦得住迟到响应, 清不掉已渲染状态)。
    const harness = installWechatApi();
    const ownerA: WechatChannelSettingsState = {
      version: 1,
      workingDir: 'D:/owner-a/project',
      workingDirAvailable: true,
    };
    const ownerB: WechatChannelSettingsState = {
      version: 1,
      workingDir: null,
      workingDirAvailable: true,
    };
    let current = ownerA;
    harness.api.getChannelSettings.mockImplementation(async () => current);
    const { result } = renderHook(() => useWechatBot());
    await waitFor(() => expect(result.current.channelSettings).toEqual(ownerA));

    current = ownerB;
    act(() => {
      harness.pushAuth(authState('owner-b'));
    });
    expect(result.current.channelSettings).toBeNull();
    await waitFor(() => expect(result.current.channelSettings).toEqual(ownerB));
  });

  it('drops a hanging mount read that crosses a Cindy account switch', async () => {
    const harness = installWechatApi();
    let resolveMountRead!: (state: WechatChannelSettingsState) => void;
    harness.api.getChannelSettings.mockReturnValueOnce(
      new Promise<WechatChannelSettingsState>((resolve) => {
        resolveMountRead = resolve;
      }),
    );
    const { result } = renderHook(() => useWechatBot());
    // 挂载读取在途(慢速网络盘探测), Cindy 换号: 失效 + 为新账号重拉。
    harness.api.getChannelSettings.mockResolvedValue({
      version: 1,
      workingDir: 'D:/owner-b/project',
      workingDirAvailable: true,
    });
    act(() => {
      harness.pushAuth(authState('owner-b'));
    });
    await waitFor(() =>
      expect(result.current.channelSettings?.workingDir).toBe('D:/owner-b/project'),
    );

    // 旧账号语境的挂载读取此刻才返回 — 不得覆盖。
    await act(async () => {
      resolveMountRead({ version: 1, workingDir: 'D:/owner-a/project', workingDirAvailable: true });
      await Promise.resolve();
    });
    expect(result.current.channelSettings?.workingDir).toBe('D:/owner-b/project');
  });

  it('skips the focus refresh while a working-dir update is in flight', async () => {
    const harness = installWechatApi();
    const { result } = renderHook(() => useWechatBot());
    await waitFor(() => expect(result.current.channelSettings).not.toBeNull());
    const readsBefore = harness.api.getChannelSettings.mock.calls.length;

    let resolveChoose!: (result: {
      canceled: boolean;
      state: { version: 1; workingDir: string; workingDirAvailable: boolean };
    }) => void;
    harness.api.chooseWorkingDirectory.mockReturnValueOnce(
      new Promise<{
        canceled: boolean;
        state: { version: 1; workingDir: string; workingDirAvailable: boolean };
      }>((resolve) => {
        resolveChoose = resolve;
      }),
    );
    let chooseDone: Promise<void> | null = null;
    act(() => {
      chooseDone = result.current.chooseWorkingDirectory();
    });
    await act(async () => {
      await result.current.refreshChannelSettings();
    });
    expect(harness.api.getChannelSettings.mock.calls.length).toBe(readsBefore);

    await act(async () => {
      resolveChoose({ canceled: false, state: { version: 1, workingDir: 'D:/picked', workingDirAvailable: true } });
      await chooseDone;
    });
    expect(result.current.channelSettings?.workingDir).toBe('D:/picked');
  });
});

function disconnectedState(): WechatBotState {
  return {
    phase: 'disconnected',
    bound: false,
    queuedTasks: 0,
  };
}
