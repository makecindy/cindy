// @vitest-environment jsdom

/**
 * UpdateBanner「查看更新公告」文字链 —— 方案 A。
 *
 * 覆盖入口的四条判定:CDN 有公告才显示、点击带的是待装版本号、confirming 中断警告期
 * 让位、superseding 态不给入口(那时的 version 指向上一个已就绪补丁,不是正在下的新版)。
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { UpdateBanner } from '@/components/sidebar/UpdateBanner';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts?.version ? `${key}:${String(opts.version)}` : key,
  }),
}));

vi.mock('@/hooks/useLocale', () => ({
  useLocale: () => ({ locale: 'en', effectiveLocale: 'en', setLocale: vi.fn() }),
}));

const updateStatus = vi.hoisted(() => ({
  current: { status: 'ready', version: '1.4.2' } as {
    status: string;
    version?: string;
    errorCode?: string;
  },
}));

vi.mock('@/hooks/useUpdateStatus', () => ({
  useUpdateStatus: () => updateStatus.current,
}));

const fetchReleaseNotes = vi.hoisted(() => vi.fn());
vi.mock('@/release-notes', () => ({ fetchReleaseNotes }));

const NOTES = { version: '1.4.2', date: '2026-07-28', contributors: [], sections: [], topics: [] };

const LINK = 'update.banner.viewNotes';

// 入口按钮现在先查阻断探针再决定「直接重启 vs 进中断警告态」,所以这个文件也需要
// 一个 electronAPI 桩;默认没有任务在跑(本文件只关心文字链,不关心重启)。
const { anyActivityBlockingRelaunch, relaunchToUpdate } = vi.hoisted(() => ({
  anyActivityBlockingRelaunch: vi.fn<() => Promise<boolean>>(),
  relaunchToUpdate: vi.fn(),
}));

beforeEach(() => {
  updateStatus.current = { status: 'ready', version: '1.4.2' };
  fetchReleaseNotes.mockReset();
  fetchReleaseNotes.mockResolvedValue(NOTES);
  anyActivityBlockingRelaunch.mockReset();
  anyActivityBlockingRelaunch.mockResolvedValue(false);
  relaunchToUpdate.mockReset();
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      anyActivityBlockingRelaunch,
      relaunchToUpdate,
      clientEndpoints: { websiteUrl: 'https://cindy.ai' },
    } as unknown as Window['electronAPI'],
  });
});

afterEach(() => {
  cleanup();
});

describe('UpdateBanner release-notes link', () => {
  it('shows the link once the pending version has notes on CDN, and opens that version', async () => {
    const onOpenVersionNotice = vi.fn();
    render(<UpdateBanner isCollapsed={false} onOpenVersionNotice={onOpenVersionNotice} />);

    const link = await screen.findByText(LINK);
    expect(fetchReleaseNotes).toHaveBeenCalledWith('1.4.2', 'en');

    fireEvent.click(link);
    expect(onOpenVersionNotice).toHaveBeenCalledWith('1.4.2');
  });

  it('hides the link when the CDN has no renderable notes for that version', async () => {
    fetchReleaseNotes.mockResolvedValue(null);
    render(<UpdateBanner isCollapsed={false} onOpenVersionNotice={vi.fn()} />);

    await waitFor(() => expect(fetchReleaseNotes).toHaveBeenCalled());
    expect(screen.queryByText(LINK)).toBeNull();
  });

  it('hides the link while the busy-turn interruption warning is showing', async () => {
    anyActivityBlockingRelaunch.mockResolvedValue(true);
    render(<UpdateBanner isCollapsed={false} onOpenVersionNotice={vi.fn()} />);
    await screen.findByText(LINK);

    fireEvent.click(screen.getByText('update.banner.button'));

    expect(await screen.findByText('update.banner.confirmButton')).toBeTruthy();
    expect(screen.queryByText(LINK)).toBeNull();
  });

  it('does not probe or show the link while a newer version is superseding', async () => {
    updateStatus.current = { status: 'superseding', version: '1.4.2' };
    render(<UpdateBanner isCollapsed={false} onOpenVersionNotice={vi.fn()} />);

    await screen.findByText('update.banner.preparingButton');
    expect(fetchReleaseNotes).not.toHaveBeenCalled();
    expect(screen.queryByText(LINK)).toBeNull();
  });

  it('does not probe at all while the sidebar is collapsed / rail', async () => {
    render(<UpdateBanner isCollapsed onOpenVersionNotice={vi.fn()} />);

    // 收起态压根不渲染文字链,那就不该为它打一次 CDN 请求。
    await screen.findByRole('button');
    expect(fetchReleaseNotes).not.toHaveBeenCalled();
    expect(screen.queryByText(LINK)).toBeNull();
  });

  it('probes once the sidebar expands, without re-probing on callback identity churn', async () => {
    const { rerender } = render(
      <UpdateBanner isCollapsed onOpenVersionNotice={vi.fn()} />,
    );
    expect(fetchReleaseNotes).not.toHaveBeenCalled();

    rerender(<UpdateBanner isCollapsed={false} onOpenVersionNotice={vi.fn()} />);
    await screen.findByText(LINK);
    expect(fetchReleaseNotes).toHaveBeenCalledTimes(1);

    // useUpdateNotice 的回调带 `open` 依赖,弹窗开关会换掉它的 identity;探测不该跟着重跑。
    rerender(<UpdateBanner isCollapsed={false} onOpenVersionNotice={vi.fn()} />);
    rerender(<UpdateBanner isCollapsed={false} onOpenVersionNotice={vi.fn()} />);
    expect(fetchReleaseNotes).toHaveBeenCalledTimes(1);
  });

  it('renders no link when the host provides no open-notice callback', async () => {
    render(<UpdateBanner isCollapsed={false} />);

    await screen.findByText('update.banner.button');
    expect(fetchReleaseNotes).not.toHaveBeenCalled();
    expect(screen.queryByText(LINK)).toBeNull();
  });
});
