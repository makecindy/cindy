// @vitest-environment jsdom

import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import type { DesktopLoginActionResult } from '@/lib/authService';
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
    onAuthStateChange: vi.fn(() => () => {}),
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

describe('login recovery ignores abandoned IPC results', () => {
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
