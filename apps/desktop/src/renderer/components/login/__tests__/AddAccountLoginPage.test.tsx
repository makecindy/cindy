// @vitest-environment jsdom

import { StrictMode, useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, useLocation } from 'react-router-dom';

const auth = vi.hoisted(() => ({
  isInitializing: false,
  canEnterApp: true,
  loginState: { step: 'identifier' },
  beginAddAccount: vi.fn(async () => ({
    success: true,
    state: { step: 'identifier' },
  })),
  cancelAddAccount: vi.fn(async () => undefined),
}));

const translate = (key: string) => key;
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: translate }),
}));

vi.mock('@/lib/toast', () => ({
  toast: { loading: vi.fn(() => 'login-progress'), dismiss: vi.fn(), error: vi.fn() },
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => auth,
}));

vi.mock('@/lib/secondaryWindow', () => ({
  isSecondaryWindow: () => false,
}));
vi.mock('@/lib/sidebarWindow', () => ({
  isSidebarWindow: () => false,
}));
vi.mock('@/lib/ghostPanelWindow', () => ({
  isGhostPanelWindow: () => false,
}));

vi.mock('../LoginPage', () => ({
  LoginPage: ({ onClose }: { onClose?: () => void }) => (
    <button type="button" onClick={onClose}>
      close add-account login
    </button>
  ),
}));

import { AppShellCoverProvider, useAppShellCover } from '@/contexts/AppShellCoverContext';
import { AddAccountLoginPage } from '../AddAccountLoginPage';
import { toast } from '@/lib/toast';

function CoverProbe() {
  const { coverHeld, localDbGateStatus } = useAppShellCover();
  return (
    <output data-testid="cover-state">
      {coverHeld ? 'held' : 'open'}:{localDbGateStatus}
    </output>
  );
}

function LocationProbe() {
  return <output data-testid="location-probe">{useLocation().pathname}</output>;
}

function Harness() {
  const [showAddAccount, setShowAddAccount] = useState(true);
  return (
    <AppShellCoverProvider>
      <MemoryRouter
        initialEntries={[{ pathname: '/add-account', state: { returnTo: '/settings' } }]}
      >
        {showAddAccount ? <AddAccountLoginPage /> : null}
        <CoverProbe />
        <LocationProbe />
        <button type="button" onClick={() => setShowAddAccount(false)}>
          leave route
        </button>
      </MemoryRouter>
    </AppShellCoverProvider>
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  auth.beginAddAccount.mockReset();
  auth.beginAddAccount.mockResolvedValue({
    success: true,
    state: { step: 'identifier' },
  });
  auth.cancelAddAccount.mockReset();
  auth.cancelAddAccount.mockResolvedValue(undefined);
  auth.loginState = { step: 'identifier' };
});

describe('AddAccountLoginPage app-shell cover', () => {
  it.each(['success', 'failure'] as const)(
    'keeps progress until initialization settles with %s',
    async (outcome) => {
      let resolve!: (value: { success: boolean; state: { step: string } }) => void;
      let reject!: (error: Error) => void;
      auth.beginAddAccount.mockReturnValueOnce(
        new Promise((res, rej) => {
          resolve = res;
          reject = rej;
        }),
      );
      render(<Harness />);
      expect(toast.loading).toHaveBeenCalledWith('sidebar.accountSwitcher.adding');
      expect(toast.dismiss).not.toHaveBeenCalled();
      await act(async () => {
        if (outcome === 'success') resolve({ success: true, state: { step: 'identifier' } });
        else reject(new Error('initialization failed'));
      });
      expect(toast.dismiss).toHaveBeenCalledWith('login-progress');
      if (outcome === 'failure') {
        expect(toast.error).toHaveBeenCalledWith('sidebar.accountSwitcher.startFailed');
        expect(screen.getByTestId('location-probe').textContent).toBe('/settings');
      }
    },
  );

  it('cleans up pending progress on exit and keeps it visible after StrictMode replay', async () => {
    let resolve!: (value: { success: boolean; state: { step: string } }) => void;
    auth.beginAddAccount.mockReturnValueOnce(
      new Promise((res) => {
        resolve = res;
      }),
    );
    render(
      <StrictMode>
        <Harness />
      </StrictMode>,
    );
    expect(auth.beginAddAccount).toHaveBeenCalledOnce();
    expect(toast.loading).toHaveBeenCalledTimes(2);
    expect(toast.dismiss).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'leave route' }));
    expect(toast.dismiss).toHaveBeenCalledTimes(2);
    await act(async () => {
      resolve({ success: true, state: { step: 'identifier' } });
    });
    expect(toast.loading).toHaveBeenCalledTimes(2);
  });

  it('releases a freshly reset cover and cancels the flow when leaving', async () => {
    render(<Harness />);

    expect(screen.getByTestId('cover-state').textContent).toBe('open:ready');

    fireEvent.click(screen.getByRole('button', { name: 'leave route' }));
    expect(screen.getByTestId('cover-state').textContent).toBe('held:pending');
    await waitFor(() => expect(auth.cancelAddAccount).toHaveBeenCalledOnce());
  });

  it('cancels the add-account flow from the close action', async () => {
    render(<Harness />);

    fireEvent.click(screen.getByRole('button', { name: 'close add-account login' }));
    await waitFor(() => expect(auth.cancelAddAccount).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByTestId('location-probe').textContent).toBe('/settings'));
  });

  it('starts a fresh flow before honoring a stale completed state', async () => {
    auth.loginState = { step: 'completed' };
    auth.beginAddAccount.mockImplementation(async () => {
      auth.loginState = { step: 'identifier' };
      return { success: true, state: auth.loginState };
    });

    render(<Harness />);

    await waitFor(() => expect(auth.beginAddAccount).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(screen.getByTestId('location-probe').textContent).toBe('/add-account'),
    );
  });
});
