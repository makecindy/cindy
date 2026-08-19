// @vitest-environment jsdom

import type { PropsWithChildren } from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  let authStateListener: ((state: unknown) => void) | undefined;
  let expiredListener: ((payload: { message?: string }) => void) | undefined;
  const service = {
    initialize: vi.fn(),
    getLoginState: vi.fn(),
    dispatchLoginAction: vi.fn(),
    logout: vi.fn<() => Promise<void>>(async () => undefined),
    enterLocalMode: vi.fn(),
    exitLocalMode: vi.fn(),
    consumeAccountDeletionRestoredNotice: vi.fn(async () => true),
    onAuthStateChange: vi.fn((listener: (state: unknown) => void) => {
      authStateListener = listener;
      return () => {
        authStateListener = undefined;
      };
    }),
    dispose: vi.fn(),
  };
  return {
    service,
    reset: vi.fn(),
    getMe: vi.fn(async () => ({ role: 'user' })),
    clearWorkersCache: vi.fn(),
    setModelVisibilityOwner: vi.fn(),
    invalidateProvidersSnapshot: vi.fn(),
    preloadLocalCatalogSnapshot: vi.fn(async () => undefined),
    confirm: vi.fn(async () => true),
    emitAuth(state: unknown) {
      authStateListener?.(state);
    },
    registerExpired(listener: (payload: { message?: string }) => void) {
      expiredListener = listener;
      return () => {
        expiredListener = undefined;
      };
    },
    emitExpired() {
      expiredListener?.({ message: 'expired' });
    },
  };
});

vi.mock('@/lib/authService', () => ({
  createAuthService: () => mocks.service,
}));
vi.mock('@/lib/sessionsStore', () => ({
  sessionsStore: { reset: mocks.reset },
}));
vi.mock('@/lib/meService', () => ({ getMe: mocks.getMe }));
vi.mock('@/features/cc-agent/hooks/useWorkers', () => ({
  clearWorkersCache: mocks.clearWorkersCache,
}));
vi.mock('@/state/modelVisibilityPrefs', () => ({
  setModelVisibilityOwner: mocks.setModelVisibilityOwner,
}));
vi.mock('@/lib/providersSnapshotStore', () => ({
  invalidateProvidersSnapshot: mocks.invalidateProvidersSnapshot,
}));
vi.mock('@/lib/localCatalogSnapshot', () => ({
  preloadLocalCatalogSnapshot: mocks.preloadLocalCatalogSnapshot,
}));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: mocks.confirm }),
}));
const translate = vi.hoisted(() => (key: string) => key);
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: translate }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));
const restoredToast = vi.hoisted(() => vi.fn());
vi.mock('@/lib/toast', () => ({
  toast: { success: restoredToast },
}));

import { AuthProvider, useAuth } from '@/contexts/AuthContext';
import {
  __testing as dataOwnerGenerationTesting,
  getDataOwnerGeneration,
} from '@/contexts/dataOwnerGeneration';
import {
  __resetForTest as resetEnginePrefs,
  getModelEngineOverride,
  setModelEngineOverride,
} from '@/state/modelEnginePrefs';
import {
  __resetForTest as resetFavorites,
  addModelFavorite,
  listModelFavorites,
} from '@/state/modelFavorites';

function user(id: string) {
  return {
    id,
    name: id,
    avatar: null,
    email: `${id}@example.com`,
    defaultModel: 'model',
    defaultEffort: 'medium',
    membershipKind: 'personal' as const,
    membershipRole: 'owner' as const,
    orgId: null,
    orgName: null,
    orgSlug: null,
    passportId: `${id}-passport`,
  };
}

function authState(id: string | null, isCanary = false) {
  return {
    user: id ? user(id) : null,
    mode: id ? ('cloud' as const) : ('signed-out' as const),
    dataOwnerId: id,
    ownerGeneration: id ? 1 : 2,
    canEnterApp: id !== null,
    isAuthenticated: id !== null,
    isCanary,
    deviceId: 'device',
    hasAccountDeletionReceipt: false,
    accountDeletionRestored: false,
  };
}

function localAuthState() {
  return {
    user: null,
    mode: 'local' as const,
    dataOwnerId: 'local-v1',
    ownerGeneration: 3,
    canEnterApp: true,
    isAuthenticated: false,
    isCanary: false,
    deviceId: 'device',
    hasAccountDeletionReceipt: false,
    accountDeletionRestored: false,
  };
}

describe('AuthContext session cache boundaries', () => {
  const wrapper = ({ children }: PropsWithChildren) => <AuthProvider>{children}</AuthProvider>;

  beforeEach(() => {
    mocks.reset.mockClear();
    mocks.getMe.mockClear();
    mocks.clearWorkersCache.mockClear();
    mocks.setModelVisibilityOwner.mockClear();
    mocks.invalidateProvidersSnapshot.mockClear();
    mocks.preloadLocalCatalogSnapshot.mockClear();
    dataOwnerGenerationTesting.reset();
    mocks.service.consumeAccountDeletionRestoredNotice.mockClear();
    restoredToast.mockClear();
    mocks.confirm.mockClear();
    mocks.service.initialize.mockResolvedValue(authState('account-a'));
    mocks.service.logout.mockResolvedValue(undefined);
    mocks.service.enterLocalMode.mockResolvedValue(localAuthState());
    mocks.service.exitLocalMode.mockResolvedValue(authState(null));
    (
      window as unknown as { electronAPI: { onAuthSessionExpired: typeof mocks.registerExpired } }
    ).electronAPI = {
      onAuthSessionExpired: mocks.registerExpired,
    };
  });

  afterEach(() => {
    cleanup();
    mocks.service.dispose.mockClear();
  });

  it('resets sessions when auth state switches accounts or logs out', async () => {
    const view = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(view.result.current.user?.id).toBe('account-a'));
    expect(mocks.reset).toHaveBeenCalledTimes(1);
    expect(mocks.invalidateProvidersSnapshot).toHaveBeenCalledTimes(1);
    expect(mocks.setModelVisibilityOwner).toHaveBeenLastCalledWith('account-a', 1, 'cloud');

    act(() => mocks.emitAuth(authState('account-b')));
    expect(mocks.reset).toHaveBeenCalledTimes(2);
    expect(mocks.invalidateProvidersSnapshot).toHaveBeenCalledTimes(2);
    expect(mocks.setModelVisibilityOwner).toHaveBeenLastCalledWith('account-b', 1, 'cloud');

    act(() => mocks.emitAuth(authState('account-b')));
    expect(mocks.reset).toHaveBeenCalledTimes(2);
    expect(mocks.invalidateProvidersSnapshot).toHaveBeenCalledTimes(2);

    act(() => mocks.emitAuth(authState(null)));
    expect(mocks.reset).toHaveBeenCalledTimes(3);
    expect(mocks.invalidateProvidersSnapshot).toHaveBeenCalledTimes(3);
    expect(mocks.setModelVisibilityOwner).toHaveBeenLastCalledWith(null, 2, 'signed-out');

    await act(async () => {
      await view.result.current.logout();
    });
    expect(mocks.reset).toHaveBeenCalledTimes(4);
  });

  it('resets sessions when authentication expires', async () => {
    renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(mocks.service.initialize).toHaveBeenCalled());

    mocks.reset.mockClear();
    act(() => mocks.emitExpired());
    await waitFor(() => expect(mocks.reset).toHaveBeenCalledTimes(1));
  });

  it.each([
    ['logout', 'account-a', authState('account-a')],
    ['enterLocalMode', 'account-a', authState('account-a')],
    ['exitLocalMode', 'local-v1', localAuthState()],
  ] as const)(
    'restores and reloads the current owner snapshot when %s fails',
    async (action, expectedOwner, initialState) => {
      mocks.service.initialize.mockResolvedValue(initialState);
      mocks.service[action].mockRejectedValueOnce(new Error(`${action} failed`));
      const view = renderHook(() => useAuth(), { wrapper });
      await waitFor(() => expect(view.result.current.dataOwnerId).toBe(expectedOwner));
      const recoveryEpochBeforeFailure = view.result.current.dataOwnerRecoveryEpoch;

      await act(async () => {
        await expect(view.result.current[action]()).rejects.toThrow(`${action} failed`);
      });

      expect(view.result.current.dataOwnerId).toBe(expectedOwner);
      expect(view.result.current.dataOwnerRecoveryEpoch).toBe(recoveryEpochBeforeFailure + 1);
      expect(getDataOwnerGeneration().dataOwnerId).toBe(expectedOwner);
      expect(mocks.preloadLocalCatalogSnapshot).toHaveBeenCalledOnce();
    },
  );

  it('keeps a newer pushed owner when an older auth boundary later rejects', async () => {
    let rejectLogout!: (error: Error) => void;
    mocks.service.logout.mockReturnValueOnce(
      new Promise<void>((_resolve, reject) => {
        rejectLogout = reject;
      }),
    );
    const view = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(view.result.current.dataOwnerId).toBe('account-a'));

    let logout!: Promise<void>;
    act(() => {
      logout = view.result.current.logout();
    });
    act(() => mocks.emitAuth(authState('account-b')));
    await act(async () => {
      rejectLogout(new Error('logout failed'));
      await expect(logout).rejects.toThrow('logout failed');
    });

    expect(view.result.current.dataOwnerId).toBe('account-b');
    expect(getDataOwnerGeneration().dataOwnerId).toBe('account-b');
    expect(mocks.preloadLocalCatalogSnapshot).toHaveBeenCalledOnce();
  });

  it('restores the stable owner after overlapping auth boundaries both reject', async () => {
    let rejectFirst!: (error: Error) => void;
    let rejectSecond!: (error: Error) => void;
    mocks.service.logout
      .mockReturnValueOnce(
        new Promise<void>((_resolve, reject) => {
          rejectFirst = reject;
        }),
      )
      .mockReturnValueOnce(
        new Promise<void>((_resolve, reject) => {
          rejectSecond = reject;
        }),
      );
    const view = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(view.result.current.dataOwnerId).toBe('account-a'));

    const first = view.result.current.logout();
    const second = view.result.current.logout();
    await act(async () => {
      rejectFirst(new Error('first logout failed'));
      await expect(first).rejects.toThrow('first logout failed');
    });
    await act(async () => {
      rejectSecond(new Error('second logout failed'));
      await expect(second).rejects.toThrow('second logout failed');
    });

    expect(getDataOwnerGeneration().dataOwnerId).toBe('account-a');
    expect(mocks.preloadLocalCatalogSnapshot).toHaveBeenCalledTimes(2);
  });

  it('restores a locally committed owner when the next boundary fails before an auth push', async () => {
    mocks.service.initialize.mockResolvedValue(authState(null));
    mocks.service.exitLocalMode.mockRejectedValueOnce(new Error('exit failed'));
    const view = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(view.result.current.dataOwnerId).toBeNull());

    await act(async () => {
      await view.result.current.enterLocalMode();
    });
    expect(view.result.current.dataOwnerId).toBe('local-v1');

    await act(async () => {
      await expect(view.result.current.exitLocalMode()).rejects.toThrow('exit failed');
    });
    expect(getDataOwnerGeneration().dataOwnerId).toBe('local-v1');
    expect(mocks.preloadLocalCatalogSnapshot).toHaveBeenCalledOnce();
  });

  it('keeps a successful overlapping owner transition when a sibling later rejects', async () => {
    let resolveFirst!: (state: ReturnType<typeof authState>) => void;
    let rejectSecond!: (error: Error) => void;
    mocks.service.initialize.mockResolvedValue(localAuthState());
    mocks.service.exitLocalMode
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
      )
      .mockReturnValueOnce(
        new Promise((_resolve, reject) => {
          rejectSecond = reject;
        }),
      );
    const view = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(view.result.current.dataOwnerId).toBe('local-v1'));

    const first = view.result.current.exitLocalMode();
    const second = view.result.current.exitLocalMode();
    await act(async () => {
      resolveFirst(authState(null));
      await first;
    });
    await act(async () => {
      rejectSecond(new Error('second exit failed'));
      await expect(second).rejects.toThrow('second exit failed');
    });

    expect(view.result.current.dataOwnerId).toBeNull();
    expect(getDataOwnerGeneration().dataOwnerId).toBeNull();
    expect(mocks.preloadLocalCatalogSnapshot).toHaveBeenCalledOnce();
  });

  it('updates Canary state without treating it as an account switch', async () => {
    const view = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(view.result.current.user?.id).toBe('account-a'));

    mocks.reset.mockClear();
    act(() => mocks.emitAuth(authState('account-a', true)));

    expect(view.result.current.isCanary).toBe(true);
    expect(mocks.reset).not.toHaveBeenCalled();
  });

  it('clears an in-progress login flow when entering local mode', async () => {
    mocks.service.initialize.mockResolvedValue(authState(null));
    mocks.service.getLoginState.mockResolvedValueOnce({
      success: true,
      state: { step: 'browser-redirect', label: 'Google' },
    });
    const view = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(view.result.current.mode).toBe('signed-out'));

    await act(async () => {
      await view.result.current.loadLoginState();
    });
    expect(view.result.current.loginState).toEqual({
      step: 'browser-redirect',
      label: 'Google',
    });

    act(() => mocks.emitAuth(localAuthState()));

    expect(view.result.current.mode).toBe('local');
    expect(view.result.current.loginState).toBeNull();
  });

  /**
   * 本地模式也是一次 dataOwnerId 切换(2026-08-17 review 第五轮 M5)。enterLocalMode /
   * exitLocalMode 此前只更新了 dataOwnerId 与另外几个 owner 分区 setter,漏掉统一模型选择器
   * 新增的两根轴 —— 于是本地模式下读写的是**上一个身份**的收藏 / 引擎 override:跨身份可见,
   * 还会把改动写进别人的账号。
   */
  it('repartitions unified-picker favorites and engine overrides across local mode', async () => {
    resetFavorites();
    resetEnginePrefs();
    const view = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(view.result.current.user?.id).toBe('account-a'));
    const cloudUid = addModelFavorite({ providerId: 'xd', modelId: 'gpt-5.5', agent: 'codex' });
    setModelEngineOverride('xd', 'gpt-5.5', 'cc');
    expect(cloudUid).not.toBe('');

    await act(async () => {
      await view.result.current.enterLocalMode();
    });
    // 本地模式是另一个分区:云端身份存的东西一条都不该露出来。
    expect(listModelFavorites()).toHaveLength(0);
    expect(getModelEngineOverride('xd', 'gpt-5.5')).toBeUndefined();
    const localUid = addModelFavorite({
      providerId: 'anthropic',
      modelId: 'claude-opus-5',
      agent: 'cc',
    });
    setModelEngineOverride('anthropic', 'claude-opus-5', 'codex');
    expect(listModelFavorites().map((item) => item.uid)).toEqual([localUid]);

    mocks.service.exitLocalMode.mockResolvedValue(authState('account-a'));
    await act(async () => {
      await view.result.current.exitLocalMode();
    });
    // 退出本地模式:云端那一份原样回来,本地模式里写的东西留在本地分区。
    expect(listModelFavorites().map((item) => item.uid)).toEqual([cloudUid]);
    expect(getModelEngineOverride('xd', 'gpt-5.5')).toBe('cc');
    expect(getModelEngineOverride('anthropic', 'claude-opus-5')).toBeUndefined();
    resetFavorites();
    resetEnginePrefs();
    window.localStorage.clear();
  });

  it('consumes the restored account-deletion notice once', async () => {
    const view = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(view.result.current.user?.id).toBe('account-a'));

    act(() =>
      mocks.emitAuth({
        ...authState('account-a'),
        accountDeletionRestored: true,
      }),
    );

    await waitFor(() => {
      expect(mocks.service.consumeAccountDeletionRestoredNotice).toHaveBeenCalledTimes(1);
    });
    expect(view.result.current.accountDeletionRestored).toBe(false);
  });
});
