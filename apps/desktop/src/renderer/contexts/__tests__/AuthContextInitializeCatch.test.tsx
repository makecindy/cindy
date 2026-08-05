// @vitest-environment jsdom

import { act, cleanup, render, screen } from '@testing-library/react';
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
    getLoginState: vi.fn(async () => ({ ok: true, state: null })),
    dispatchLoginAction: vi.fn(async () => ({ ok: true, state: null })),
    logout: vi.fn(async () => {}),
  },
  logError: vi.fn(),
  unhandled: [] as unknown[],
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/lib/authService', () => ({ createAuthService: () => mocks.service }));
vi.mock('@/lib/makerChatStore', () => ({ setCurrentUserName: vi.fn() }));
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
