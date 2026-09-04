// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { authState, betaChannelState, listAccounts, navigate, syncAccounts, switchAccount } =
  vi.hoisted(() => ({
    authState: {
      user: { name: 'Cindy user', avatar: null } as { name: string; avatar: string | null } | null,
      mode: 'cloud' as 'cloud' | 'local',
      dataOwnerId: 'owner-a' as string | null,
      isCanary: false,
    },
    betaChannelState: { enableBeta: false, isCustomized: false, loading: false },
    listAccounts: vi.fn(),
    navigate: vi.fn(),
    syncAccounts: vi.fn(),
    switchAccount: vi.fn(),
  }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('react-router-dom', () => ({
  useLocation: () => ({ pathname: '/', search: '' }),
  useNavigate: () => navigate,
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    ...authState,
    listAccounts,
    syncAccounts,
    switchAccount,
  }),
}));

vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useOptionalConfirmDialog: () => ({ confirm: vi.fn().mockResolvedValue(true) }),
}));

vi.mock('@/lib/makerChatStore', () => ({
  makerChatStore: { getRunningSnapshot: () => new Map() },
}));

vi.mock('@/hooks/useUpdateStatus', () => ({
  useUpdateStatus: () => ({ status: 'idle' }),
}));

vi.mock('@/hooks/useUpdateBannerDismiss', () => ({
  useUpdateBannerDismiss: () => ({ dismissed: false, restore: vi.fn() }),
}));

vi.mock('@/hooks/useBetaChannelSettings', () => ({
  useBetaChannelSettings: () => ({ state: betaChannelState }),
}));

vi.mock('@/hooks/useLogout', () => ({
  useLogout: () => ({ handleLogout: vi.fn() }),
}));

vi.mock('@/components/sidebar/MobileDownloadDialog', () => ({
  MobileDownloadDialog: ({
    open,
    remoteAvailable,
    onOpenRemoteSettings,
    onOpenDevices,
  }: {
    open: boolean;
    remoteAvailable: boolean;
    onOpenRemoteSettings: () => void;
    onOpenDevices: () => void;
  }) =>
    open ? (
      <div role="dialog">
        <span>{remoteAvailable ? 'remote available' : 'remote unavailable'}</span>
        <button type="button" onClick={onOpenRemoteSettings}>
          open remote settings
        </button>
        <button type="button" onClick={onOpenDevices}>
          open linked devices
        </button>
      </div>
    ) : null,
}));

import { UserInfoSection } from '@/components/sidebar/UserInfoSection';

beforeEach(() => {
  navigate.mockClear();
  authState.user = { name: 'Cindy user', avatar: null };
  authState.mode = 'cloud';
  authState.dataOwnerId = 'owner-a';
  listAccounts.mockReset().mockResolvedValue({
    mutationAllowed: true,
    accounts: [
      {
        accountKey: 'current',
        displayName: 'Cindy user',
        email: 'current@example.com',
        avatarUrl: null,
        kind: 'personal',
        orgName: null,
        orgLogoUrl: null,
        isCurrent: true,
      },
      {
        accountKey: 'other',
        displayName: 'Other user',
        email: 'other@example.com',
        avatarUrl: null,
        kind: 'personal',
        orgName: null,
        orgLogoUrl: null,
        isCurrent: false,
      },
    ],
  });
  syncAccounts.mockReset().mockResolvedValue({
    mutationAllowed: true,
    accounts: [
      {
        accountKey: 'current',
        displayName: 'Cindy user',
        email: 'current@example.com',
        avatarUrl: null,
        kind: 'personal',
        orgName: null,
        orgLogoUrl: null,
        isCurrent: true,
      },
      {
        accountKey: 'other',
        displayName: 'Other user',
        email: 'other@example.com',
        avatarUrl: null,
        kind: 'personal',
        orgName: null,
        orgLogoUrl: null,
        isCurrent: false,
      },
    ],
  });
  switchAccount.mockReset().mockResolvedValue(undefined);
  betaChannelState.enableBeta = false;
  betaChannelState.loading = false;
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      appDisplayVersion: '1.0.0',
      appDisplayVersionDetail: '1.0.0-test',
    },
  });
});

afterEach(cleanup);

describe('UserInfoSection mobile download entry', () => {
  it('shows the Beta label beside the expanded app version when the channel is enabled', () => {
    betaChannelState.enableBeta = true;
    render(<UserInfoSection isCollapsed={false} />);

    expect(screen.getByTestId('sidebar-beta-channel-label').textContent).toBe(
      'settings.betaChannel.badge',
    );
    expect(screen.getByRole('button', { name: 'sidebar.user.moreLabel' })).toBeTruthy();
  });

  it.each([
    ['expanded', false],
    ['collapsed', true],
  ])('opens the dialog from the %s sidebar', (_label, isCollapsed) => {
    render(<UserInfoSection isCollapsed={isCollapsed} />);

    fireEvent.click(
      screen.getByRole('button', {
        name: 'sidebar.user.downloadMobile',
      }),
    );

    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByText('remote available')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'open remote settings' }));
    expect(navigate).toHaveBeenCalledWith('/settings?tab=remote-control');
  });

  it('opens the expanded device list from the dialog', () => {
    render(<UserInfoSection isCollapsed={false} />);

    fireEvent.click(
      screen.getByRole('button', {
        name: 'sidebar.user.downloadMobile',
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'open linked devices' }));

    expect(navigate).toHaveBeenCalledWith('/settings?tab=remote-control&section=devices');
  });

  it('shows all saved accounts only in the multi-account menu and switches directly', async () => {
    render(<UserInfoSection isCollapsed={false} />);

    fireEvent.pointerDown(screen.getByRole('button', { name: 'sidebar.user.moreLabel' }), {
      button: 0,
      ctrlKey: false,
    });

    expect(await screen.findByRole('menuitem', { name: /Other user/ })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: /Cindy user/ }).getAttribute('aria-disabled')).toBe(
      'true',
    );

    fireEvent.click(screen.getByRole('menuitem', { name: /Other user/ }));
    await waitFor(() => expect(switchAccount).toHaveBeenCalledWith('other'));
  });

  it('drops the previous account menu snapshot as soon as the owner changes', async () => {
    const view = render(<UserInfoSection isCollapsed={false} />);

    fireEvent.pointerDown(screen.getByRole('button', { name: 'sidebar.user.moreLabel' }), {
      button: 0,
      ctrlKey: false,
    });
    expect(await screen.findByRole('menuitem', { name: /Other user/ })).toBeTruthy();

    authState.dataOwnerId = 'owner-b';
    view.rerender(<UserInfoSection isCollapsed={false} />);

    expect(screen.queryByRole('menuitem', { name: /Other user/ })).toBeNull();
  });

  it('does not show an account section when only one account is saved', async () => {
    listAccounts.mockResolvedValueOnce({
      mutationAllowed: true,
      accounts: [
        {
          accountKey: 'current',
          displayName: 'Cindy user',
          email: 'current@example.com',
          avatarUrl: null,
          kind: 'personal',
          orgName: null,
          orgLogoUrl: null,
          isCurrent: true,
        },
      ],
    });
    syncAccounts.mockResolvedValueOnce({
      mutationAllowed: true,
      accounts: [
        {
          accountKey: 'current',
          displayName: 'Cindy user',
          email: 'current@example.com',
          avatarUrl: null,
          kind: 'personal',
          orgName: null,
          orgLogoUrl: null,
          isCurrent: true,
        },
      ],
    });

    render(<UserInfoSection isCollapsed={false} />);
    fireEvent.pointerDown(screen.getByRole('button', { name: 'sidebar.user.moreLabel' }), {
      button: 0,
      ctrlKey: false,
    });

    await waitFor(() => expect(syncAccounts).toHaveBeenCalledOnce());
    expect(screen.queryByRole('menuitem', { name: /Cindy user/ })).toBeNull();
  });

  it('keeps the add-account entry before Settings when the user is not signed in', async () => {
    authState.user = null;
    authState.mode = 'local';

    render(<UserInfoSection isCollapsed={false} />);
    fireEvent.pointerDown(screen.getByRole('button', { name: 'sidebar.user.moreLabel' }), {
      button: 0,
      ctrlKey: false,
    });

    const addAccount = await screen.findByRole('menuitem', {
      name: 'sidebar.user.menuAddAccount',
    });
    const settings = screen.getByRole('menuitem', { name: 'sidebar.user.menuSettings' });
    expect(addAccount.compareDocumentPosition(settings) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(listAccounts).not.toHaveBeenCalled();

    fireEvent.click(addAccount);
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith('/add-account', { state: { returnTo: '/' } }),
    );
  });
});
