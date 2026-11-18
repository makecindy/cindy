// @vitest-environment jsdom

/**
 * 头像行火焰与 UpdateBanner 折叠火焰互斥:rail 的 UserInfoSection 不渲染火焰,
 * 展开态才在 banner 被藏起时用这颗涂黑入口。钉住 Greptile 说的「busy 时两颗火焰」。
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UpdateBanner } from '@/components/sidebar/UpdateBanner';
import {
  deferUpdateBannerBecauseBusy,
  resetUpdateBannerDismissStoreForTests,
} from '@/hooks/useUpdateBannerDismiss';
import type { RawReleaseNotes } from '../../shared/releaseNotesContent';

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

const updateStatus = vi.hoisted(() => ({ version: '1.2.3' }));

vi.mock('@/hooks/useUpdateStatus', () => ({
  useUpdateStatus: () => ({ status: 'ready', version: updateStatus.version, errorCode: null }),
}));

vi.mock('@/hooks/useLocale', () => ({
  useLocale: () => ({ effectiveLocale: 'en' }),
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
  resetUpdateBannerDismissStoreForTests();
  updateStatus.version = '1.2.3';
  deferUpdateBannerBecauseBusy('ready', updateStatus.version);
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      appDisplayVersion: '1.0.0',
      appDisplayVersionDetail: '1.0.0-test',
      appVersion: '1.0.0',
      anyActivityBlockingRelaunch: vi.fn().mockResolvedValue(false),
      clientEndpoints: { websiteUrl: 'https://cindy.ai' },
    },
  });
});

afterEach(cleanup);

/**
 * 生产入口：真实火焰按钮 → dismiss store → UpdateBanner → release-notes 缓存 → IPC。
 * Bug：公告首次 404 后，关闭提示再点火焰不会重试，公告恢复后仍没有入口。
 * 现有覆盖只检查火焰是否显示，未覆盖重新展开及公告缓存；最小输入为 null → 有效公告。
 * tier: unit，公告读取只在 IPC 边界用内存替身；另覆盖成功缓存及未完成请求，避免重复联网。
 * 单文件实测：vitest run src/renderer/__tests__/userInfoSectionUpdateFlame.test.tsx，1.55 秒。
 */
describe('UserInfoSection reopens update notes', () => {
  beforeEach(() => resetUpdateBannerDismissStoreForTests());

  function notes(version: string): RawReleaseNotes {
    return {
      version,
      date: '2026-11-16',
      contributors: [],
      topics: [{ title: 'Update', text: 'New features', contributors: [] }],
    };
  }

  async function renderUpdate(version: string) {
    updateStatus.version = version;
    render(<>
      <UpdateBanner isCollapsed={false} onOpenVersionNotice={vi.fn()} />
      <UserInfoSection isCollapsed={false} onOpenUpdateNotice={vi.fn()} />
    </>);
    await screen.findByRole('button', { name: 'update.banner.dismissAria' });
  }

  function closeAndReopen() {
    fireEvent.click(screen.getByRole('button', { name: 'update.banner.dismissAria' }));
    fireEvent.click(screen.getByRole('button', { name: 'sidebar.user.reopenUpdateBanner' }));
  }

  it.each(['missing', 'rejected'] as const)('retries %s notes once when the flame reopens the banner', async (failure) => {
    const version = failure === 'missing' ? '1.2.4' : '1.2.5';
    const fetchNotes = vi.fn().mockResolvedValue(notes(version));
    if (failure === 'missing') fetchNotes.mockResolvedValueOnce(null);
    else fetchNotes.mockRejectedValueOnce(new Error('IPC unavailable'));
    window.electronAPI.fetchReleaseNotes = fetchNotes;
    await renderUpdate(version);
    expect(screen.queryByText('update.banner.viewNotes')).toBeNull();
    expect(fetchNotes).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'update.banner.dismissAria' }));
    expect(fetchNotes).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'sidebar.user.reopenUpdateBanner' }));

    expect(await screen.findByText('update.banner.viewNotes')).toBeTruthy();
    expect(fetchNotes).toHaveBeenCalledTimes(2);
    expect(fetchNotes).toHaveBeenLastCalledWith(version);
  });

  it('reuses successful notes when the flame reopens the banner', async () => {
    const version = '1.2.6';
    const fetchNotes = vi.fn().mockResolvedValue(notes(version));
    window.electronAPI.fetchReleaseNotes = fetchNotes;
    await renderUpdate(version);
    await screen.findByText('update.banner.viewNotes');

    closeAndReopen();

    expect(await screen.findByText('update.banner.viewNotes')).toBeTruthy();
    expect(fetchNotes).toHaveBeenCalledTimes(1);
  });

  it('reuses an in-flight request across repeated flame reopens', async () => {
    const version = '1.2.7';
    let resolveNotes!: (value: RawReleaseNotes) => void;
    const pending = new Promise<RawReleaseNotes>((resolve) => { resolveNotes = resolve; });
    const fetchNotes = vi.fn().mockReturnValue(pending);
    window.electronAPI.fetchReleaseNotes = fetchNotes;
    await renderUpdate(version);

    closeAndReopen();
    closeAndReopen();
    await act(async () => { resolveNotes(notes(version)); });

    expect(await screen.findByText('update.banner.viewNotes')).toBeTruthy();
    expect(fetchNotes).toHaveBeenCalledTimes(1);
  });
});

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

  it('keeps the regular app version label for the personal build', () => {
    render(<UserInfoSection isCollapsed={false} />);

    expect(screen.getByText('1.0.0')).toBeTruthy();
    expect(screen.queryByText('cindyMake.versions.personal')).toBeNull();
  });
});
