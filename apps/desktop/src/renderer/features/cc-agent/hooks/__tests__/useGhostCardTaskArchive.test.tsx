// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  cancelGhostCardTaskAutoArchive,
  cancelPendingGhostCardTaskAutoArchive,
  isGhostCardTaskAutoArchivePending,
  markGhostCardTaskSeen,
  requestGhostCardTaskArchive,
  setGhostCardTaskAutoArchiveArmed,
} from '@/cindy-brain/ghostCardTaskArchive';
import type { Session } from '@/lib/ccAgent.types';
import { useGhostCardTaskArchive } from '../useGhostCardTaskArchive';

type Msg = { role: string; clientId: string; automationOrigin?: unknown; sourcePlugin?: unknown };

const mocks = vi.hoisted(() => ({
  runSessionAction: vi.fn(),
  unarchiveSession: vi.fn(),
  running: new Map<string, { isRunning: boolean }>(),
  chat: { historyLoaded: true, messages: [] as Msg[] },
  chatListeners: new Set<() => void>(),
  eligible: true,
  attached: false,
  schedules: [] as string[],
  schedulesKnown: true,
  preflight: 'clean' as 'clean' | 'dirty' | 'unknown',
  routeCurrent: false,
  draft: false,
  toastSuccess: vi.fn(),
  toastInfo: vi.fn(),
}));

vi.mock('@/contexts/PrRefsContext', () => ({
  useTaskPrArchiveEligibility: () => ({ eligible: mocks.eligible, checkEligibility: () => mocks.eligible }),
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/toast', () => ({ toast: { success: mocks.toastSuccess, info: mocks.toastInfo } }));
vi.mock('@/lib/makerChatStore', () => ({
  makerChatStore: {
    getRunningSnapshot: () => mocks.running,
    getSnapshot: () => mocks.chat,
    subscribe: (_id: string, cb: () => void) => { mocks.chatListeners.add(cb); return () => mocks.chatListeners.delete(cb); },
  },
}));
vi.mock('@/lib/composerDraftStore', () => ({ getDraftPresence: () => mocks.draft }));
vi.mock('@/features/scheduler/lib/archiveScheduleWarning', () => ({
  loadConfirmedActiveBoundScheduleNames: async (rows: Array<{ id: string }>) =>
    mocks.schedulesKnown ? new Map(mocks.schedules.length ? [[rows[0].id, mocks.schedules]] : []) : null,
}));
vi.mock('@/lib/worktreeRemovalWarning', () => ({ resolveWorktreeRemovalPreflight: async () => mocks.preflight }));
vi.mock('../../lib/sessionRemovalNavigation', () => ({ isSessionRemovalRouteCurrent: () => mocks.routeCurrent }));
vi.mock('../useSessionLifecycleActions', () => ({
  useSessionLifecycleActions: () => ({ runSessionAction: mocks.runSessionAction, unarchiveSession: mocks.unarchiveSession }),
}));

const chatChanged = (messages: Msg[], historyLoaded = true) => {
  mocks.chat = { historyLoaded, messages };
  for (const cb of mocks.chatListeners) cb();
};

// Rule (2026-11-06, PR card auto-archive): a merged PR's task is archived only after the user saw the
// merged card and left, only when nothing could be lost, and not once the user cancelled it on the card
// or wrote in the task after it became pending. Production entry: the task page's hook, left by
// unmounting, with the card side driven through the same module the card uses.
describe('useGhostCardTaskArchive', () => {
  let n = 0;
  let session: Session;
  beforeEach(() => {
    vi.clearAllMocks();
    session = { id: `task-${++n}`, title: '#12 Fix it', status: 'active' } as Session;
    Object.assign(mocks, { eligible: true, attached: false, schedules: [], schedulesKnown: true, preflight: 'clean', routeCurrent: false, draft: false });
    mocks.chat = { historyLoaded: true, messages: [{ role: 'user', clientId: 'u1' }] };
    mocks.running.clear();
    mocks.chatListeners.clear();
    mocks.runSessionAction.mockImplementation(async (_id: string, _action: string, options: { prepareArchive: (isCurrent: () => boolean) => Promise<boolean> }) =>
      (await options.prepareArchive(() => true)) ? true : undefined);
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      binding: { resolveSession: async () => ({ attached: mocks.attached }) },
    };
  });

  /** Open the task page, let the card arm (and optionally be seen), run `during`, then leave. */
  const visit = async ({ seen = true, autoArchive = true, during = () => {} }: { seen?: boolean; autoArchive?: boolean; during?: () => void } = {}) => {
    const archive = vi.fn(async () => {});
    const hook = renderHook(() => useGhostCardTaskArchive({ session, archive, remoteWritesBlocked: false, autoArchive }));
    setGhostCardTaskAutoArchiveArmed(session.id, 'card-1', true);
    if (seen) markGhostCardTaskSeen(session.id);
    during();
    await act(async () => { hook.unmount(); });
    return archive;
  };

  it('archives a seen task on leaving and offers undo', async () => {
    await visit({ during: () => expect(isGhostCardTaskAutoArchivePending(session.id)).toBe(true) });
    expect(mocks.runSessionAction).toHaveBeenCalledWith(session.id, 'archive', expect.objectContaining({ activeSessionId: null }));
    expect(mocks.toastSuccess).toHaveBeenCalledTimes(1);
    mocks.toastSuccess.mock.calls[0][1].action.onClick();
    expect(mocks.unarchiveSession).toHaveBeenCalledWith(session.id);
  });

  it('explains an uncommitted-worktree block without claiming success', async () => {
    mocks.preflight = 'dirty';
    await visit();
    expect(mocks.toastInfo).toHaveBeenCalledWith('chat.ghostCall.taskAutoArchiveBlockedDirty', { duration: 8000 });
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });

  // Regression: refs/statuses can change while the asynchronous preflight is running.
  it('rechecks all PRs after the archive preflight', async () => {
    mocks.runSessionAction.mockImplementation(async (_id, _action, options) => {
      mocks.eligible = false;
      return await options.prepareArchive(() => true) ? true : undefined;
    });
    await visit();
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });

  it('still archives when only automations or plugins wrote, or older history loads first', async () => {
    mocks.chat = { historyLoaded: false, messages: [] };
    await visit({ during: () => {
      chatChanged([{ role: 'user', clientId: 'u1' }]);
      chatChanged([{ role: 'user', clientId: 'u1' }, { role: 'user', clientId: 's1', automationOrigin: { kind: 'scheduler' } }]);
      chatChanged([{ role: 'user', clientId: 'u1' }, { role: 'user', clientId: 'p1', sourcePlugin: { id: 'cindy-github' } }]);
    } });
    expect(mocks.toastSuccess).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['not seen', { seen: false }],
    ['cancelled on the card', { during: () => cancelGhostCardTaskAutoArchive(session.id) }],
    ['someone wrote through an official IM hook after it became pending', { during: () => chatChanged([{ role: 'user', clientId: 'u1' }, { role: 'user', clientId: 'h1', automationOrigin: { kind: 'scheduler', scheduleId: 'hook:slack:team' } }]) }],
    ['the user wrote after it became pending', { during: () => chatChanged([{ role: 'user', clientId: 'u1' }, { role: 'user', clientId: 'u2' }]) }],
    ['a view that must not auto-archive', { autoArchive: false }],
  ] as const)('keeps the task when %s', async (_name, options) => {
    await visit(options);
    expect(mocks.runSessionAction).not.toHaveBeenCalled();
  });

  it.each([
    ['another PR is unfinished or unknown', () => { mocks.eligible = false; }],
    ['dirty worktree', () => { mocks.preflight = 'dirty'; }],
    ['unknown worktree state', () => { mocks.preflight = 'unknown'; }],
    ['bound automation', () => { mocks.schedules = ['PR #12']; }],
    ['bindings could not be read', () => { mocks.schedulesKnown = false; }],
    ['taken over by IM', () => { mocks.attached = true; }],
    ['user is back on the task', () => { mocks.routeCurrent = true; }],
    ['unsent draft', () => { mocks.draft = true; }],
    ['agent still running', () => { mocks.running.set(session.id, { isRunning: true }); }],
  ] as const)('keeps the task when %s', async (_name, setup) => {
    setup();
    await visit();
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });

  // Review of PR 9147, round 5 (convergence checkpoint). Invariant: the card's "archives when you leave" hint
  // is shown exactly when leaving would archive the task (everything checked at leave time being clean). The
  // earlier half-fix kept remote tasks out of the leave step only, so the hint promised an archive that never
  // came. Every static configuration is checked on both sides of that promise.
  it.each([
    ['an ordinary local task', {}, {}, true],
    ['a task on another computer', { deviceLinkDeviceId: 'mac-2' }, {}, false],
    ['an already archived task', { status: 'archived' }, {}, false],
    ['a view that must not auto-archive', {}, { autoArchive: false }, false],
    ['remote writes blocked', {}, { remoteWritesBlocked: true }, false],
  ] as const)('shows the pending hint exactly when leaving would archive: %s', async (_name, sessionPatch, view, promised) => {
    const task = { ...session, ...sessionPatch } as Session;
    const hook = renderHook(() => useGhostCardTaskArchive({
      session: task, archive: vi.fn(async () => {}), remoteWritesBlocked: false, autoArchive: true, ...view,
    }));
    setGhostCardTaskAutoArchiveArmed(task.id, 'card-1', true);
    markGhostCardTaskSeen(task.id);
    expect(isGhostCardTaskAutoArchivePending(task.id)).toBe(promised);
    await act(async () => { hook.unmount(); });
    expect(mocks.runSessionAction.mock.calls.length > 0).toBe(promised);
  });

  it('withdraws the hint when the task stops being eligible while it is open', async () => {
    const hook = renderHook(({ current }) => useGhostCardTaskArchive({ session: current, archive: vi.fn(async () => {}), remoteWritesBlocked: false, autoArchive: true }),
      { initialProps: { current: session } });
    setGhostCardTaskAutoArchiveArmed(session.id, 'card-1', true);
    expect(isGhostCardTaskAutoArchivePending(session.id)).toBe(true);
    await act(async () => { hook.rerender({ current: { ...session, status: 'archived' } as Session }); });
    expect(isGhostCardTaskAutoArchivePending(session.id)).toBe(false);
    await act(async () => { hook.unmount(); });
    expect(mocks.runSessionAction).not.toHaveBeenCalled();
  });

  // Review (#9147): going from task A straight to task B reuses the view, so B is already rendered when A's
  // cleanup runs; A must still be archived with A's own data.
  it('archives the task it left when the view switches straight to another task', async () => {
    const other = { id: `${session.id}-b`, title: 'B', status: 'active' } as Session;
    const archive = vi.fn(async () => {});
    const hook = renderHook(({ current }) => useGhostCardTaskArchive({ session: current, archive, remoteWritesBlocked: false, autoArchive: true }),
      { initialProps: { current: session } });
    setGhostCardTaskAutoArchiveArmed(session.id, 'card-1', true);
    markGhostCardTaskSeen(session.id);
    await act(async () => { hook.rerender({ current: other }); });
    expect(mocks.runSessionAction).toHaveBeenCalledWith(session.id, 'archive', expect.anything());
    expect(mocks.toastSuccess.mock.calls[0][0]).toBe('chat.ghostCall.taskAutoArchived');
    expect(mocks.runSessionAction).toHaveBeenCalledTimes(1);
  });

  // Review (#9147): a message sent before the PR merged must not cancel a later auto-archive.
  it('only a message sent after auto-archive became pending cancels it', async () => {
    cancelPendingGhostCardTaskAutoArchive(session.id);
    await visit();
    expect(mocks.toastSuccess).toHaveBeenCalledTimes(1);
    const another = { id: `${session.id}-c`, title: 'C', status: 'active' } as Session;
    const archive = vi.fn(async () => {});
    const hook = renderHook(() => useGhostCardTaskArchive({ session: another, archive, remoteWritesBlocked: false, autoArchive: true }));
    setGhostCardTaskAutoArchiveArmed(another.id, 'card-1', true);
    markGhostCardTaskSeen(another.id);
    cancelPendingGhostCardTaskAutoArchive(another.id);
    await act(async () => { hook.unmount(); });
    expect(mocks.runSessionAction).toHaveBeenCalledTimes(1);
  });

  // Review (#9147): with several eligible cards in one task, one card dropping out must not erase the others.
  it('stays pending while any card of the task is still eligible', async () => {
    const archive = vi.fn(async () => {});
    const hook = renderHook(() => useGhostCardTaskArchive({ session, archive, remoteWritesBlocked: false, autoArchive: true }));
    setGhostCardTaskAutoArchiveArmed(session.id, 'card-1', true);
    setGhostCardTaskAutoArchiveArmed(session.id, 'card-2', true);
    markGhostCardTaskSeen(session.id);
    setGhostCardTaskAutoArchiveArmed(session.id, 'card-1', false);
    expect(isGhostCardTaskAutoArchivePending(session.id)).toBe(true);
    await act(async () => { hook.unmount(); });
    expect(mocks.toastSuccess).toHaveBeenCalledTimes(1);
  });

  it('forgets a cancellation once no card of the task is eligible any more', () => {
    renderHook(() => useGhostCardTaskArchive({ session, archive: vi.fn(async () => {}), remoteWritesBlocked: false, autoArchive: true }));
    setGhostCardTaskAutoArchiveArmed(session.id, 'card-1', true);
    cancelGhostCardTaskAutoArchive(session.id);
    expect(isGhostCardTaskAutoArchivePending(session.id)).toBe(false);
    setGhostCardTaskAutoArchiveArmed(session.id, 'card-1', false);
    setGhostCardTaskAutoArchiveArmed(session.id, 'card-1', true);
    expect(isGhostCardTaskAutoArchivePending(session.id)).toBe(true);
  });

  it('archives only its own task when the card button is clicked', () => {
    const archive = vi.fn(async () => {});
    renderHook(() => useGhostCardTaskArchive({ session, archive, remoteWritesBlocked: false, autoArchive: true }));
    requestGhostCardTaskArchive('other');
    expect(archive).not.toHaveBeenCalled();
    requestGhostCardTaskArchive(session.id);
    expect(archive).toHaveBeenCalledTimes(1);
  });
});
