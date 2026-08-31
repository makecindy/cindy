// @vitest-environment jsdom

/**
 * 头像行火焰与 UpdateBanner 折叠火焰互斥:rail 的 UserInfoSection 不渲染火焰,
 * 展开态才在 banner 被藏起时用这颗涂黑入口。钉住 Greptile 说的「busy 时两颗火焰」。
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('react-router-dom', () => ({
  useLocation: () => ({ pathname: '/' }),
  useNavigate: () => vi.fn(),
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { name: 'Cindy user', avatar: null },
    mode: 'cloud',
    isCanary: false,
  }),
}));

vi.mock('@/hooks/useUpdateStatus', () => ({
  useUpdateStatus: () => ({ status: 'ready', version: '1.2.3', errorCode: null }),
}));

vi.mock('@/hooks/useUpdateBannerDismiss', () => ({
  useUpdateBannerDismiss: () => ({ dismissed: true, restore: vi.fn(), reason: 'busy' }),
}));

vi.mock('@/hooks/useBetaChannelSettings', () => ({
  useBetaChannelSettings: () => ({
    state: { enableBeta: false, isCustomized: false, loading: false },
  }),
}));

vi.mock('@/hooks/useLogout', () => ({
  useLogout: () => ({ handleLogout: vi.fn() }),
}));

vi.mock('@/components/sidebar/MobileDownloadDialog', () => ({
  MobileDownloadDialog: () => null,
}));

vi.mock('@/components/ui/tooltip', () => ({
  Tip: ({ children }: { children: React.ReactNode }) => children,
}));

import { UserInfoSection } from '@/components/sidebar/UserInfoSection';

beforeEach(() => {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      appDisplayVersion: '1.0.0',
      appDisplayVersionDetail: '1.0.0-test',
    },
  });
});

afterEach(cleanup);

describe('UserInfoSection update flame vs rail', () => {
  it('does not render the reopen flame in the rail layout while busy-deferred', () => {
    render(<UserInfoSection isCollapsed onOpenUpdateNotice={() => {}} />);

    expect(screen.queryByRole('button', { name: 'sidebar.user.reopenUpdateBanner' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'sidebar.user.viewReleaseNotes' })).toBeNull();
  });

  it('renders the reopen flame in the expanded layout while the banner is deferred', () => {
    render(<UserInfoSection isCollapsed={false} onOpenUpdateNotice={() => {}} />);

    expect(screen.getByRole('button', { name: 'sidebar.user.reopenUpdateBanner' })).toBeTruthy();
  });
});
