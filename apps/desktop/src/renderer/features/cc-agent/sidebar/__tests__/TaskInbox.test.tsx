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
import { applyRemoteSessionActivity, clearRemoteSessionActivity } from '@/features/device-link/remoteSessionActivityStore';
const following = vi.hoisted(() => new Set<Session>());
vi.mock('@/features/scheduler/lib/scheduleSessionBinding', () => ({ useActiveFollowUpSessions: () => following }));
vi.mock('../SectionCollapse', () => ({ SectionCollapse: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('../SessionEntryList', () => ({ SessionEntryRows: ({ entries, onAction }: {
  entries: { session: Session }[]; onAction: (id: string, action: 'complete') => unknown;
}) => <div data-testid="row" data-device={entries[0].session.deviceLinkDeviceId}>{entries[0].session.id}<button data-inbox-complete aria-label={`complete:${entries[0].session.id}`}
  onClick={() => { void onAction(entries[0].session.id, 'complete'); }} /></div> }));
import { markSessionStarting, clearSessionStarting } from '@/lib/sessionStartingStore';
import { TaskInbox } from '../TaskInbox';
beforeEach(() => following.clear());
afterEach(() => { cleanup(); clearRemoteSessionActivity(); });
// The controller still has a running flag when the host sends the unread result.
it('moves only the finished device’s task to Pending without a pointer or a list refresh', () => {
  const sharedId = 'same-id';
  const tasks = ['studio', 'other'].map(deviceLinkDeviceId => ({
    id: sharedId, title: deviceLinkDeviceId, status: 'active', deviceLinkDeviceId,
  } as Session));
  const push = (device: string, phase: 'running' | 'completed', attention = false) =>
    act(() => applyRemoteSessionActivity(device, { sessionId: sharedId, phase, attention }));
  push('studio', 'running');
  push('other', 'running');
  const running = new Set([sharedId]);
  const view = render(<TaskInbox sessions={tasks} priorityContext={{ runningSessionIds: running, attentionSessionIds: new Set() }}
    runningSessionIds={running} attachedSessionIds={new Set()} notifications={new Set()}
    onSessionClick={() => {}} onAction={() => {}} onRename={() => {}} onTogglePin={() => {}} onScheduleAction={() => {}} />);
  const [pending, working] = view.container.querySelectorAll('section');
  const rows = (section: Element) => Array.from(section.querySelectorAll('[data-device]'), row => row.getAttribute('data-device'));
  expect(rows(working)).toEqual(['studio', 'other']);
  push('studio', 'completed', true);
  expect(rows(pending)).toEqual(['studio']);
  expect(rows(working)).toEqual(['other']);
  push('studio', 'completed'); // Reading the result clears the remote activity entry.
  expect(rows(pending)).toEqual(['studio']);
  push('studio', 'running');
  expect(rows(pending)).toEqual([]);
});

it('moves a remote task to Working immediately after sending, before its first host push', () => {
  const task = { id: 'remote-send', title: 'Remote', status: 'active', deviceLinkDeviceId: 'studio' } as Session;
  const props: Parameters<typeof TaskInbox>[0] = {
    sessions: [task], priorityContext: { runningSessionIds: new Set(), attentionSessionIds: new Set() },
    runningSessionIds: new Set(), attachedSessionIds: new Set(), notifications: new Set(),
    onSessionClick: () => {}, onAction: () => {}, onRename: () => {}, onTogglePin: () => {}, onScheduleAction: () => {},
  };
  const view = render(<TaskInbox {...props} />);
  const [pending, working] = view.container.querySelectorAll('section');
  expect(pending.contains(screen.getByTestId('row'))).toBe(true);
  act(() => markSessionStarting(task.id, 'new-input'));
  const starting = new Set([task.id]);
  view.rerender(<TaskInbox {...props} priorityContext={{ ...props.priorityContext, runningSessionIds: starting }} />);
  expect(working.contains(screen.getByTestId('row'))).toBe(true);
  // A fast turn may finish before the controller absorbs the optimistic starting flag.
  act(() => applyRemoteSessionActivity('studio', { sessionId: task.id, phase: 'completed', attention: true }));
  expect(pending.contains(screen.getByTestId('row'))).toBe(true);
  act(() => clearSessionStarting(task.id));
});

it('commits explicit moves before another restore while hovering another task’s Done button', () => {
  const task = (id: string, status = 'active') => ({ id, title: id, status }) as Session;
  const props: Parameters<typeof TaskInbox>[0] = {
    priorityContext: { runningSessionIds: new Set(), attentionSessionIds: new Set() },
    sessions: [task('a'), task('b')], runningSessionIds: new Set(), attachedSessionIds: new Set(),
    notifications: new Set(), onSessionClick: () => {}, onAction: () => {},
    onRename: () => {}, onTogglePin: () => {}, onScheduleAction: () => {},
  };
  const view = render(<TaskInbox {...props} />);
  fireEvent.mouseOver(screen.getByRole('button', { name: 'complete:b' }));
  view.rerender(<TaskInbox {...props} sessions={[task('a', 'archived'), task('b')]} />);
  expect(screen.getAllByTestId('row').map(row => row.textContent)).toEqual(['b', 'a']);
  view.rerender(<TaskInbox {...props} />);
  expect(screen.getAllByTestId('row').map(row => row.textContent)).toEqual(['b', 'a']);
});

it('updates over a row, holds over Done, and catches up on returning to the row', () => {
  const a = { id: 'a', status: 'active', title: 'A' } as Session;
  const props: Parameters<typeof TaskInbox>[0] = {
    sessions: [a], priorityContext: { runningSessionIds: new Set(), attentionSessionIds: new Set() },
    runningSessionIds: new Set(), attachedSessionIds: new Set(), notifications: new Set(),
    onSessionClick: () => {}, onAction: () => {}, onRename: () => {}, onTogglePin: () => {}, onScheduleAction: () => {},
  };
  const running = { ...props.priorityContext, runningSessionIds: new Set(['a']) };
  const view = render(<TaskInbox {...props} priorityContext={running} />);
  const pending = view.container.querySelector('section')!;
  const renderIdle = () => view.rerender(<TaskInbox {...props} />);
  fireEvent.mouseOver(screen.getByTestId('row'));
  renderIdle();
  expect(pending.contains(screen.getByTestId('row'))).toBe(true);
  const done = screen.getByRole('button', { name: 'complete:a' });
  fireEvent.mouseOver(done);
  view.rerender(<TaskInbox {...props} priorityContext={running} />);
  expect(pending.contains(done)).toBe(true);
  fireEvent.mouseOut(done, { relatedTarget: done.parentElement });
  expect(pending.contains(screen.getByTestId('row'))).toBe(false);
});

it('releases the layout when the hovered Done button disappears without a mouseout', async () => {
  const task = (id: string) => ({ id, title: id, status: 'active' }) as Session;
  const props: Parameters<typeof TaskInbox>[0] = {
    sessions: [task('a')], priorityContext: { runningSessionIds: new Set(), attentionSessionIds: new Set() },
    runningSessionIds: new Set(), attachedSessionIds: new Set(), notifications: new Set(),
    onSessionClick: () => {}, onAction: () => {}, onRename: () => {}, onTogglePin: () => {}, onScheduleAction: () => {},
  };
  const view = render(<TaskInbox {...props} />);
  fireEvent.mouseOver(screen.getByRole('button', { name: 'complete:a' }));
  view.rerender(<TaskInbox {...props} sessions={[task('b')]} />);
  expect(await screen.findByRole('button', { name: 'complete:b' })).toBeTruthy();
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
  if (hovered) fireEvent.mouseOver(screen.getByRole('button', { name: 'complete:b' }));
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
    fireEvent.mouseOut(screen.getByRole('button', { name: 'complete:b' }));
    expect(rows(0)).toContain('a');
    fireEvent.mouseOver(screen.getByRole('button', { name: 'complete:b' }));
    view.rerender(<TaskInbox {...props} priorityContext={{ ...props.priorityContext, runningSessionIds: new Set(['a']) }} />);
    // The previous completion marker was consumed and cannot release this new hover.
    expect(rows(0)).toContain('a');
  }
  fireEvent.mouseOut(screen.getByRole('button', { name: 'complete:b' }));
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
  fireEvent.mouseOver(screen.getByRole('button', { name: 'complete:a' }));
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
