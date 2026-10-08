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
