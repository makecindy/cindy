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
    logout: vi.fn(async () => undefined),
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
    canEnterApp: true,
    isAuthenticated: false,
    isCanary: false,
    deviceId: 'device',
    hasAccountDeletionReceipt: false,
    accountDeletionRestored: false,
  };
}

describe('AuthContext session cache boundaries', () => {
  const wrapper = ({ children }: PropsWithChildren) => (
    <AuthProvider>{children}</AuthProvider>
  );

  beforeEach(() => {
    mocks.reset.mockClear();
    mocks.getMe.mockClear();
    mocks.clearWorkersCache.mockClear();
    mocks.service.consumeAccountDeletionRestoredNotice.mockClear();
    restoredToast.mockClear();
    mocks.confirm.mockClear();
    mocks.service.initialize.mockResolvedValue(authState('account-a'));
    mocks.service.logout.mockResolvedValue(undefined);
    (window as unknown as { electronAPI: { onAuthSessionExpired: typeof mocks.registerExpired } }).electronAPI = {
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

    act(() => mocks.emitAuth(authState('account-b')));
    expect(mocks.reset).toHaveBeenCalledTimes(2);

    act(() => mocks.emitAuth(authState('account-b')));
    expect(mocks.reset).toHaveBeenCalledTimes(2);

    act(() => mocks.emitAuth(authState(null)));
    expect(mocks.reset).toHaveBeenCalledTimes(3);

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
