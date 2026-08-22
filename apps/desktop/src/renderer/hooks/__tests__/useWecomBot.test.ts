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
  const boundaryReadyListeners = new Set<() => void>();
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
        onImAccountBoundaryReady: (cb: () => void) => () => void;
      };
    }
  ).electronAPI = {
    wecomBot: api,
    onAuthStateChange: vi.fn((callback: (auth: AuthStateChangePayload) => void) => {
      authListeners.add(callback);
      return () => authListeners.delete(callback);
    }),
    onImAccountBoundaryReady: vi.fn((callback: () => void) => {
      boundaryReadyListeners.add(callback);
      return () => boundaryReadyListeners.delete(callback);
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
    pushBoundaryReady() {
      for (const listener of boundaryReadyListeners) listener();
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

  it('re-pulls channel settings after the IM account boundary becomes ready', async () => {
    // 冷启动(无模块缓存种子): getStatus 先确立 owner(''), 但 IM 边界未激活 →
    // 首拉被 Main fail-closed 拒绝, 设置停在 null; Main 激活边界后广播
    // ready → 到达即重拉成功, 不必等设置卡展开。
    const harness = installWecomApi();
    harness.api.getChannelSettings
      .mockRejectedValueOnce(new Error('[IM_NOT_READY] IM account is not active'))
      .mockResolvedValueOnce(settingsFor('A'));
    const { result } = renderHook(() => useWecomBot());
    await waitFor(() => expect(harness.api.getChannelSettings).toHaveBeenCalledTimes(1));
    expect(result.current.channelSettings).toBeNull();

    act(() => harness.pushBoundaryReady());
    await waitFor(() => expect(result.current.channelSettings).toEqual(settingsFor('A')));
    expect(harness.api.getChannelSettings).toHaveBeenCalledTimes(2);
  });

  it('drops the ready-triggered read that crosses a Cindy account switch', async () => {
    // ready 重拉在途期间换号: 该响应按旧 owner 代次丢弃, 不覆盖新账号状态。
    const harness = installWecomApi({
      status: { kind: 'connected', appId: 'app' },
      botId: 'bot',
      ownerUserId: 'A',
    });
    harness.api.getChannelSettings.mockRejectedValueOnce(
      new Error('[IM_NOT_READY] IM account is not active'),
    );
    const { result } = renderHook(() => useWecomBot());
    await waitFor(() => expect(harness.api.getChannelSettings).toHaveBeenCalledTimes(1));

    // ready 到达 → 重拉挂起(慢速网络盘探测, 可能仍服务于旧 owner 语境)。
    let resolveReadyRead!: (state: WecomChannelSettingsState) => void;
    harness.api.getChannelSettings.mockReturnValueOnce(
      new Promise<WecomChannelSettingsState>((resolve) => {
        resolveReadyRead = resolve;
      }),
    );
    act(() => harness.pushBoundaryReady());
    await waitFor(() => expect(harness.api.getChannelSettings).toHaveBeenCalledTimes(2));

    // 换号: 立即失效 + 新 owner 的拉取先返回。
    harness.api.getChannelSettings.mockResolvedValueOnce(settingsFor('B'));
    act(() => {
      harness.pushAuth(authState('owner-b'));
    });
    expect(result.current.channelSettings).toBeNull();
    await waitFor(() => expect(result.current.channelSettings).toEqual(settingsFor('B')));

    // ready 重拉(旧 owner 代次)此刻才返回 — 不得落地。
    await act(async () => {
      resolveReadyRead(settingsFor('A'));
      await Promise.resolve();
    });
    expect(result.current.channelSettings).toEqual(settingsFor('B'));
  });

  it('recovers the committed pick when a TOFU owner flip races the directory picker', async () => {
    // TOFU 首绑定在弹窗期间把 owner 从 '' 翻到 sender: Main 照常提交新目录并
    // 返回, 结果却按旧代次被丢弃; 翻转触发的读取出发于提交之前、先带着旧配置
    // 落地 — 最终必须由丢弃后的收敛读取把已落盘状态读回来(修复前停在旧配置)。
    const harness = installWecomApi();
    const committed: WecomChannelSettingsState = {
      version: 1,
      workingDir: 'D:/newly-picked',
      workingDirAvailable: true,
    };
    harness.api.getChannelSettings
      .mockResolvedValueOnce(settingsFor('old')) // 挂载确立 owner('') 的读取
      .mockResolvedValueOnce(settingsFor('old')) // owner 翻转触发的读取(提交前, 先落地)
      .mockResolvedValueOnce(committed); // 丢弃结果后的收敛读取(Main 已提交)
    const { result } = renderHook(() => useWecomBot());
    await waitFor(() => expect(result.current.channelSettings).toEqual(settingsFor('old')));

    let resolvePick!: (result: { canceled: boolean; state: WecomChannelSettingsState }) => void;
    harness.api.chooseWorkingDirectory.mockReturnValueOnce(
      new Promise<{ canceled: boolean; state: WecomChannelSettingsState }>((resolve) => {
        resolvePick = resolve;
      }),
    );
    let chooseDone: Promise<void> | null = null;
    act(() => {
      chooseDone = result.current.chooseWorkingDirectory();
    });
    // 弹窗期间 TOFU 首条入站消息确立 owner: ''→'X'。
    act(() => {
      harness.push({ status: { kind: 'connected', appId: 'app' }, botId: 'bot', ownerUserId: 'X' });
    });
    expect(result.current.channelSettings).toBeNull();
    // 翻转触发的提交前读取先返回并落地 — 修复前它会一直定住 UI。
    await waitFor(() => expect(result.current.channelSettings).toEqual(settingsFor('old')));

    // Main 已提交并返回; 结果按旧代次丢弃 → 收敛读取落地已提交状态。
    await act(async () => {
      resolvePick({ canceled: false, state: committed });
      await chooseDone;
    });
    await waitFor(() => expect(result.current.channelSettings).toEqual(committed));
    expect(harness.api.getChannelSettings).toHaveBeenCalledTimes(3);
  });

  it('invalidates the pre-reset read and converges when a TOFU owner flip races the reset', async () => {
    // reset 版竞态另一半: 翻转触发的提交前读取晚于丢弃返回 — 必须已被
    // updateSeq 作废, 最终状态收敛到 Main 删除配置后的默认值。
    const harness = installWecomApi();
    const defaults: WecomChannelSettingsState = {
      version: 1,
      workingDir: null,
      workingDirAvailable: true,
    };
    let resolveFlipRead!: (state: WecomChannelSettingsState) => void;
    harness.api.getChannelSettings
      .mockResolvedValueOnce(settingsFor('old')) // 挂载确立 owner('')
      .mockReturnValueOnce( // owner 翻转触发的读取(提交前, 挂起晚归)
        new Promise<WecomChannelSettingsState>((resolve) => {
          resolveFlipRead = resolve;
        }),
      )
      .mockResolvedValueOnce(defaults); // 丢弃结果后的收敛读取(配置已删除)
    const { result } = renderHook(() => useWecomBot());
    await waitFor(() => expect(result.current.channelSettings).toEqual(settingsFor('old')));

    let resolveReset!: (state: WecomChannelSettingsState) => void;
    harness.api.resetWorkingDirectory.mockReturnValueOnce(
      new Promise<WecomChannelSettingsState>((resolve) => {
        resolveReset = resolve;
      }),
    );
    let resetDone: Promise<void> | null = null;
    act(() => {
      resetDone = result.current.resetWorkingDirectory();
    });
    // reset 在途时 TOFU 翻转 owner: ''→'X'(读取挂起中)。
    act(() => {
      harness.push({ status: { kind: 'connected', appId: 'app' }, botId: 'bot', ownerUserId: 'X' });
    });
    expect(result.current.channelSettings).toBeNull();

    // Main 已删除配置并返回; 结果按旧代次丢弃 → 收敛读取落地「已恢复默认」。
    await act(async () => {
      resolveReset(defaults);
      await resetDone;
    });
    await waitFor(() => expect(result.current.channelSettings).toEqual(defaults));

    // 翻转触发的提交前读取此刻才返回 — 已被作废, 不得落地。
    await act(async () => {
      resolveFlipRead(settingsFor('old'));
      await Promise.resolve();
    });
    expect(result.current.channelSettings).toEqual(defaults);
    expect(harness.api.getChannelSettings).toHaveBeenCalledTimes(3);
  });
});
