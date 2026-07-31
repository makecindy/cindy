// @vitest-environment jsdom

/**
 * UpdateBanner 的重启入口判定 —— 与关窗链路(WindowControls.handleCloseClick)同构:
 * 点入口先查 anySessionInTurn(),没有任务在跑就直接重启,有才拦一次并说明「会打断
 * 进行中的任务」。探针失败按「没有任务」处理。
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { anySessionInTurn, relaunchToUpdate } = vi.hoisted(() => ({
  anySessionInTurn: vi.fn<() => Promise<boolean>>(),
  relaunchToUpdate: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@/hooks/useUpdateStatus', () => ({
  useUpdateStatus: () => ({
    status: 'ready',
    version: '1.2.3',
    errorCode: null,
  }),
}));

vi.mock('@/hooks/useUpdateBannerDismiss', () => ({
  useUpdateBannerDismiss: () => ({
    dismissed: false,
    dismiss: vi.fn(),
    restore: vi.fn(),
    isNewUpdateAfterDismiss: vi.fn(() => false),
  }),
}));

vi.mock('@/components/ui/tooltip', () => ({
  Tip: ({ children }: { children: React.ReactNode }) => children,
}));

import { UpdateBanner } from '@/components/sidebar/UpdateBanner';

beforeEach(() => {
  anySessionInTurn.mockReset();
  relaunchToUpdate.mockReset();
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      anySessionInTurn,
      relaunchToUpdate,
      clientEndpoints: { websiteUrl: 'https://cindy.ai' },
    } as unknown as Window['electronAPI'],
  });
});

afterEach(cleanup);

describe('UpdateBanner relaunch entry', () => {
  it('warns about the interruption instead of relaunching while a turn is running', async () => {
    anySessionInTurn.mockResolvedValue(true);
    render(<UpdateBanner isCollapsed={false} />);

    fireEvent.click(screen.getByRole('button', { name: 'update.banner.ariaExpanded' }));

    const hint = await screen.findByText('update.banner.confirmBusyHint');
    expect(anySessionInTurn).toHaveBeenCalledTimes(1);
    expect(hint.className).toContain('text-[var(--warning-fg)]');
    // 拦住的这一步不能顺手把 app 重启了 —— 是否打断任务由用户拍板。
    expect(relaunchToUpdate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'update.banner.confirmAria' }));
    expect(relaunchToUpdate).toHaveBeenCalledTimes(1);
  });

  it('relaunches on the first click when no turn is running', async () => {
    anySessionInTurn.mockResolvedValue(false);
    render(<UpdateBanner isCollapsed={false} />);

    fireEvent.click(screen.getByRole('button', { name: 'update.banner.ariaExpanded' }));

    await waitFor(() => expect(relaunchToUpdate).toHaveBeenCalledTimes(1));
    expect(anySessionInTurn).toHaveBeenCalledTimes(1);
    // 没有任务在跑时不该再出现第二步 —— 那句「应用会自动重启」不带任何信息量。
    expect(screen.queryByRole('button', { name: 'update.banner.confirmAria' })).toBeNull();
    expect(screen.queryByText('update.banner.confirmBusyHint')).toBeNull();
  });

  it('relaunches when the busy probe throws synchronously (bridge unavailable)', async () => {
    anySessionInTurn.mockImplementation(() => {
      throw new Error('electron bridge is not registered');
    });
    render(<UpdateBanner isCollapsed={false} />);

    fireEvent.click(screen.getByRole('button', { name: 'update.banner.ariaExpanded' }));

    await waitFor(() => expect(relaunchToUpdate).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('update.banner.confirmBusyHint')).toBeNull();
  });

  it('ignores repeat clicks while the busy probe is still in flight', async () => {
    let resolveTurnCheck!: (busy: boolean) => void;
    anySessionInTurn.mockImplementation(
      () => new Promise<boolean>((resolve) => { resolveTurnCheck = resolve; }),
    );
    render(<UpdateBanner isCollapsed={false} />);

    const entry = screen.getByRole('button', { name: 'update.banner.ariaExpanded' });
    fireEvent.click(entry);
    fireEvent.click(entry);
    fireEvent.click(entry);

    await waitFor(() => expect(anySessionInTurn).toHaveBeenCalledTimes(1));
    expect(relaunchToUpdate).not.toHaveBeenCalled();

    resolveTurnCheck(false);
    await waitFor(() => expect(relaunchToUpdate).toHaveBeenCalledTimes(1));
  });

  it('applies the same judgement to the collapsed / rail entry', async () => {
    anySessionInTurn.mockResolvedValue(false);
    const { unmount } = render(<UpdateBanner isCollapsed />);

    fireEvent.click(screen.getByRole('button', { name: 'update.banner.ariaCollapsed' }));
    await waitFor(() => expect(relaunchToUpdate).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('button', { name: 'update.banner.confirmAria' })).toBeNull();

    unmount();
    relaunchToUpdate.mockClear();
    anySessionInTurn.mockResolvedValue(true);
    render(<UpdateBanner isCollapsed />);

    fireEvent.click(screen.getByRole('button', { name: 'update.banner.ariaCollapsed' }));
    // 收起态没有文案位置,拦下来的形态是 ✓ / ✕ 两键。
    await screen.findByRole('button', { name: 'update.banner.confirmAria' });
    expect(screen.getByRole('button', { name: 'update.banner.cancelAria' })).toBeTruthy();
    expect(relaunchToUpdate).not.toHaveBeenCalled();
  });
});
