// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import type { DesktopLoginAction } from '../../../../shared/authIpc';

// The shared error panel must present a wrong cloud-instance account as an
// account choice, not as a transient failure to retry.
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({}) }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('@/components/title-bar/WindowControls', () => ({ WindowControls: () => null }));
vi.mock('@/components/sidebar/AccountSwitcherDialog', () => ({
  AccountSwitcherDialog: () => null,
}));

import { LoginPageView } from '@/components/login/LoginPage';

const dispatch = vi.fn<(action: DesktopLoginAction) => Promise<boolean>>(async () => true);
const onClose = vi.fn();

function renderError(code: string) {
  render(
    // The cloud login window renders the login view without the app shell providers.
    <MemoryRouter>
        <LoginPageView
          intent="cloud-instance"
          targetLabel="Cloud Test"
          onClose={onClose}
          login={{
            isLoading: false,
            errorCode: code,
            retryAt: undefined,
            loginState: { step: 'error', code, recoverTo: 'identifier' },
            clearError: () => {},
            dispatch,
            dispatchWithResult: async (action) => ({ success: await dispatch(action), code: null }),
          }}
        />
    </MemoryRouter>,
  );
  return screen.getByTestId('login-panel-error');
}

beforeEach(() => {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { platform: 'darwin' },
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it('names the account mismatch once and offers another account', () => {
  const panel = renderError('LOGIN_OWNERSHIP_MISMATCH');
  expect(panel.textContent).toContain('login.ownershipMismatch.title');
  expect(panel.textContent).not.toContain('login.unavailable');
  expect(panel.textContent).not.toContain('login.errors.fallback');
  expect(panel.textContent?.split('login.errors.LOGIN_OWNERSHIP_MISMATCH')).toHaveLength(2);
  const action = screen.getByTestId('login-error-retry');
  expect(action.textContent).toBe('login.ownershipMismatch.switchAccount');
  fireEvent.click(action);
  expect(dispatch).toHaveBeenCalledWith({ type: 'reset' });
  expect(onClose).not.toHaveBeenCalled();
});

it('keeps the generic retry panel for other failures', () => {
  const panel = renderError('AUTH_LOGIN_FAILED');
  expect(panel.textContent).toContain('login.unavailable');
  expect(panel.textContent).toContain('login.errors.fallback');
  expect(screen.getByTestId('login-error-retry').textContent).toBe('login.retry');
});
