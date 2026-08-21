// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loginHook = vi.hoisted(() => ({
  dispatch: vi.fn(),
  dispatchWithResult: vi.fn(),
  value: {
    isLoading: false,
    errorCode: null,
    loginState: { step: 'browser-redirect' as const, label: 'Google' },
    dispatch: vi.fn(),
    dispatchWithResult: vi.fn(),
    clearError: vi.fn(),
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/hooks/useBrandLogo', () => ({
  useBrandLogo: () => 'brand-logo.svg',
}));

vi.mock('@/hooks/useLogin', () => ({
  useLogin: () => loginHook.value,
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ mode: 'signed-out', enterLocalMode: vi.fn() }),
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
}));

vi.mock('@/components/title-bar/WindowControls', () => ({
  WindowControls: () => null,
}));

import { LoginPage } from '../LoginPage';

describe('LoginPage browser redirect waiting state', () => {
  beforeEach(() => {
    loginHook.dispatch = vi.fn().mockResolvedValue(true);
    loginHook.dispatchWithResult = vi.fn().mockResolvedValue({ success: true, code: null });
    loginHook.value = {
      isLoading: false,
      errorCode: null,
      loginState: { step: 'browser-redirect', label: 'Google' },
      dispatch: loginHook.dispatch,
      dispatchWithResult: loginHook.dispatchWithResult,
      clearError: vi.fn(),
    };
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { platform: 'darwin' },
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('keeps an animated progress indicator visible until browser authentication settles', () => {
    render(<LoginPage />);

    const progress = screen.getByRole('status', { name: 'login.working' });
    expect(progress.className).toContain('animate-spin');
    expect(screen.getByText('login.browserWaiting')).toBeTruthy();
    expect(screen.getByText('Google')).toBeTruthy();
  });

  it('still lets the user cancel the pending browser login', () => {
    render(<LoginPage />);

    fireEvent.click(screen.getByRole('button', { name: 'login.cancel' }));
    expect(loginHook.dispatch).toHaveBeenCalledWith({ type: 'cancel-browser' });
  });

  it('keeps the local-mode entry available on an authentication error screen', () => {
    loginHook.value = {
      isLoading: false,
      errorCode: 'NETWORK_ERROR',
      loginState: { step: 'error', code: 'NETWORK_ERROR', recoverTo: 'identifier' },
      dispatch: loginHook.dispatch,
      clearError: vi.fn(),
    } as unknown as typeof loginHook.value;

    render(<LoginPage />);

    expect(screen.getByRole('button', { name: 'login.localModeEntry' })).toBeTruthy();
    expect(screen.getByText('login.localModeDescription')).toBeTruthy();
  });

  it('disables local entry while a login request is pending', () => {
    loginHook.value = {
      isLoading: true,
      errorCode: null,
      loginState: { step: 'error', code: 'NETWORK_ERROR', recoverTo: 'identifier' },
      dispatch: loginHook.dispatch,
      clearError: vi.fn(),
    } as unknown as typeof loginHook.value;

    render(<LoginPage />);

    expect(
      (screen.getByRole('button', { name: 'login.localModeEntry' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});
