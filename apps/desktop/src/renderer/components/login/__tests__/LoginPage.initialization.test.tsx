// @vitest-environment jsdom

import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { CindyAuthClient, reduceAuthFlow, type AuthFlowState } from '@cindy/auth-client';
import { createScenarioFetch } from '@cindy/auth-client/fixtures';
import type {
  DesktopLoginAction,
  DesktopLoginActionResult,
  DesktopLoginState,
} from '../../../../shared/authIpc';
import {
  HOST_START_FAILURE_REASONS,
  hostStartFailureMessageKeys,
  type HostStartFailureReason,
} from '../../../../shared/hostStartFailure';

const auth = vi.hoisted(() => ({
  value: {} as Record<string, unknown>,
  loadLoginState: vi.fn<() => Promise<DesktopLoginActionResult>>(),
  beginAddAccount: vi.fn<() => Promise<DesktopLoginActionResult>>(),
  cancelAddAccount: vi.fn(async () => undefined),
  enterLocalMode: vi.fn(async () => undefined),
  acceptPrivacyConsent: vi.fn(async () => undefined),
  dispatchLoginAction: vi.fn<(action: DesktopLoginAction) => Promise<DesktopLoginActionResult>>(),
}));

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth.value }));
vi.mock('@/contexts/EnvCheckContext', () => ({
  useEnvCheck: () => ({ status: 'passed' }),
}));
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
let publishState: (state: DesktopLoginState | null) => void;
let epoch: number;

function Harness({
  addAccount = false,
  credentialStoreUnavailable = false,
  hostUnavailableReason,
  initialState = null,
}: {
  addAccount?: boolean;
  credentialStoreUnavailable?: boolean;
  /** Left undefined as before this field existed: the context of a desktop that does not serve a Host. */
  hostUnavailableReason?: HostStartFailureReason | null;
  initialState?: DesktopLoginState | null;
}) {
  const [loginState, setLoginState] = useState<DesktopLoginState | null>(initialState);
  publishState = setLoginState;
  auth.value = {
    loginState,
    credentialStoreUnavailable,
    ...(hostUnavailableReason !== undefined
      ? { hostUnavailableReason }
      : {}),
    loadLoginState: auth.loadLoginState,
    beginAddAccount: auth.beginAddAccount,
    cancelAddAccount: auth.cancelAddAccount,
    enterLocalMode: auth.enterLocalMode,
    dispatchLoginAction: auth.dispatchLoginAction,
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
    value: { platform: 'darwin', acceptPrivacyConsent: auth.acceptPrivacyConsent },
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
  it.each([null, { step: 'entry' } as const])(
    'shows known credential recovery before a login response arrives from %j',
    (initialState) => {
      auth.loadLoginState.mockImplementation(() => new Promise(() => undefined));
      render(<Harness credentialStoreUnavailable initialState={initialState} />);

      expect(screen.getByTestId('login-panel-error')).toBeTruthy();
      expect(screen.getByText('credentialStore.dialog.title')).toBeTruthy();
      expect(screen.queryByTestId('login-panel-preparing')).toBeNull();
      expect(screen.queryByTestId('login-panel-entry')).toBeNull();
      expect(screen.queryByTestId('login-local-mode')).toBeNull();
      expect(auth.enterLocalMode).not.toHaveBeenCalled();
      expect(auth.acceptPrivacyConsent).not.toHaveBeenCalled();
    },
  );

  it('withdraws pending skip consent when credential health fails before the login response', () => {
    auth.loadLoginState.mockImplementation(() => new Promise(() => undefined));
    const view = render(<Harness />);
    fireEvent.click(screen.getByTestId('login-local-mode'));
    expect(screen.getByTestId('login-consent-dialog')).toBeTruthy();

    view.rerender(<Harness credentialStoreUnavailable />);

    expect(screen.getByTestId('login-panel-error')).toBeTruthy();
    expect(screen.queryByTestId('login-consent-dialog')).toBeNull();
    expect(screen.queryByTestId('login-local-mode')).toBeNull();
    expect(auth.enterLocalMode).not.toHaveBeenCalled();
    expect(auth.acceptPrivacyConsent).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'leaves an initialization error without requesting providers (addAccount=%s)',
    async (addAccount) => {
      const initialize = addAccount ? auth.beginAddAccount : auth.loadLoginState;
      initialize.mockImplementation(async () => {
        const state: AuthFlowState = {
          step: 'error',
          code: 'REGION_MISMATCH',
          recoverTo: 'identifier',
        };
        publishState(state);
        return { success: false, code: state.code, state };
      });
      // Navigation remains local even though no provider config was loaded.
      auth.dispatchLoginAction.mockImplementation(async (action) => {
        if (action.type !== 'back') throw new Error('back must not retry');
        const state = { step: 'entry' } as const;
        publishState(state);
        return { success: true, state };
      });
      render(<Harness addAccount={addAccount} />);

      await screen.findByTestId('login-panel-error');
      const back = screen.getByRole('button', { name: 'login.back' }) as HTMLButtonElement;
      await waitFor(() => expect(back.disabled).toBe(false));
      expect(screen.getByTestId('login-error-retry')).toBeTruthy();

      fireEvent.click(back);

      if (addAccount) {
        await waitFor(() => expect(auth.cancelAddAccount).toHaveBeenCalledOnce());
        expect(auth.dispatchLoginAction).not.toHaveBeenCalled();
        return;
      }
      await screen.findByTestId('login-panel-entry');
      expect(screen.getByTestId('login-entry-continue')).toBeTruthy();
      expect(screen.queryByTestId('login-panel-error')).toBeNull();
      expect(screen.queryByTestId('login-error-text')).toBeNull();
      expect(screen.queryByTestId('login-error-retry')).toBeNull();
      expect(auth.dispatchLoginAction).toHaveBeenCalledExactlyOnceWith({ type: 'back' });
      expect(auth.cancelAddAccount).not.toHaveBeenCalled();
    },
  );

  it('allows Back and Skip Sign-In while an error retry is still pending', async () => {
    auth.loadLoginState.mockImplementation(async () => {
      const state = { step: 'error', code: 'REQUEST_TIMEOUT', recoverTo: 'identifier' } as const;
      publishState(state);
      return { success: false, code: state.code, state };
    });
    let finishRetry!: (result: DesktopLoginActionResult) => void;
    auth.dispatchLoginAction.mockImplementation(async (action) => {
      if (action.type === 'back') {
        const state = { step: 'entry' } as const;
        publishState(state);
        return { success: true, state };
      }
      return new Promise((resolve) => {
        finishRetry = resolve;
      });
    });
    render(<Harness />);
    await waitFor(() =>
      expect((screen.getByTestId('login-error-retry') as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(screen.getByTestId('login-error-retry'));
    expect((screen.getByTestId('login-error-retry') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('login-back-button') as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByTestId('login-local-mode') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByTestId('login-back-button'));
    await screen.findByTestId('login-panel-entry');
    await act(async () => finishRetry({ success: false, code: 'REQUEST_TIMEOUT', state: null }));
    expect(screen.queryByTestId('login-error-text')).toBeNull();
    expect((screen.getByTestId('login-entry-continue') as HTMLButtonElement).disabled).toBe(false);
    expect(auth.loadLoginState).toHaveBeenCalledOnce();
    expect(auth.dispatchLoginAction.mock.calls.map(([action]) => action.type)).toEqual([
      'reset',
      'back',
    ]);
  });

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

/*
 * Test value (unit, real LoginPage + useLogin): client mode, the Host serving this window did not start
 * (release table 甲, 2026-11-17). Before this, the window showed the ordinary sign-in form, whose sign-in
 * and Skip Sign-In run in the window itself: the testing-period limit's "do not" path (a local session,
 * saved accounts and owner beside a Host that stays down). Minimal input: a context with or without the
 * Host's reason. Rule: the reason shows the shared error panel and no form or Skip Sign-In; without it
 * (every desktop that does not serve a Host) nothing changes.
 */
describe('login while the Host serving this window did not start', () => {
  it('keeps the sign-in form and Skip Sign-In when the context has no Host reason', async () => {
    render(<Harness />);

    await screen.findByTestId('login-panel-identifier');
    expect(screen.getByTestId('login-input')).toBeTruthy();
    expect(screen.getByTestId('login-skip-entry')).toBeTruthy();
    expect(screen.queryByTestId('login-panel-host-unavailable')).toBeNull();
  });

  it.each(HOST_START_FAILURE_REASONS)('shows why for %s, with no sign-in form or Skip Sign-In', async (reason) => {
    render(<Harness hostUnavailableReason={reason} />);

    const panel = await screen.findByTestId('login-panel-host-unavailable');
    const { body, action } = hostStartFailureMessageKeys(reason);
    expect(panel.textContent).toContain('login.hostUnavailable.title');
    expect(panel.textContent).toContain(body);
    if (action) expect(panel.textContent).toContain(action);
    await waitFor(() => expect(auth.loadLoginState).toHaveBeenCalled());
    expect(screen.queryByTestId('login-panel-identifier')).toBeNull();
    expect(screen.queryByTestId('login-local-mode')).toBeNull();
    expect(screen.queryByTestId('login-skip-entry')).toBeNull();

    // The panel offers nothing to press: in this state no action of the window can succeed.
    expect(within(panel).queryAllByRole('button')).toEqual([]);
    expect(auth.dispatchLoginAction).not.toHaveBeenCalled();
    expect(auth.enterLocalMode).not.toHaveBeenCalled();
  });
});
