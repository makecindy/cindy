// @vitest-environment jsdom

/**
 * 测试价值
 * - 生产入口与可观察结果:渲染真实 WorktreeRestoreBanner,断言横幅是否出现、文案里
 *   是否带 worktree 名字、是否给任务打红点。
 * - Bug/规则依据:用户反馈(2026-11-11)「点关闭后,下次打开任务横幅又弹出来」,且
 *   横幅没说是哪个 worktree。
 * - 现有覆盖缺口:该组件此前没有任何测试;main 侧 worktreeRestore.test.ts 只管状态查询。
 * - 最小失败输入:状态恒为 restorable,点 X 后卸载再挂载同一任务 —— 修复前横幅重新出现。
 * - tier:unit(jsdom),只 mock IPC 与红点 store,关闭记录走真实 localStorage。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  addSessionAttention: vi.fn(),
  restoreStatus: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { name?: string }) =>
      options?.name === undefined ? key : `${key}|${options.name}`,
  }),
}));
vi.mock('@/contexts/WorktreeContext', () => ({
  useRefreshWorktreeForSession: () => vi.fn(),
}));
vi.mock('@/lib/sessionAttentionStore', () => ({
  addSessionAttention: mocks.addSessionAttention,
  clearSessionAttention: vi.fn(),
}));
vi.mock('@/hooks/usePendingAlertAttention', () => ({
  refreshPendingAlerts: vi.fn(),
}));
vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

import { Tooltip } from '@/components/ui/tooltip';
import { WorktreeRestoreBanner } from '../WorktreeRestoreBanner';

const WORKTREE_PATH = '/repo/.cindy-worktrees/bold-hertz';
const RECYCLED = { state: 'restorable', worktreePath: WORKTREE_PATH, hasSnapshot: false };

function mountBanner(sessionId = 's1') {
  return render(
    <Tooltip.Provider>
      <WorktreeRestoreBanner sessionId={sessionId} />
    </Tooltip.Provider>,
  );
}

/** 等这次挂载的状态自查跑完,再断言「没有横幅」,避免把「还没查完」当成「不显示」。 */
async function expectNoBannerAfterStatusCheck(callCount: number) {
  await waitFor(() => expect(mocks.restoreStatus).toHaveBeenCalledTimes(callCount));
  await Promise.resolve();
  expect(screen.queryByTestId('worktree-restore-banner')).toBeNull();
}

describe('WorktreeRestoreBanner', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    mocks.restoreStatus.mockResolvedValue(RECYCLED);
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      worktreeRestoreStatus: mocks.restoreStatus,
    };
  });

  afterEach(() => {
    cleanup();
  });

  it('names the recycled worktree and stays closed after the user dismisses it', async () => {
    const first = mountBanner();
    const banner = await screen.findByTestId('worktree-restore-banner');
    expect(banner.textContent).toContain('chat.worktreeRestoreBanner.text|bold-hertz');
    expect(mocks.addSessionAttention).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByLabelText('chat.worktreeRestoreBanner.dismissTitle'));
    expect(screen.queryByTestId('worktree-restore-banner')).toBeNull();
    first.unmount();

    // 重开同一个任务:状态仍是「已被回收」,但关过的提示不再弹出,也不再打红点。
    mountBanner();
    await expectNoBannerAfterStatusCheck(2);
    expect(mocks.addSessionAttention).toHaveBeenCalledTimes(1);

    // 另一个任务的同类提示不受影响。
    cleanup();
    mountBanner('s2');
    expect(await screen.findByTestId('worktree-restore-banner')).toBeTruthy();
  });

  it('shows the notice again when the worktree is recycled again after being restored', async () => {
    const first = mountBanner();
    await screen.findByTestId('worktree-restore-banner');
    fireEvent.click(screen.getByLabelText('chat.worktreeRestoreBanner.dismissTitle'));
    first.unmount();

    // 之后 worktree 被恢复(例如继续发消息时自动重建):自查到目录已在。
    mocks.restoreStatus.mockResolvedValue({ state: 'present', worktreePath: WORKTREE_PATH });
    const restored = mountBanner();
    await expectNoBannerAfterStatusCheck(2);
    restored.unmount();

    // 再次被回收是一条新提示。
    mocks.restoreStatus.mockResolvedValue(RECYCLED);
    mountBanner();
    expect(await screen.findByTestId('worktree-restore-banner')).toBeTruthy();
  });

  it('still surfaces an unapplied snapshot after the missing-directory notice was dismissed', async () => {
    const first = mountBanner();
    await screen.findByTestId('worktree-restore-banner');
    fireEvent.click(screen.getByLabelText('chat.worktreeRestoreBanner.dismissTitle'));
    first.unmount();

    mocks.restoreStatus.mockResolvedValue({
      state: 'present',
      worktreePath: WORKTREE_PATH,
      hasSnapshot: true,
    });
    mountBanner();
    const banner = await screen.findByTestId('worktree-restore-banner');
    expect(banner.textContent).toContain(
      'chat.worktreeRestoreBanner.textPendingSnapshot|bold-hertz',
    );
  });
});
