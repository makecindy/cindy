// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { markGhostCardTaskSeen, requestGhostCardTaskArchive } from '@/cindy-brain/ghostCardTaskArchive';
import type { Session } from '@/lib/ccAgent.types';
import { useGhostCardTaskArchive } from '../useGhostCardTaskArchive';

const mocks = vi.hoisted(() => ({
  runSessionAction: vi.fn(),
  unarchiveSession: vi.fn(),
  running: new Map<string, { isRunning: boolean }>(),
  attached: false,
  schedules: [] as string[],
  preflight: 'clean' as 'clean' | 'dirty' | 'unknown',
  routeCurrent: false,
  toastSuccess: vi.fn(),
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/toast', () => ({ toast: { success: mocks.toastSuccess } }));
vi.mock('@/lib/makerChatStore', () => ({ makerChatStore: { getRunningSnapshot: () => mocks.running } }));
vi.mock('@/features/device-link/remoteSessionActivityStore', () => ({
  getRemoteSessionActivity: () => undefined,
  isRemoteSessionActivityActive: () => false,
}));
vi.mock('@/features/scheduler/lib/archiveScheduleWarning', () => ({
  loadActiveBoundScheduleNames: async () => new Map(mocks.schedules.length ? [['task', mocks.schedules]] : []),
}));
vi.mock('@/lib/worktreeRemovalWarning', () => ({ resolveWorktreeRemovalPreflight: async () => mocks.preflight }));
vi.mock('../../lib/sessionRemovalNavigation', () => ({ isSessionRemovalRouteCurrent: () => mocks.routeCurrent }));
vi.mock('../useSessionLifecycleActions', () => ({
  useSessionLifecycleActions: () => ({ runSessionAction: mocks.runSessionAction, unarchiveSession: mocks.unarchiveSession }),
}));

const session = { id: 'task', title: '#12 Fix it', status: 'active' } as Session;

// Rule (2026-11-06, PR card auto-archive): a merged PR's task is archived only after the user saw the
// merged card and left, and only when nothing could be lost; otherwise it silently stays. Production
// entry: the task page's hook, left by unmounting. The manual card button archives only its own task.
describe('useGhostCardTaskArchive', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(mocks, { attached: false, schedules: [], preflight: 'clean', routeCurrent: false });
    mocks.running.clear();
    mocks.runSessionAction.mockImplementation(async (_id: string, _action: string, options: { prepareArchive: (isCurrent: () => boolean) => Promise<boolean> }) =>
      (await options.prepareArchive(() => true)) ? true : undefined);
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      binding: { resolveSession: async () => ({ attached: mocks.attached }) },
    };
  });

  const leave = async (seen: boolean, autoArchive = true) => {
    const archive = vi.fn(async () => {});
    const hook = renderHook(() => useGhostCardTaskArchive({ session, archive, remoteWritesBlocked: false, autoArchive }));
    if (seen) markGhostCardTaskSeen('task');
    await act(async () => { hook.unmount(); });
    return archive;
  };

  it('archives a seen task on leaving and offers undo', async () => {
    await leave(true);
    expect(mocks.runSessionAction).toHaveBeenCalledWith('task', 'archive', expect.objectContaining({ activeSessionId: null }));
    expect(mocks.toastSuccess).toHaveBeenCalledTimes(1);
    mocks.toastSuccess.mock.calls[0][1].action.onClick();
    expect(mocks.unarchiveSession).toHaveBeenCalledWith('task');
  });

  it.each([
    ['not seen', () => {}, false],
    ['dirty worktree', () => { mocks.preflight = 'dirty'; }, true],
    ['unknown worktree state', () => { mocks.preflight = 'unknown'; }, true],
    ['bound automation', () => { mocks.schedules = ['PR #12']; }, true],
    ['taken over by IM', () => { mocks.attached = true; }, true],
    ['user is back on the task', () => { mocks.routeCurrent = true; }, true],
    ['agent still running', () => { mocks.running.set('task', { isRunning: true }); }, true],
  ] as const)('keeps the task when %s', async (_name, setup, seen) => {
    setup();
    await leave(seen);
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });

  it('does nothing on views that must not auto-archive', async () => {
    await leave(true, false);
    expect(mocks.runSessionAction).not.toHaveBeenCalled();
  });

  it('archives only its own task when the card button is clicked', () => {
    const archive = vi.fn(async () => {});
    renderHook(() => useGhostCardTaskArchive({ session, archive, remoteWritesBlocked: false, autoArchive: true }));
    requestGhostCardTaskArchive('other');
    expect(archive).not.toHaveBeenCalled();
    requestGhostCardTaskArchive('task');
    expect(archive).toHaveBeenCalledTimes(1);
  });
});
