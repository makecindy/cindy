// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { betaChannelState, navigate } = vi.hoisted(() => ({
  betaChannelState: { enableBeta: false, isCustomized: false, loading: false },
  navigate: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('react-router-dom', () => ({
  useLocation: () => ({ pathname: '/' }),
  useNavigate: () => navigate,
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { name: 'Cindy user', avatar: null },
    mode: 'cloud',
    isCanary: false,
  }),
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
  it('shows the Beta badge beside the expanded app version when the channel is enabled', () => {
    betaChannelState.enableBeta = true;
    render(<UserInfoSection isCollapsed={false} />);

    expect(screen.getByTestId('sidebar-beta-channel-badge').textContent).toBe(
      'settings.betaChannel.badge',
    );
    expect(
      screen.getByRole('link', { name: 'sidebar.user.settingsLinkBeta' }),
    ).toBeTruthy();
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
});
