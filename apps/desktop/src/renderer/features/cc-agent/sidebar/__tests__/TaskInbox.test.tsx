// @vitest-environment jsdom
/**
 * 测试价值：生产 TaskInbox 悬停生命周期，完成后恢复必须追加到末尾。
 * 规则：task-inbox.md；旧纯函数测试手动提交快照，漏掉组件没有更新快照。
 * 最小失败输入：悬停 A/B，完成 A，再恢复 A；unit，替代行内容与外部 store。
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { Session } from '@/lib/ccAgent.types';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (s: string) => s, i18n: { language: 'en' } }) }));
vi.mock('@/features/device-link/remoteSessionActivityStore', () => ({ getRemoteSessionActivity: () => null, useRemoteSessionActivityRevision: () => 0 }));
vi.mock('@/features/scheduler/lib/scheduleSessionBinding', () => ({ useActiveFollowUpSessions: () => new Set() }));
vi.mock('../../lib/sidebarPriorityContext', () => ({ sidebarPriorityContext: (context: unknown) => context }));
vi.mock('../../lib/mainListModel', () => ({ sessionNaturalPriorityRank: () => 3, sessionPriorityRank: () => 3, sortSessionsForMainList: (s: unknown) => s }));
vi.mock('../SectionCollapse', () => ({ SectionCollapse: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('../SessionEntryList', () => ({ SessionEntryRows: ({ entries }: { entries: { session: Session }[] }) => <div data-testid="row">{entries[0].session.id}</div> }));
import { TaskInbox } from '../TaskInbox';
afterEach(cleanup);
it('commits explicit moves before another restore while the pointer stays in the list', () => {
  const task = (id: string, status = 'active') => ({ id, title: id, status }) as Session;
  const props: Parameters<typeof TaskInbox>[0] = {
    priorityContext: { runningSessionIds: new Set(), attentionSessionIds: new Set() },
    sessions: [task('a'), task('b')], runningSessionIds: new Set(), attachedSessionIds: new Set(),
    notifications: new Set(), onSessionClick: () => {}, onAction: () => {},
    onRename: () => {}, onTogglePin: () => {}, onScheduleAction: () => {},
  };
  const view = render(<TaskInbox {...props} />);
  fireEvent.pointerEnter(view.container.firstChild!);
  view.rerender(<TaskInbox {...props} sessions={[task('a', 'archived'), task('b')]} />);
  expect(screen.getAllByTestId('row').map(row => row.textContent)).toEqual(['b', 'a']);
  view.rerender(<TaskInbox {...props} />);
  expect(screen.getAllByTestId('row').map(row => row.textContent)).toEqual(['b', 'a']);
});
