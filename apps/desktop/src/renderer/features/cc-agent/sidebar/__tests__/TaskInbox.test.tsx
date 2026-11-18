// @vitest-environment jsdom
/**
 * 测试价值：生产 TaskInbox 悬停生命周期，完成后恢复必须追加到末尾。
 * 规则：task-inbox.md；旧纯函数测试手动提交快照，漏掉组件没有更新快照。
 * 最小失败输入：悬停 A/B，完成 A，再恢复 A；unit，替代行内容与外部 store。
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Session } from '@/lib/ccAgent.types';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (s: string) => s, i18n: { language: 'en' } }) }));
vi.mock('@/features/device-link/remoteSessionActivityStore', () => ({ getRemoteSessionActivity: () => null, useRemoteSessionActivityRevision: () => 0 }));
const following = vi.hoisted(() => new Set<Session>());
vi.mock('@/features/scheduler/lib/scheduleSessionBinding', () => ({ useActiveFollowUpSessions: () => following }));
vi.mock('../../lib/sidebarPriorityContext', () => ({ sidebarPriorityContext: (context: unknown) => context }));
vi.mock('../SectionCollapse', () => ({ SectionCollapse: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('../SessionEntryList', () => ({ SessionEntryRows: ({ entries, onAction }: {
  entries: { session: Session }[]; onAction: (id: string, action: 'complete') => unknown;
}) => <div data-testid="row">{entries[0].session.id}<button aria-label={`complete:${entries[0].session.id}`}
  onClick={() => { void onAction(entries[0].session.id, 'complete'); }} /></div> }));
import { TaskInbox } from '../TaskInbox';
beforeEach(() => following.clear());
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

// PR #10685, 2026-11-18: an opened task is already read, but its held unread rank
// keeps it Pending. Earlier tests only replaced archived props; they never clicked
// Done with no store changes. Unit: real component/rank/placement with a stub row.
it.each([false, true])('settles an already-read open task without another data update (hover=%s)', async hovered => {
  const a = { id: 'a', status: 'active', title: 'A' } as Session;
  const b = { id: 'b', status: 'active', title: 'B' } as Session;
  following.add(a);
  const onAction = vi.fn(async () => 'marked-read' as const);
  const props: Parameters<typeof TaskInbox>[0] = {
    activeSessionId: 'a', sessions: [a, b], onAction,
    priorityContext: { runningSessionIds: new Set(), attentionSessionIds: new Set(), heldPriorityRanks: new Map([['a', 1]]) },
    runningSessionIds: new Set(), attachedSessionIds: new Set(), notifications: new Set(),
    onSessionClick: () => {}, onRename: () => {}, onTogglePin: () => {}, onScheduleAction: () => {},
  };
  const view = render(<TaskInbox {...props} />);
  const rows = (index: number) => Array.from(view.container.querySelectorAll('section')[index].querySelectorAll('[data-testid="row"]'))
    .map(row => row.textContent);
  if (hovered) fireEvent.pointerEnter(view.container.firstChild!);
  expect(rows(0)).toEqual(['a', 'b']);
  fireEvent.click(screen.getByRole('button', { name: 'complete:a' }));
  await waitFor(() => expect(rows(0)).toEqual(['b']));
  expect(rows(1)).toEqual(['a']);
  expect(onAction).toHaveBeenCalledWith('a', 'complete');
  if (hovered) {
    // A new question is a background change, not another explicit completion.
    view.rerender(<TaskInbox {...props} priorityContext={{ ...props.priorityContext,
      attentionSessionIds: new Set(['a']), waitingSessionIds: new Set(['a']) }} />);
    expect(rows(1)).toEqual(['a']);
    fireEvent.pointerLeave(view.container.firstChild!);
    expect(rows(0)).toContain('a');
    fireEvent.pointerEnter(view.container.firstChild!);
    view.rerender(<TaskInbox {...props} priorityContext={{ ...props.priorityContext, runningSessionIds: new Set(['a']) }} />);
    // The previous completion marker was consumed and cannot release this new hover.
    expect(rows(0)).toContain('a');
  }
  fireEvent.pointerLeave(view.container.firstChild!);
  view.rerender(<TaskInbox {...props} activeSessionId="b" />);
  view.rerender(<TaskInbox {...props} />);
  // Returning later is a new viewing lifecycle, not the previous completion.
  expect(rows(0)).toContain('a');
});

it('keeps a held task Pending when its completion was blocked', async () => {
  const a = { id: 'a', status: 'active', title: 'A' } as Session;
  following.add(a);
  const onAction = vi.fn(async () => {});
  const props: Parameters<typeof TaskInbox>[0] = {
    activeSessionId: 'a', sessions: [a], onAction,
    priorityContext: { runningSessionIds: new Set(), attentionSessionIds: new Set(), heldPriorityRanks: new Map([['a', 1]]) },
    runningSessionIds: new Set(), attachedSessionIds: new Set(), notifications: new Set(),
    onSessionClick: () => {}, onRename: () => {}, onTogglePin: () => {}, onScheduleAction: () => {},
  };
  const view = render(<TaskInbox {...props} />);
  fireEvent.pointerEnter(view.container.firstChild!);
  fireEvent.click(screen.getByRole('button', { name: 'complete:a' }));
  await waitFor(() => expect(onAction).toHaveBeenCalledOnce());
  expect(view.container.querySelector('section')?.querySelector('[data-testid="row"]')?.textContent).toBe('a');
});

// A slow completion from the previously viewed task cannot undo the new task's
// explicit completion when the two results return in reverse order.
it('keeps the new viewed task settled when an older completion returns late', async () => {
  const a = { id: 'a', status: 'active', title: 'A' } as Session;
  const b = { id: 'b', status: 'active', title: 'B' } as Session;
  following.add(a); following.add(b);
  let finishA!: (result: 'marked-read') => void;
  const aResult = new Promise<'marked-read'>(resolve => { finishA = resolve; });
  const props: Parameters<typeof TaskInbox>[0] = {
    activeSessionId: 'a', sessions: [a, b], onAction: id => id === 'a' ? aResult : Promise.resolve('marked-read' as const),
    priorityContext: { runningSessionIds: new Set(), attentionSessionIds: new Set(), heldPriorityRanks: new Map([['a', 1]]) },
    runningSessionIds: new Set(), attachedSessionIds: new Set(), notifications: new Set(),
    onSessionClick: () => {}, onRename: () => {}, onTogglePin: () => {}, onScheduleAction: () => {},
  };
  const view = render(<TaskInbox {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'complete:a' }));
  view.rerender(<TaskInbox {...props} activeSessionId="b" priorityContext={{
    ...props.priorityContext, heldPriorityRanks: new Map([['b', 1]]),
  }} />);
  const pendingRows = () => view.container.querySelector('section')!.querySelectorAll('[data-testid="row"]');
  fireEvent.click(screen.getByRole('button', { name: 'complete:b' }));
  await waitFor(() => expect(pendingRows()).toHaveLength(0));
  await act(async () => { finishA('marked-read'); await aResult; });
  expect(pendingRows()).toHaveLength(0);
});
