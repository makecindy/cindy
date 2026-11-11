// @vitest-environment jsdom

import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import type { AuthState, DesktopLoginActionResult } from '@/lib/authService';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * AuthContext initialize 链 .catch 回归(implementation-plan Step 3b WHAT2 v6.3)。
 *
 * 现网该链仅 then/finally,真实 reject 会产生 unhandled rejection 且 auth 快照悬空;
 * PR2b 补显式 .catch:统一 logger 记录 + 清为 unauthenticated snapshot,再 .finally,
 * 不新增视觉分支。本单测**必须真实 mock service.initialize reject**(与集成层
 * resolved-unauthenticated 口径分层并存,互不取代)。
 */

const mocks = vi.hoisted(() => ({
  service: {
    initialize: vi.fn<() => Promise<unknown>>(),
    onAuthStateChange: vi.fn<(listener: (state: AuthState) => void) => () => void>(() => () => {}),
    dispose: vi.fn(),
    getLoginState: vi.fn<() => Promise<DesktopLoginActionResult>>(),
    dispatchLoginAction: vi.fn<() => Promise<DesktopLoginActionResult>>(),
    beginAddAccount: vi.fn<() => Promise<DesktopLoginActionResult>>(),
    cancelAddAccount: vi.fn(async () => {}),
    logout: vi.fn(async () => {}),
    enterLocalMode: vi.fn<() => Promise<never>>(),
  },
  logError: vi.fn(),
  unhandled: [] as unknown[],
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/lib/authService', () => ({ createAuthService: () => mocks.service }));
vi.mock('@/lib/makerChatStore', () => ({
  cancelRemoteOptimisticSendsForDataOwnerBoundary: vi.fn(),
  setCurrentUserName: vi.fn(),
}));
vi.mock('@/lib/sessionsStore', () => ({ sessionsStore: { reset: vi.fn() } }));
vi.mock('@/features/cc-agent/hooks/useWorkers', () => ({ clearWorkersCache: vi.fn() }));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: vi.fn(async () => {}) }),
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: mocks.logError,
    fatal: vi.fn(),
  }),
}));

import { AuthProvider, useAuth } from '../AuthContext';
import { useLogin } from '@/hooks/useLogin';
import { prefetchDeviceProviders, useDeviceProviders } from '@/hooks/useDeviceProviders';
import { prefetchDeviceCapabilities, useAgentCapabilities } from '@/hooks/useAgentCapabilities';

function AuthProbe() {
  const { isInitializing, isAuthenticated, user, loginState } = useAuth();
  return (
    <div data-testid="auth-probe">
      {`init=${isInitializing};authed=${isAuthenticated};user=${user ? user.id : 'null'};login=${
        loginState ? 'set' : 'null'
      }`}
    </div>
  );
}

const onUnhandled = (reason: unknown) => {
  mocks.unhandled.push(reason);
};

beforeEach(() => {
  mocks.service.initialize.mockReset();
  mocks.service.onAuthStateChange.mockImplementation(() => () => {});
  mocks.logError.mockClear();
  mocks.unhandled.length = 0;
  process.on('unhandledRejection', onUnhandled);
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    onAuthSessionExpired: () => () => {},
  };
});

afterEach(() => {
  process.off('unhandledRejection', onUnhandled);
  cleanup();
  vi.clearAllMocks();
});

describe('initial auth decision', () => {
  const signedOut: AuthState = {
    user: null, mode: 'signed-out', dataOwnerId: null, ownerGeneration: 1,
    ownerBoundaryPending: false, canEnterApp: false, isAuthenticated: false,
    isCanary: false, deviceId: 'device', hasAccountDeletionReceipt: false,
    accountDeletionRestored: false, credentialStoreUnavailable: false,
  };
  // unit：真实 Provider；旧 finally 把 boundary pending 判成完成，已有 reject 用例覆盖不到。
  it.each(['cloud', 'local', 'signed-out'] as const)('waits for stable %s after a pending initialize response', async (mode) => {
    let push!: (state: AuthState) => void;
    mocks.service.onAuthStateChange.mockImplementation((listener) => {
      push = listener;
      return () => {};
    });
    mocks.service.initialize.mockResolvedValue({ ...signedOut, ownerBoundaryPending: true });
    const hook = renderHook(() => useAuth(), { wrapper: AuthProvider });
    await act(async () => {});
    expect(hook.result.current.isInitializing).toBe(true);
    expect(hook.result.current.ownerBoundaryPending).toBe(true);
    const stable = { ...signedOut, mode, ownerGeneration: 2,
      dataOwnerId: mode === 'signed-out' ? null : 'owner', canEnterApp: mode !== 'signed-out' };
    act(() => push(stable));
    expect(hook.result.current.isInitializing).toBe(false);
    expect(hook.result.current.ownerBoundaryPending).toBe(false);
    // 运行期边界继续安全等待，但不重播首次初始化。
    act(() => push({ ...signedOut, ownerGeneration: 2, ownerBoundaryPending: true }));
    expect(hook.result.current.ownerBoundaryPending).toBe(true);
    expect(hook.result.current.isInitializing).toBe(false);
  });

  it.each(['resolve', 'reject'] as const)('does not finish a newer pending push when old initialize %ss', async (completion) => {
    let push!: (state: AuthState) => void;
    let resolve!: (state: AuthState) => void;
    let reject!: (error: Error) => void;
    mocks.service.onAuthStateChange.mockImplementation((listener) => {
      push = listener;
      return () => {};
    });
    mocks.service.initialize.mockReturnValue(new Promise<AuthState>((done, fail) => {
      resolve = done;
      reject = fail;
    }));
    const hook = renderHook(() => useAuth(), { wrapper: AuthProvider });
    act(() => push({ ...signedOut, ownerBoundaryPending: true }));
    await act(async () => {
      if (completion === 'resolve') resolve(signedOut);
      else reject(new Error('old initialization failed'));
    });
    expect(hook.result.current.isInitializing).toBe(true);
    expect(hook.result.current.ownerBoundaryPending).toBe(true);
    act(() => push({ ...signedOut, ownerGeneration: 2 }));
    expect(hook.result.current.isInitializing).toBe(false);
    hook.unmount();
    expect(mocks.service.dispose).not.toHaveBeenCalled();
  });
});

describe('login recovery ignores abandoned IPC results', () => {
  // 2026-10-20 黑盒验收：同一分享在换账号后残留上一成员的模型。
  // 缓存测试未覆盖真实 AuthProvider 边界及已挂载的选择器；tier: unit。
  it('clears mounted remote model lists at the logout boundary', async () => {
    mocks.service.initialize.mockResolvedValue({
      isAuthenticated: true, isCanary: false, dataOwnerId: 'member-a', ownerGeneration: 1,
      deviceId: 'device', user: { id: 'member-a', name: 'Member A' },
    });
    const auth = renderHook(() => useAuth(), { wrapper: AuthProvider });
    await waitFor(() => expect(auth.result.current.isInitializing).toBe(false));
    Object.assign(window.electronAPI, { deviceLink: { invoke: vi.fn(async (_device: string, channel: string) => (
      channel === 'maker:provider:list'
        ? { providers: [{ id: 'openai', name: 'OpenAI', agents: ['codex'], connected: true,
            models: { codex: [{ id: 'member-a', name: 'Member A', contextWindow: 200000, efforts: [] }] } }] }
        : { availableModels: [{ id: 'member-a', displayName: 'Member A', contextWindow: 200000,
            efforts: [], defaultEffort: null }], hasFastMode: false, effortLevels: [], permissionModes: [] }
    )) } });
    await Promise.all([prefetchDeviceProviders('share:common'), prefetchDeviceCapabilities('share:common')]);
    const catalog = renderHook(() => ({
      providers: useDeviceProviders('share:common'),
      capabilities: useAgentCapabilities('codex', 'share:common'),
    }));
    expect(catalog.result.current.providers.providers).toHaveLength(1);
    expect(catalog.result.current.capabilities.capabilities?.availableModels[0].id).toBe('member-a');
    await act(async () => { await auth.result.current.logout(); });
    expect(mocks.service.logout).toHaveBeenCalledOnce();
    expect(catalog.result.current.providers.providers).toEqual([]);
    expect(catalog.result.current.capabilities.capabilities).toBeNull();
  });

  it.each(['resolve', 'reject'] as const)(
    'recovers a failed skip while the abandoned provider request later %ss',
    async (settlement) => {
      mocks.service.initialize.mockResolvedValue({ isAuthenticated: false, isCanary: false });
      let finishLoad!: (result: DesktopLoginActionResult) => void;
      let failLoad!: (error: Error) => void;
      mocks.service.getLoginState.mockReturnValueOnce(new Promise((resolve, reject) => {
        finishLoad = resolve;
        failLoad = reject;
      }));
      const hook = renderHook(() => ({ auth: useAuth(), login: useLogin() }), {
        wrapper: AuthProvider,
      });
      await waitFor(() => expect(hook.result.current.auth.isInitializing).toBe(false));
      expect(hook.result.current.login.isLoading).toBe(true);
      mocks.service.enterLocalMode.mockRejectedValueOnce(new Error('IPC unavailable'));
      await act(async () => {
        await expect(hook.result.current.login.enterLocalMode()).rejects.toThrow('IPC unavailable');
      });
      expect(hook.result.current.auth.loginState).toEqual({
        step: 'error', code: 'AUTH_REQUEST_FAILED', recoverTo: 'identifier',
      });
      expect(hook.result.current.login.isLoading).toBe(false);

      let finishRetry!: (result: DesktopLoginActionResult) => void;
      mocks.service.dispatchLoginAction.mockReturnValueOnce(new Promise((resolve) => {
        finishRetry = resolve;
      }));
      let retry!: Promise<boolean>;
      act(() => { retry = hook.result.current.login.dispatch({ type: 'reset' }); });
      await act(async () => {
        if (settlement === 'resolve') finishLoad({ success: true, state: { step: 'entry' } });
        else failLoad(new Error('late failure'));
      });
      expect(hook.result.current.auth.loginState?.step).toBe('error');
      expect(hook.result.current.login.errorCode).toBeNull();
      expect(hook.result.current.login.isLoading).toBe(true);
      await act(async () => {
        finishRetry({ success: true, state: { step: 'entry' } });
        await retry;
      });
      expect(hook.result.current.auth.loginState?.step).toBe('entry');
      expect(hook.result.current.login.isLoading).toBe(false);
    },
  );

  it.each(['load', 'reset', 'add-account'] as const)(
    'keeps the entry and the new loading state when an earlier %s finishes',
    async (kind) => {
      mocks.service.initialize.mockResolvedValue({ isAuthenticated: false, isCanary: false });
      const hook = renderHook(() => ({ auth: useAuth(), login: useLogin({ autoLoad: false }) }), {
        wrapper: AuthProvider,
      });
      await waitFor(() => expect(hook.result.current.auth.isInitializing).toBe(false));
      let finishOld!: (result: DesktopLoginActionResult) => void;
      const old = new Promise<DesktopLoginActionResult>((resolve) => {
        finishOld = resolve;
      });
      const service =
        kind === 'load'
          ? mocks.service.getLoginState
          : kind === 'add-account'
            ? mocks.service.beginAddAccount
            : mocks.service.dispatchLoginAction;
      service.mockReturnValueOnce(old);
      let oldAction!: Promise<unknown>;
      act(() => {
        oldAction =
          kind === 'load'
            ? hook.result.current.auth.loadLoginState()
            : kind === 'add-account'
              ? hook.result.current.auth.beginAddAccount()
              : hook.result.current.login.dispatch({ type: 'reset' });
      });
      mocks.service.dispatchLoginAction.mockResolvedValueOnce({
        success: true,
        state: { step: 'entry' },
      });
      await act(async () => {
        await hook.result.current.login.dispatch({ type: 'back' });
      });
      expect(hook.result.current.auth.loginState).toEqual({ step: 'entry' });
      expect(hook.result.current.login.isLoading).toBe(false);

      let finishNext!: (result: DesktopLoginActionResult) => void;
      mocks.service.dispatchLoginAction.mockReturnValueOnce(
        new Promise((resolve) => {
          finishNext = resolve;
        }),
      );
      let nextAction!: Promise<boolean>;
      act(() => {
        nextAction = hook.result.current.login.dispatch({ type: 'reset' });
      });
      await act(async () => {
        finishOld({
          success: false,
          code: 'REQUEST_TIMEOUT',
          state: { step: 'error', code: 'REQUEST_TIMEOUT', recoverTo: 'identifier' },
        });
        await oldAction;
      });
      expect(hook.result.current.auth.loginState).toEqual({ step: 'entry' });
      expect(hook.result.current.login.errorCode).toBeNull();
      expect(hook.result.current.login.isLoading).toBe(true);
      await act(async () => {
        finishNext({ success: true, state: { step: 'entry' } });
        await nextAction;
      });
      expect(hook.result.current.login.isLoading).toBe(false);
    },
  );

  it('does not reopen add-account login after it was closed', async () => {
    mocks.service.initialize.mockResolvedValue({ isAuthenticated: false, isCanary: false });
    const hook = renderHook(() => useAuth(), { wrapper: AuthProvider });
    await waitFor(() => expect(hook.result.current.isInitializing).toBe(false));
    let finish!: (result: DesktopLoginActionResult) => void;
    mocks.service.beginAddAccount.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    let begin!: Promise<DesktopLoginActionResult>;
    act(() => {
      begin = hook.result.current.beginAddAccount();
    });
    await act(async () => {
      await hook.result.current.cancelAddAccount();
    });
    await act(async () => {
      finish({
        success: false,
        code: 'REQUEST_TIMEOUT',
        state: { step: 'error', code: 'REQUEST_TIMEOUT', recoverTo: 'identifier' },
      });
      await begin;
    });
    expect(hook.result.current.loginState).toBeNull();
  });

  it('preserves a usable form when skipping fails and ignores a superseded skip failure', async () => {
    mocks.service.initialize.mockResolvedValue({ isAuthenticated: false, isCanary: false });
    const hook = renderHook(() => useAuth(), { wrapper: AuthProvider });
    await waitFor(() => expect(hook.result.current.isInitializing).toBe(false));
    const form = { step: 'verification-code', kind: 'email', identifier: 'test@example.invalid' } as const;
    mocks.service.dispatchLoginAction.mockResolvedValueOnce({ success: true, state: form });
    await act(async () => { await hook.result.current.dispatchLoginAction({ type: 'reset' }); });
    mocks.service.enterLocalMode.mockRejectedValueOnce(new Error('skip failed'));
    await act(async () => {
      await expect(hook.result.current.enterLocalMode()).rejects.toThrow('skip failed');
    });
    expect(hook.result.current.loginState).toEqual(form);

    let failSkip!: (error: Error) => void;
    mocks.service.enterLocalMode.mockReturnValueOnce(new Promise((_, reject) => { failSkip = reject; }));
    let skip!: Promise<void>;
    act(() => { skip = hook.result.current.enterLocalMode(); });
    await act(async () => { await hook.result.current.cancelAddAccount(); });
    await act(async () => {
      failSkip(new Error('old skip failed'));
      await expect(skip).rejects.toThrow('old skip failed');
    });
    expect(hook.result.current.loginState).toBeNull();
  });
});

describe('AuthContext initialize .catch 归一未登录', () => {
  it.each(['load', 'add-account', 'dispatch'] as const)(
    'keeps Retry-After with the %s result through retries, success, rejection and cancellation',
    async (entry) => {
      mocks.service.initialize.mockResolvedValue({ isAuthenticated: false, isCanary: false });
      const failure: DesktopLoginActionResult = {
        success: false,
        code: 'RATE_LIMITED',
        retryAt: 1_800_000_000_000,
        state: { step: 'error', code: 'RATE_LIMITED', recoverTo: 'identifier' },
      };
      const result = renderHook(
        () => ({
          auth: useAuth(),
          login: useLogin({ autoLoad: false }),
        }),
        { wrapper: AuthProvider },
      );
      await waitFor(() => expect(result.result.current.auth.isInitializing).toBe(false));
      const invoke = () =>
        entry === 'load'
          ? result.result.current.auth.loadLoginState()
          : entry === 'add-account'
            ? result.result.current.auth.beginAddAccount()
            : result.result.current.login.dispatch({ type: 'reset' });
      const service =
        entry === 'load'
          ? mocks.service.getLoginState
          : entry === 'add-account'
            ? mocks.service.beginAddAccount
            : mocks.service.dispatchLoginAction;
      service.mockResolvedValue(failure);
      await act(async () => {
        await invoke();
      });
      expect(result.result.current.login.retryAt).toBe(failure.retryAt);
      // A renderer reload receives main's already-cached screen as success,
      // with no top-level error envelope. It must preserve the original deadline.
      mocks.service.getLoginState.mockResolvedValue({
        success: true,
        state: { ...failure.state!, retryAt: failure.retryAt },
      });
      await act(async () => {
        await result.result.current.auth.loadLoginState();
      });
      expect(result.result.current.login.retryAt).toBe(failure.retryAt);
      // A later response with no header must not inherit the earlier deadline.
      service.mockResolvedValue({ ...failure, retryAt: undefined });
      await act(async () => {
        await invoke();
      });
      expect(result.result.current.login.retryAt).toBeUndefined();
      service.mockResolvedValue(failure);
      await act(async () => {
        await invoke();
      });
      mocks.service.dispatchLoginAction.mockResolvedValue({
        success: false,
        code: 'CREDENTIAL_STORE_UNAVAILABLE',
        state: { step: 'error', code: 'CREDENTIAL_STORE_UNAVAILABLE', recoverTo: 'identifier' },
      });
      await act(async () => {
        await result.result.current.login.dispatch({ type: 'reset' });
      });
      expect(result.result.current.login.retryAt).toBeUndefined();
      service.mockResolvedValue(failure);
      await act(async () => {
        await invoke();
      });
      mocks.service.dispatchLoginAction.mockResolvedValue({
        success: true,
        state: { step: 'browser-redirect', label: 'Example SSO' },
      });
      await act(async () => {
        await result.result.current.login.dispatch({ type: 'reset' });
      });
      expect(result.result.current.login.retryAt).toBeUndefined();
      service.mockResolvedValue(failure);
      await act(async () => {
        await invoke();
      });
      mocks.service.dispatchLoginAction.mockRejectedValueOnce(new Error('IPC unavailable'));
      await act(async () => {
        await result.result.current.login.dispatch({ type: 'reset' });
      });
      expect(result.result.current.login.retryAt).toBeUndefined();
      service.mockResolvedValue(failure);
      await act(async () => {
        await invoke();
      });
      await act(async () => {
        await result.result.current.auth.cancelAddAccount();
      });
      expect(result.result.current.auth.loginState).toBeNull();
      expect(result.result.current.login.retryAt).toBeUndefined();
    },
  );

  it('service.initialize 真实 reject → 无 unhandled rejection,统一 logger 记录,落 unauthenticated snapshot', async () => {
    const boom = new Error('main auth channel exploded');
    mocks.service.initialize.mockRejectedValue(boom);

    render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>,
    );
    // 冲刷 initialize reject → catch → finally 微任务链 + 潜在的延迟 unhandled 通知
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // 归一未登录:isInitializing=false(finally 仍执行)、未登录、无用户、loginState 清空
    expect(screen.getByTestId('auth-probe').textContent).toBe(
      'init=false;authed=false;user=null;login=null',
    );
    // 统一 logger 记录(不新增视觉分支)
    expect(mocks.logError).toHaveBeenCalled();
    expect(mocks.logError.mock.calls[0].some((arg) => arg === boom)).toBe(true);
    // 无 unhandled rejection
    expect(mocks.unhandled).toEqual([]);
  });

  it('initialize resolve 正常路径不受影响(catch 不吞正常快照)', async () => {
    mocks.service.initialize.mockResolvedValue({
      isAuthenticated: true,
      isCanary: false,
      deviceId: 'd1',
      user: { id: 'u1', name: 'Tester' },
    });
    render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByTestId('auth-probe').textContent).toBe(
      'init=false;authed=true;user=u1;login=null',
    );
    expect(mocks.logError).not.toHaveBeenCalled();
  });
});
