// @vitest-environment jsdom

import { useState } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { CindyAuthClient, reduceAuthFlow, type AuthFlowState } from '@cindy/auth-client';
import { createScenarioFetch } from '@cindy/auth-client/fixtures';
import type { DesktopLoginActionResult } from '../../../../shared/authIpc';

const auth = vi.hoisted(() => ({
  value: {} as Record<string, unknown>,
  loadLoginState: vi.fn<() => Promise<DesktopLoginActionResult>>(),
  beginAddAccount: vi.fn<() => Promise<DesktopLoginActionResult>>(),
  cancelAddAccount: vi.fn(async () => undefined),
}));

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth.value }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/components/title-bar/WindowControls', () => ({ WindowControls: () => null }));
vi.mock('@/components/sidebar/AccountSwitcherDialog', () => ({
  AccountSwitcherDialog: () => null,
}));

import { AppShellCoverProvider } from '@/contexts/AppShellCoverContext';
import { AddAccountLoginPage } from '../AddAccountLoginPage';
import { LoginPage } from '../LoginPage';

let identifierState: AuthFlowState;
let publishState: (state: AuthFlowState | null) => void;
let epoch: number;

function Harness({ addAccount = false }: { addAccount?: boolean }) {
  const [loginState, setLoginState] = useState<AuthFlowState | null>(null);
  publishState = setLoginState;
  auth.value = {
    loginState,
    loadLoginState: auth.loadLoginState,
    beginAddAccount: auth.beginAddAccount,
    cancelAddAccount: auth.cancelAddAccount,
  };
  return (
    <AppShellCoverProvider>
      <MemoryRouter>{addAccount ? <AddAccountLoginPage /> : <LoginPage />}</MemoryRouter>
    </AppShellCoverProvider>
  );
}

beforeEach(async () => {
  epoch = 0;
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { platform: 'darwin' },
  });
  const providers = await new CindyAuthClient({
    baseUrl: 'https://auth.scenario.invalid',
    region: 'global',
    deviceId: 'login-initialization-test',
    clientType: 'desktop',
    fetch: createScenarioFetch('providers:both', { region: 'global' })!,
  }).getProviders();
  identifierState = reduceAuthFlow(null, { type: 'providers-loaded', providers });

  // Model main's epoch contract: beginAddAccount invalidates any earlier provider load.
  auth.loadLoginState.mockImplementation(async () => {
    const loadEpoch = epoch;
    await Promise.resolve();
    publishState(identifierState);
    return loadEpoch === epoch
      ? { success: true, state: identifierState }
      : { success: false, code: 'AUTH_FLOW_SUPERSEDED', state: identifierState };
  });
  auth.beginAddAccount.mockImplementation(async () => {
    epoch += 1;
    await Promise.resolve();
    publishState(identifierState);
    return { success: true, state: identifierState };
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('login initialization ownership', () => {
  it('opens add-account login without an invalidated load or a false failure', async () => {
    render(<Harness addAccount />);

    await screen.findByTestId('login-panel-identifier');
    await waitFor(() => expect(auth.beginAddAccount).toHaveBeenCalledOnce());
    expect(screen.queryByTestId('login-error-text')).toBeNull();
    expect(auth.loadLoginState).not.toHaveBeenCalled();
    expect(screen.getByTestId('login-input').getAttribute('style')).not.toContain(
      'var(--login-error-fg)',
    );
  });

  it('still initializes ordinary sign-in automatically', async () => {
    render(<Harness />);

    await screen.findByTestId('login-panel-identifier');
    expect(auth.loadLoginState).toHaveBeenCalledOnce();
    expect(auth.beginAddAccount).not.toHaveBeenCalled();
    expect(screen.queryByTestId('login-error-text')).toBeNull();
  });

  it('preserves the retry screen when add-account initialization actually fails', async () => {
    auth.beginAddAccount.mockImplementation(async () => {
      const state: AuthFlowState = {
        step: 'error',
        code: 'AUTH_SERVICE_UNAVAILABLE',
        recoverTo: 'identifier',
      };
      publishState(state);
      return { success: false, code: state.code, state };
    });
    render(<Harness addAccount />);

    await screen.findByTestId('login-panel-error');
    expect(screen.getByTestId('login-error-retry')).toBeTruthy();
    expect(screen.getByTestId('login-error-text').textContent).toBe(
      'login.errors.AUTH_SERVICE_UNAVAILABLE',
    );
    expect(auth.loadLoginState).not.toHaveBeenCalled();
  });
});
