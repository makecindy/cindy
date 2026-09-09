// @vitest-environment jsdom

import { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
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
