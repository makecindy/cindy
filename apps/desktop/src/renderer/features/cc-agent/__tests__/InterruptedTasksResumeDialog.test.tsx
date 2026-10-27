// @vitest-environment jsdom
/**
 * 启动「继续上次中断的任务」弹窗:只对仍勾选、且提交时仍处于中断态的任务发续跑指令。
 *
 * 依据:产品决策(2026-10-19)默认全选、可去掉不想继续的;没勾选的任务不得被续跑,
 * 它们的中断横幅留给用户之后单独处理。续跑复用横幅的 CONTINUE_AFTER_APP_EXIT_PROMPT。
 * 弹窗打开期间任务可能已被其它窗口继续(PR #6390 review),提交前必须重新取中断集合,
 * 否则会对已恢复的任务重复续跑一轮。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CONTINUE_AFTER_APP_EXIT_PROMPT } from '../../../../shared/interruptedTurn';
import { InterruptedTasksResumeDialog } from '../InterruptedTasksResumeDialog';

const sendUiTrigger = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ dataOwnerId: 'owner-1' }) }));
vi.mock('@/lib/scrollbarAutoHide', () => ({ flashScrollbar: () => {} }));
vi.mock('@/lib/makerChatStore', () => ({ makerChatStore: { sendUiTrigger } }));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn() } }));

afterEach(cleanup);

describe('InterruptedTasksResumeDialog', () => {
  it('continues only checked tasks that are still interrupted at submit time', async () => {
    const now = Date.now();
    const session = (id: string, title: string) => ({
      id,
      title,
      source: 'desktop',
      agentKind: 'cc',
      workingDir: `/code/${id}`,
      workspaceKind: 'project',
      createdAt: new Date(now).toISOString(),
    });
    const listCandidates = vi
      .fn()
      .mockResolvedValueOnce([
        { sessionId: 's-a', interruptedAt: now - 120_000, activity: '运行测试' },
        { sessionId: 's-b', interruptedAt: now - 60_000, activity: null },
        { sessionId: 's-c', interruptedAt: now - 30_000, activity: null },
      ])
      // 提交时 s-c 已在别处被继续,不再中断。
      .mockResolvedValueOnce([
        { sessionId: 's-a', interruptedAt: now - 120_000, activity: '运行测试' },
        { sessionId: 's-b', interruptedAt: now - 60_000, activity: null },
      ]);
    Object.assign(window, {
      electronAPI: {
        localDb: {
          sessions: {
            interruptedResumeCandidates: listCandidates,
            getMany: async () => [
              session('s-a', '任务 A'),
              session('s-b', '任务 B'),
              session('s-c', '任务 C'),
            ],
          },
        },
      },
    });

    render(<InterruptedTasksResumeDialog />);

    await screen.findByRole('alertdialog');
    expect(screen.getByText('任务 A')).toBeTruthy();
    expect(screen.getByText(/s-a · 运行测试/)).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: '任务 B' }));
    fireEvent.click(
      screen.getByRole('button', { name: 'chat.interruptedResumeDialog.continueSelected' }),
    );

    await waitFor(() => expect(sendUiTrigger).toHaveBeenCalledTimes(1));
    expect(sendUiTrigger).toHaveBeenCalledWith('s-a', CONTINUE_AFTER_APP_EXIT_PROMPT);
  });
});
