// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  cancelGhostCardTaskAutoArchive,
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
  attached: false,
  schedules: [] as string[],
  preflight: 'clean' as 'clean' | 'dirty' | 'unknown',
  routeCurrent: false,
  draft: false,
  toastSuccess: vi.fn(),
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/toast', () => ({ toast: { success: mocks.toastSuccess } }));
vi.mock('@/lib/makerChatStore', () => ({
  makerChatStore: {
    getRunningSnapshot: () => mocks.running,
    getSnapshot: () => mocks.chat,
    subscribe: (_id: string, cb: () => void) => { mocks.chatListeners.add(cb); return () => mocks.chatListeners.delete(cb); },
  },
}));
vi.mock('@/lib/composerDraftStore', () => ({ getDraftPresence: () => mocks.draft }));
vi.mock('@/features/device-link/remoteSessionActivityStore', () => ({
  getRemoteSessionActivity: () => undefined,
  isRemoteSessionActivityActive: () => false,
}));
vi.mock('@/features/scheduler/lib/archiveScheduleWarning', () => ({
  loadActiveBoundScheduleNames: async (rows: Array<{ id: string }>) =>
    new Map(mocks.schedules.length ? [[rows[0].id, mocks.schedules]] : []),
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
    Object.assign(mocks, { attached: false, schedules: [], preflight: 'clean', routeCurrent: false, draft: false });
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
    setGhostCardTaskAutoArchiveArmed(session.id, true);
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
    ['the user wrote after it became pending', { during: () => chatChanged([{ role: 'user', clientId: 'u1' }, { role: 'user', clientId: 'u2' }]) }],
    ['a view that must not auto-archive', { autoArchive: false }],
  ] as const)('keeps the task when %s', async (_name, options) => {
    await visit(options);
    expect(mocks.runSessionAction).not.toHaveBeenCalled();
  });

  it.each([
    ['dirty worktree', () => { mocks.preflight = 'dirty'; }],
    ['unknown worktree state', () => { mocks.preflight = 'unknown'; }],
    ['bound automation', () => { mocks.schedules = ['PR #12']; }],
    ['taken over by IM', () => { mocks.attached = true; }],
    ['user is back on the task', () => { mocks.routeCurrent = true; }],
    ['unsent draft', () => { mocks.draft = true; }],
    ['agent still running', () => { mocks.running.set(session.id, { isRunning: true }); }],
  ] as const)('keeps the task when %s', async (_name, setup) => {
    setup();
    await visit();
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
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
