// @vitest-environment jsdom

import { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

const auth = vi.hoisted(() => ({
  isInitializing: false,
  canEnterApp: true,
  loginState: { step: 'identifier' },
  beginAddAccount: vi.fn(),
  cancelAddAccount: vi.fn(),
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

function Harness() {
  const [showAddAccount, setShowAddAccount] = useState(true);
  return (
    <AppShellCoverProvider>
      <MemoryRouter initialEntries={['/add-account']}>
        {showAddAccount ? <AddAccountLoginPage /> : null}
        <CoverProbe />
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
  auth.cancelAddAccount.mockReset();
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
});
