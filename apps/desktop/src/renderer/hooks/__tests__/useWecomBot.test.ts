// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { __testing, useWecomBot } from '../useWecomBot';

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

type StatusPush = {
  status: WecomBotTransportStatus;
  botId: string | null;
  ownerUserId: string | null;
};

function settingsFor(owner: string): WecomChannelSettingsState {
  return {
    version: 1,
    workingDir: `D:/owners/${owner}/project`,
    workingDirAvailable: true,
  };
}

const IDLE: StatusPush = { status: { kind: 'idle' }, botId: null, ownerUserId: null };

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

function installWecomApi(initial: StatusPush = IDLE) {
  const listeners = new Set<(update: StatusPush) => void>();
  const authListeners = new Set<(auth: AuthStateChangePayload) => void>();
  const api = {
    getStatus: vi.fn(async () => initial),
    setConfig: vi.fn(async () => ({
      status: { kind: 'connected', appId: 'app' } as WecomBotTransportStatus,
      botId: 'bot',
      ownerUserId: 'X',
    })),
    reconnect: vi.fn(async () => ({
      status: { kind: 'connecting' } as WecomBotTransportStatus,
      botId: 'bot',
      ownerUserId: null,
    })),
    disconnect: vi.fn(async () => IDLE),
    getChannelSettings: vi.fn(async () => settingsFor('A')),
    chooseWorkingDirectory: vi.fn(async () => ({
      canceled: false,
      state: settingsFor('A'),
    })),
    resetWorkingDirectory: vi.fn(async () => settingsFor('A')),
    onStatusChange: vi.fn((callback: (update: StatusPush) => void) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    }),
  };
  (
    window as unknown as {
      electronAPI: {
        wecomBot: typeof api;
        onAuthStateChange: (cb: (auth: AuthStateChangePayload) => void) => () => void;
      };
    }
  ).electronAPI = {
    wecomBot: api,
    onAuthStateChange: vi.fn((callback: (auth: AuthStateChangePayload) => void) => {
      authListeners.add(callback);
      return () => authListeners.delete(callback);
    }),
  };
  return {
    api,
    push(update: StatusPush) {
      for (const listener of listeners) listener(update);
    },
    pushAuth(auth: AuthStateChangePayload) {
      for (const listener of authListeners) listener(auth);
    },
  };
}

describe('useWecomBot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __testing.resetCache();
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });

  it('loads the transport state and the current owner channel settings on mount', async () => {
    const harness = installWecomApi({
      status: { kind: 'connected', appId: 'app' },
      botId: 'bot',
      ownerUserId: 'A',
    });
    const { result } = renderHook(() => useWecomBot());

    await waitFor(() => expect(result.current.ownerUserId).toBe('A'));
    await waitFor(() => expect(result.current.channelSettings).toEqual(settingsFor('A')));
    expect(harness.api.getChannelSettings).toHaveBeenCalledTimes(1);
  });

  it('invalidates the previous owner path immediately on account switch and refetches', async () => {
    const harness = installWecomApi({
      status: { kind: 'connected', appId: 'app' },
      botId: 'bot',
      ownerUserId: 'A',
    });
    let owner = 'A';
    harness.api.getChannelSettings.mockImplementation(async () => settingsFor(owner));
    const { result } = renderHook(() => useWecomBot());
    await waitFor(() => expect(result.current.channelSettings).toEqual(settingsFor('A')));

    owner = 'B';
    act(() => {
      harness.push({ status: { kind: 'connected', appId: 'app' }, botId: 'bot', ownerUserId: 'B' });
    });
    // 切号瞬间: 旧 owner 的绝对路径立即失效, 不等新请求返回。
    expect(result.current.channelSettings).toBeNull();
    await waitFor(() => expect(result.current.channelSettings).toEqual(settingsFor('B')));
    expect(result.current.ownerUserId).toBe('B');
  });

  it('drops a late response from the previous owner instead of overwriting the new owner', async () => {
    const harness = installWecomApi({
      status: { kind: 'connected', appId: 'app' },
      botId: 'bot',
      ownerUserId: 'A',
    });
    // 第一次挂载把 owner A 落进模块缓存(重挂载的种子来源)。
    const first = renderHook(() => useWecomBot());
    await waitFor(() => expect(first.result.current.channelSettings).toEqual(settingsFor('A')));
    first.unmount();

    // 重挂载: 缓存种子 owner A, 挂载即拉 — 该请求挂起(可能仍服务于 A);
    // 切号触发的新请求(owner B)先返回。
    let resolveOwnerA!: (state: WecomChannelSettingsState) => void;
    harness.api.getChannelSettings
      .mockReturnValueOnce(
        new Promise<WecomChannelSettingsState>((resolve) => {
          resolveOwnerA = resolve;
        }),
      )
      .mockImplementationOnce(async () => settingsFor('B'));
    const { result } = renderHook(() => useWecomBot());

    act(() => {
      harness.push({ status: { kind: 'connected', appId: 'app' }, botId: 'bot', ownerUserId: 'B' });
    });
    await waitFor(() => expect(result.current.channelSettings).toEqual(settingsFor('B')));

    // A 的旧请求此刻才返回 — 不得覆盖 B 的状态(递增 epoch 的写回守卫)。
    await act(async () => {
      resolveOwnerA(settingsFor('A'));
      await Promise.resolve();
    });
    expect(result.current.channelSettings).toEqual(settingsFor('B'));
    expect(result.current.ownerUserId).toBe('B');
  });

  it('drops the picker result when the account switches while the dialog or probe is pending', async () => {
    const harness = installWecomApi({
      status: { kind: 'connected', appId: 'app' },
      botId: 'bot',
      ownerUserId: 'A',
    });
    const { result } = renderHook(() => useWecomBot());
    await waitFor(() => expect(result.current.channelSettings).toEqual(settingsFor('A')));

    let resolveChoose!: (result: { canceled: boolean; state: WecomChannelSettingsState }) => void;
    harness.api.chooseWorkingDirectory.mockReturnValueOnce(
      new Promise<{ canceled: boolean; state: WecomChannelSettingsState }>((resolve) => {
        resolveChoose = resolve;
      }),
    );
    let chooseDone: Promise<void> | null = null;
    act(() => {
      chooseDone = result.current.chooseWorkingDirectory();
    });
    // 原生弹窗 + Main 侧异步探测期间切号: B 的设置先落位。
    harness.api.getChannelSettings.mockImplementation(async () => settingsFor('B'));
    act(() => {
      harness.push({ status: { kind: 'connected', appId: 'app' }, botId: 'bot', ownerUserId: 'B' });
    });
    await waitFor(() => expect(result.current.channelSettings).toEqual(settingsFor('B')));

    // A 语境下选完的目录此刻才返回 — 不得写回。
    await act(async () => {
      resolveChoose({ canceled: false, state: settingsFor('A') });
      await chooseDone;
    });
    expect(result.current.channelSettings).toEqual(settingsFor('B'));
    expect(result.current.isUpdatingWorkingDir).toBe(false);
  });

  it('applies the picked directory immediately although closing the dialog fires a focus refresh', async () => {
    // 回归: 原生选择器关窗触发 focus → 设置卡刷新读到提交前的旧配置, 且旧
    // 实现按「请求代次」丢弃了选择器结果 — 新目录显示不出来, 切页签才刷新。
    const harness = installWecomApi({
      status: { kind: 'connected', appId: 'app' },
      botId: 'bot',
      ownerUserId: 'A',
    });
    const picked: WecomChannelSettingsState = {
      version: 1,
      workingDir: 'D:/newly-picked',
      workingDirAvailable: true,
    };
    const { result } = renderHook(() => useWecomBot());
    await waitFor(() => expect(result.current.channelSettings).toEqual(settingsFor('A')));

    let resolveChoose!: (result: { canceled: boolean; state: WecomChannelSettingsState }) => void;
    harness.api.chooseWorkingDirectory.mockReturnValueOnce(
      new Promise<{ canceled: boolean; state: WecomChannelSettingsState }>((resolve) => {
        resolveChoose = resolve;
      }),
    );
    let chooseDone: Promise<void> | null = null;
    act(() => {
      chooseDone = result.current.chooseWorkingDirectory();
    });
    // 更新在途时 focus 刷新到达 — 必须被跳过, 不发起读取。
    await act(async () => {
      await result.current.refreshChannelSettings();
    });
    expect(harness.api.getChannelSettings).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveChoose({ canceled: false, state: picked });
      await chooseDone;
    });
    expect(result.current.channelSettings).toEqual(picked);
    expect(result.current.isUpdatingWorkingDir).toBe(false);
  });

  it('drops a stale read that was dispatched before a working-dir update landed', async () => {
    // 竞态另一半: 读取在更新提交前出发(读到旧配置), 却在更新结果之后返回 —
    // 按更新落地序号丢弃, 不得把新目录又盖回旧值。
    const harness = installWecomApi({
      status: { kind: 'connected', appId: 'app' },
      botId: 'bot',
      ownerUserId: 'A',
    });
    let resolveStaleRead!: (state: WecomChannelSettingsState) => void;
    harness.api.getChannelSettings.mockReturnValueOnce(
      new Promise<WecomChannelSettingsState>((resolve) => {
        resolveStaleRead = resolve;
      }),
    );
    const picked: WecomChannelSettingsState = {
      version: 1,
      workingDir: 'D:/newly-picked',
      workingDirAvailable: true,
    };
    harness.api.chooseWorkingDirectory.mockResolvedValueOnce({ canceled: false, state: picked });
    const { result } = renderHook(() => useWecomBot());
    // owner 首次确定触发挂载读取(挂起中, 携带旧配置)。
    await waitFor(() => expect(result.current.ownerUserId).toBe('A'));
    expect(result.current.channelSettings).toBeNull();

    await act(async () => {
      await result.current.chooseWorkingDirectory();
    });
    expect(result.current.channelSettings).toEqual(picked);

    // 旧读取此刻才返回(提交前的旧配置) — 不得覆盖已落位的新目录。
    await act(async () => {
      resolveStaleRead(settingsFor('A'));
      await Promise.resolve();
    });
    expect(result.current.channelSettings).toEqual(picked);
  });

  it('invalidates in-flight responses on unmount', async () => {
    const harness = installWecomApi();
    // 第一次挂载确立 owner 上下文(''), 重挂载才会挂载即拉。
    const first = renderHook(() => useWecomBot());
    await waitFor(() => expect(first.result.current.channelSettings).toEqual(settingsFor('A')));
    first.unmount();

    let resolveSettings!: (state: WecomChannelSettingsState) => void;
    harness.api.getChannelSettings.mockReturnValueOnce(
      new Promise<WecomChannelSettingsState>((resolve) => {
        resolveSettings = resolve;
      }),
    );
    const { unmount } = renderHook(() => useWecomBot());

    unmount();
    // 卸载作废在途响应 — 迟到 resolve 不再触碰任何状态(也不抛错)。
    await act(async () => {
      resolveSettings(settingsFor('B'));
      await Promise.resolve();
    });
    expect(__testing.getCache()).toMatchObject({ ownerUserId: '' });
  });

  it('invalidates immediately when the Cindy account switches but the WeCom ownerUserId stays the same', async () => {
    // 两个 Cindy 账号绑同一个企微用户: 企微推送维度看不到任何变化, 只有
    // auth 推送(dataOwnerId/ownerGeneration)区分得了。
    const harness = installWecomApi({
      status: { kind: 'connected', appId: 'app' },
      botId: 'bot',
      ownerUserId: 'A',
    });
    let cindyOwner = 'one';
    harness.api.getChannelSettings.mockImplementation(async () => settingsFor(cindyOwner));
    const { result } = renderHook(() => useWecomBot());
    await waitFor(() => expect(result.current.channelSettings).toEqual(settingsFor('one')));

    cindyOwner = 'two';
    act(() => {
      harness.pushAuth(authState('owner-two'));
    });
    // 企微 ownerUserId 全程未变, 渠道设置仍立即失效并重拉。
    expect(result.current.channelSettings).toBeNull();
    await waitFor(() => expect(result.current.channelSettings).toEqual(settingsFor('two')));
  });

  it('invalidates on Cindy account switch when neither side configured the WeCom bot (empty ownerUserId)', async () => {
    // 两边都没配置企微: ownerUserId 同为空串, 换号同样只有 auth 推送可见。
    const harness = installWecomApi();
    let cindyOwner = 'one';
    harness.api.getChannelSettings.mockImplementation(async () => settingsFor(cindyOwner));
    const { result } = renderHook(() => useWecomBot());
    await waitFor(() => expect(result.current.channelSettings).toEqual(settingsFor('one')));

    cindyOwner = 'two';
    act(() => {
      harness.pushAuth(authState('owner-two'));
    });
    expect(result.current.channelSettings).toBeNull();
    await waitFor(() => expect(result.current.channelSettings).toEqual(settingsFor('two')));
  });
});
