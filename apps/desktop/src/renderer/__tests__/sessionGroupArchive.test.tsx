// @vitest-environment jsdom

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionGroupArchive } from '@/features/cc-agent/hooks/useSessionGroupArchive';
import {
  projectIdentityKeyForSession,
  type ProjectNode,
} from '@/features/cc-agent/lib/projectGrouping';
import type { FilterStatus } from '@/features/cc-agent/hooks/useSidebarFilter';
import type { Session } from '@/lib/ccAgent.types';
import * as sessionService from '@/lib/sessionService';
import { makerChatStore } from '@/lib/makerChatStore';
import { emitRefresh } from '@/lib/sessionsBus';
import { toast } from '@/lib/toast';
import type { ConfirmOptions } from '@/components/ui/confirm-dialog-provider';
import type { AutomationScheduleSessionInfo } from '@/features/cc-agent/lib/automationSidebarGrouping';

const liveRunning = vi.hoisted(() => new Map<string, { isRunning: boolean }>());

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, args?: Record<string, unknown>) =>
      args ? `${key}:${JSON.stringify(args)}` : key,
  }),
}));
vi.mock('@/lib/sessionService', () => ({
  get: vi.fn(),
  setStatus: vi.fn(),
  restoreIfArchived: vi.fn(),
  resolveStatusWriteTarget: vi.fn(),
}));
vi.mock('@/lib/makerChatStore', () => ({
  makerChatStore: {
    closeSessionQuery: vi.fn(),
    purgeSession: vi.fn(),
    getRunningSnapshot: () => liveRunning,
  },
}));
vi.mock('@/lib/composerDraftStore', () => ({ discardDraft: vi.fn() }));
vi.mock('@/lib/sessionsBus', () => ({ emitRefresh: vi.fn() }));
vi.mock('@/lib/toast', () => ({ toast: { warning: vi.fn(), success: vi.fn(), error: vi.fn() } }));

const worktreeRemovalPreview = vi.fn();
const resolveSession = vi.fn();

function automationScope(members: Session[]) {
  return {
    kind: 'automation' as const,
    group: {
      id: 'schedule:automation',
      scheduleId: 'automation',
      title: 'Automation',
      sessions: members,
      attentionSessionIds: [],
    },
    scheduleSessionIndex: new Map(
      members.map((s) => [
        s.id,
        {
          scheduleId: 'automation',
          scheduleName: 'Automation',
        } as AutomationScheduleSessionInfo,
      ]),
    ),
  };
}

// Value: invoke the production group lifecycle and inspect persisted writes,
// confirmation scope and cleanup. The existing candidate-selector unit tests
// do not exercise this orchestration. Rule: dedicated dialogue menu must not
// affect project/Bot/Make tasks or a local subset of a remote/mixed group.
// The old source-count assertion broke when #6575 extracted this hook; exercise
// real worktree preflight through IPC instead, including warning/cancel timing.
// Minimal input: one eligible member plus pinned/running/foreign records.
// Tier: unit; in-memory persistence and immediate confirmations, no real waits.
// Standalone: pnpm wall 3.64s / Vitest 2.31s (tests 21ms); first cold load 23.06s
// spent 14.21s initializing jsdom and 8.44s collecting modules (tests 25ms).
function session(id: string, patch: Partial<Session> = {}): Session {
  return {
    id,
    title: id,
    status: 'active',
    workspaceKind: 'dialogue',
    pinnedAt: null,
    workingDir: `/dialogues/${id}`,
    ...patch,
  } as Session;
}

function mount(sessions: Session[], status: FilterStatus = 'active') {
  const writes = new Map(sessions.map((s) => [s.id, s]));
  vi.mocked(sessionService.get).mockImplementation(async (id) => ({ ...writes.get(id)! }));
  vi.mocked(sessionService.setStatus).mockImplementation(async (id, nextStatus) => {
    const updated = { ...writes.get(id)!, status: nextStatus };
    writes.set(id, updated);
    return updated;
  });
  const options = {
    sessions,
    status,
    runningSessionIds: new Set(['running']),
    viewedSessionId: 'eligible',
    confirmDialog: vi.fn<(options: ConfirmOptions) => Promise<boolean>>(async () => true),
    refreshSessions: vi.fn(async () => undefined),
    patchLocal: vi.fn(),
    navigate: vi.fn(),
  };
  const view = renderHook(() => useSessionGroupArchive(options));
  return { ...view, options, writes };
}

beforeEach(() => {
  vi.clearAllMocks();
  liveRunning.clear();
  vi.mocked(sessionService.resolveStatusWriteTarget).mockResolvedValue({ kind: 'local' });
  resolveSession.mockReset().mockResolvedValue({ attached: false });
  worktreeRemovalPreview.mockReset().mockResolvedValue({ hasWorktree: true, dirty: false });
  vi.stubGlobal('electronAPI', { worktreeRemovalPreview, binding: { resolveSession } });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('session group bulk lifecycle', () => {
  // Review #7539: candidates captured before confirmation can become pinned,
  // deleted, archived or leave their automation before the persisted write.
  // Earlier running/takeover regressions did not change persisted metadata.
  // Minimal input: two automation members, one changed during confirmation;
  // invoke the production hook and verify persisted state and cleanup. Tier: unit.
  // Six regressions fail before the fix. Standalone after fix: Vitest 2.19s
  // (21 tests, 33ms), pnpm wall 3.87s on Windows (2026-10-27).
  it.each([
    ['pinned', { pinnedAt: '2026-10-27' }],
    ['deleted', { status: 'deleted' }],
    ['archived', { status: 'archived' }],
    ['moved out of the automation', { source: undefined }],
  ] satisfies [string, Partial<Session>][])(
    'preserves a member that becomes %s while confirmation is open',
    async (_change, patch) => {
      const runs = [
        session('eligible', { source: 'scheduler' }),
        session('other', { source: 'scheduler' }),
      ];
      const view = mount(runs);
      view.options.confirmDialog.mockImplementation(async () => {
        view.writes.set('eligible', { ...runs[0], ...patch });
        return true;
      });
      await act(async () => {
        await view.result.current(automationScope(runs));
      });
      expect(view.writes.get('eligible')).toEqual({ ...runs[0], ...patch });
      expect(view.writes.get('other')?.status).toBe('archived');
      expect(makerChatStore.closeSessionQuery).not.toHaveBeenCalledWith('eligible');
      expect(makerChatStore.purgeSession).not.toHaveBeenCalledWith('eligible');
      expect(view.options.patchLocal).not.toHaveBeenCalledWith('eligible', expect.anything());
      expect(view.options.navigate).not.toHaveBeenCalled();
      expect(toast.success).toHaveBeenCalledWith('ccAgent.sidebar.archiveAll.archived:{"count":1}');
      if ('pinnedAt' in patch && patch.pinnedAt) {
        expect(toast.warning).toHaveBeenCalledWith(expect.stringContaining('skipPinned'));
      }
    },
  );

  it('keeps a later member pinned during an earlier archive write', async () => {
    const runs = [
      session('first', { source: 'scheduler' }),
      session('eligible', { source: 'scheduler' }),
    ];
    const view = mount(runs);
    vi.mocked(sessionService.setStatus).mockImplementation(async (id, status) => {
      const updated = { ...view.writes.get(id)!, status };
      view.writes.set(id, updated);
      view.writes.set('eligible', { ...view.writes.get('eligible')!, pinnedAt: '2026-10-27' });
      return updated;
    });
    await act(async () => {
      await view.result.current(automationScope(runs));
    });
    expect(view.writes.get('eligible')?.status).toBe('active');
    expect(view.writes.get('eligible')?.pinnedAt).toBe('2026-10-27');
    expect(makerChatStore.closeSessionQuery).toHaveBeenCalledExactlyOnceWith('first');
    expect(view.options.navigate).not.toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith('ccAgent.sidebar.archiveAll.archived:{"count":1}');
  });

  it('preserves a run that starts during the final metadata read', async () => {
    const runs = [session('eligible', { source: 'scheduler' })];
    const view = mount(runs);
    vi.mocked(sessionService.get).mockImplementation(async () => {
      liveRunning.set('eligible', { isRunning: true });
      return runs[0];
    });
    await act(async () => {
      await view.result.current(automationScope(runs));
    });
    expect(view.writes.get('eligible')?.status).toBe('active');
    expect(makerChatStore.closeSessionQuery).not.toHaveBeenCalled();
    expect(sessionService.setStatus).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  // Review P1 regression: the new automation entry bypassed IM takeover checks
  // and used candidates fixed before confirmation. Earlier tests had neither
  // attached records nor state changes during awaits. Exercise real hook writes,
  // query shutdown and result counts. Minimal input: one protected + one idle run.
  // Tier: unit; deferred promises model confirmation/IPC timing without sleeps.
  it.each([false, true])(
    'excludes attached runs before confirmation (all attached=%s)',
    async (allAttached) => {
      const runs = [
        session('eligible', { source: 'scheduler' }),
        session('attached', { source: 'scheduler' }),
      ];
      const view = mount(runs);
      resolveSession.mockImplementation(async (id) => ({
        attached: allAttached || id === 'attached',
      }));
      await act(async () => {
        await view.result.current(automationScope(runs));
      });
      expect(view.writes.get('attached')?.status).toBe('active');
      expect(makerChatStore.closeSessionQuery).not.toHaveBeenCalledWith('attached');
      expect(worktreeRemovalPreview).not.toHaveBeenCalledWith('attached');
      if (allAttached) {
        expect(view.options.confirmDialog).not.toHaveBeenCalled();
        expect(sessionService.setStatus).not.toHaveBeenCalled();
        expect(toast.warning).toHaveBeenCalledWith(expect.stringContaining('skipAttached'));
      } else {
        expect(view.writes.get('eligible')?.status).toBe('archived');
        expect(view.options.confirmDialog.mock.calls[0][0].description).toContain('skipAttached');
        expect(toast.success).toHaveBeenCalledWith(
          'ccAgent.sidebar.archiveAll.archived:{"count":1}',
        );
      }
    },
  );

  it.each(['running', 'attached'] as const)(
    'preserves a run that becomes %s while confirmation is open',
    async (change) => {
      const runs = [
        session('eligible', { source: 'scheduler' }),
        session('other', { source: 'scheduler' }),
      ];
      const view = mount(runs);
      let confirm!: (ok: boolean) => void;
      view.options.confirmDialog.mockReturnValue(
        new Promise((resolve) => {
          confirm = resolve;
        }),
      );
      let archive!: Promise<void>;
      await act(async () => {
        archive = view.result.current(automationScope(runs));
      });
      expect(view.options.confirmDialog).toHaveBeenCalledOnce();
      await act(async () => {
        if (change === 'running') {
          liveRunning.set('eligible', { isRunning: true });
          view.options.runningSessionIds = new Set(['running', 'eligible']);
          view.rerender();
        } else {
          resolveSession.mockImplementation(async (id) => ({ attached: id === 'eligible' }));
        }
        confirm(true);
        await archive;
      });
      expect(view.writes.get('eligible')?.status).toBe('active');
      expect(view.writes.get('other')?.status).toBe('archived');
      expect(makerChatStore.closeSessionQuery).not.toHaveBeenCalledWith('eligible');
      expect(makerChatStore.purgeSession).not.toHaveBeenCalledWith('eligible');
      expect(view.options.navigate).not.toHaveBeenCalled();
      expect(toast.success).toHaveBeenCalledWith('ccAgent.sidebar.archiveAll.archived:{"count":1}');
      expect(toast.warning).toHaveBeenCalledWith(
        expect.stringContaining(change === 'running' ? 'skipRunning' : 'skipAttached'),
      );
    },
  );

  it('checks live running state after the binding lookup and before closing a query', async () => {
    const runs = [session('eligible', { source: 'scheduler' })];
    const view = mount(runs);
    let binding!: (value: { attached: boolean }) => void;
    resolveSession.mockResolvedValueOnce({ attached: false }).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          binding = resolve;
        }),
    );
    let archive!: Promise<void>;
    await act(async () => {
      archive = view.result.current(automationScope(runs));
    });
    expect(resolveSession).toHaveBeenCalledTimes(2);
    await act(async () => {
      liveRunning.set('eligible', { isRunning: true });
      binding({ attached: false });
      await archive;
    });
    expect(view.writes.get('eligible')?.status).toBe('active');
    expect(makerChatStore.closeSessionQuery).not.toHaveBeenCalled();
    expect(sessionService.setStatus).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('preserves a later member that starts running during an earlier archive write', async () => {
    const runs = [
      session('first', { source: 'scheduler' }),
      session('eligible', { source: 'scheduler' }),
    ];
    const view = mount(runs);
    vi.mocked(sessionService.setStatus).mockImplementation(async (id, status) => {
      const updated = { ...view.writes.get(id)!, status };
      view.writes.set(id, updated);
      liveRunning.set('eligible', { isRunning: true });
      return updated;
    });
    await act(async () => {
      await view.result.current(automationScope(runs));
    });
    expect(view.writes.get('first')?.status).toBe('archived');
    expect(view.writes.get('eligible')?.status).toBe('active');
    expect(makerChatStore.closeSessionQuery).toHaveBeenCalledExactlyOnceWith('first');
    expect(view.options.navigate).not.toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith('ccAgent.sidebar.archiveAll.archived:{"count":1}');
  });

  // Feature: archive an automation from its group menu. Existing dialogue/project
  // tests cannot detect matching by title or limiting writes to visible children.
  // Minimal input: one displayed run, one hidden run and a same-title foreign run.
  // Tier: unit, exercising the production hook with in-memory persistence.
  // Standalone validation: Vitest 2.13s, tests 22ms (2026-10-27).
  it('archives the whole automation by identity, including hidden runs, without restoring archived runs', async () => {
    const runs = ['eligible', 'hidden', 'running', 'pinned', 'archived', 'foreign', 'remote'].map(
      (id) =>
        session(id, {
          source: 'scheduler',
          title: 'Same name',
          ...(id === 'pinned' ? { pinnedAt: '2026-10-27' } : {}),
          ...(id === 'archived' ? { status: 'archived' as const } : {}),
          ...(id === 'remote' ? { deviceLinkDeviceId: 'other-computer' } : {}),
        }),
    );
    const scheduleSessionIndex = new Map(
      runs.map((run) => [
        run.id,
        {
          scheduleId: run.id === 'foreign' ? 'other' : 'automation',
          scheduleName: 'Same name',
        } as AutomationScheduleSessionInfo,
      ]),
    );
    const view = mount(runs, 'all');
    await act(async () => {
      await view.result.current({
        kind: 'automation',
        group: {
          id: 'schedule:automation',
          scheduleId: 'automation',
          title: 'Same name',
          sessions: [runs[0]],
          attentionSessionIds: [],
        },
        scheduleSessionIndex,
      });
    });
    expect(
      [...view.writes.values()].filter((s) => s.status === 'archived').map((s) => s.id),
    ).toEqual(['eligible', 'hidden', 'archived']);
    expect(view.options.confirmDialog.mock.calls[0][0].description).toContain(
      'automationArchiveAll.descriptionWithSkip:{"count":2',
    );
    expect(sessionService.restoreIfArchived).not.toHaveBeenCalled();
    expect(view.options.navigate).toHaveBeenCalledWith('/cc-agent');
  });

  it('rejects an automation owned by another computer before confirming or writing', async () => {
    const runs = [session('eligible')];
    const view = mount(runs);
    await act(async () => {
      await view.result.current({
        kind: 'automation',
        group: {
          id: 'schedule:automation',
          title: 'Automation',
          deviceLinkDeviceId: 'other-computer',
          sessions: runs,
          attentionSessionIds: [],
        },
        scheduleSessionIndex: new Map(),
      });
    });
    expect(view.options.confirmDialog).not.toHaveBeenCalled();
    expect(sessionService.setStatus).not.toHaveBeenCalled();
    expect(toast.warning).toHaveBeenCalledWith('ccAgent.remoteSession.actionsUnavailable');
  });

  it.each([false, true])(
    'archives only eligible dialogue members with dirty=%s warning and normal cleanup',
    async (dirty) => {
      const members = [
        session('eligible'),
        session('running'),
        session('pinned', { pinnedAt: '2026-10-21' }),
        session('archived', { status: 'archived' }),
      ];
      const foreign = [
        session('project', { workspaceKind: 'project' }),
        session('bot'),
        session('make'),
      ];
      const view = mount([...members, ...foreign]);
      worktreeRemovalPreview.mockResolvedValue({ hasWorktree: true, dirty });
      await act(async () => {
        await view.result.current({ kind: 'dialogue', sessions: members });
      });
      expect(view.writes.get('eligible')?.status).toBe('archived');
      expect(
        [...view.writes.values()].filter((s) => s.status === 'archived').map((s) => s.id),
      ).toEqual(['eligible', 'archived']);
      const description = view.options.confirmDialog.mock.calls[0][0].description;
      expect(description).toContain('ccAgent.sidebar.dialogueArchiveAll.descriptionWithSkip');
      expect(description).toContain('"count":1');
      expect(description).toContain('skipPinned');
      expect(description).toContain('skipRunning');
      expect(worktreeRemovalPreview).toHaveBeenCalledExactlyOnceWith('eligible');
      if (dirty) {
        expect(description).toContain(
          'ccAgent.sidebar.bulkSelection.confirmArchive.dirtyWorktreeWarning:{"count":1}',
        );
      } else {
        expect(description).not.toContain('dirtyWorktreeWarning');
      }
      expect(makerChatStore.closeSessionQuery).toHaveBeenCalledExactlyOnceWith('eligible');
      expect(makerChatStore.purgeSession).toHaveBeenCalledExactlyOnceWith('eligible');
      expect(view.options.navigate).toHaveBeenCalledWith('/cc-agent');
    },
  );

  it('waits for preflight and leaves records and active queries untouched when the dirty warning is cancelled', async () => {
    const members = [session('eligible')];
    const view = mount(members);
    view.options.confirmDialog.mockResolvedValue(false);
    let resolvePreview!: (preview: { hasWorktree: boolean; dirty: boolean }) => void;
    worktreeRemovalPreview.mockReturnValue(
      new Promise((resolve) => {
        resolvePreview = resolve;
      }),
    );
    await act(async () => {
      const archive = view.result.current({ kind: 'dialogue', sessions: members });
      expect(view.options.confirmDialog).not.toHaveBeenCalled();
      expect(sessionService.setStatus).not.toHaveBeenCalled();
      expect(makerChatStore.closeSessionQuery).not.toHaveBeenCalled();
      resolvePreview({ hasWorktree: true, dirty: true });
      await archive;
    });
    expect(view.options.confirmDialog.mock.calls[0][0].description).toContain(
      'ccAgent.sidebar.bulkSelection.confirmArchive.dirtyWorktreeWarning:{"count":1}',
    );
    expect(view.writes.get('eligible')?.status).toBe('active');
    expect(sessionService.setStatus).not.toHaveBeenCalled();
    expect(makerChatStore.closeSessionQuery).not.toHaveBeenCalled();
    expect(makerChatStore.purgeSession).not.toHaveBeenCalled();
    expect(view.options.refreshSessions).not.toHaveBeenCalled();
  });

  it('restores archived members with identity checks and reports partial failures without archiving active tasks', async () => {
    const members = [
      session('eligible'),
      session('restored', { status: 'archived' }),
      session('moved', { status: 'archived' }),
      session('failed', { status: 'archived' }),
    ];
    const view = mount(members, 'archived');
    vi.mocked(sessionService.restoreIfArchived)
      .mockResolvedValueOnce({ ...members[1], status: 'active' })
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error('write failed'));
    await act(async () => {
      await view.result.current({ kind: 'dialogue', sessions: members });
    });
    expect(vi.mocked(sessionService.restoreIfArchived).mock.calls).toEqual(
      members.slice(1).map((s) => [s.id, s]),
    );
    expect(view.options.patchLocal).toHaveBeenCalledExactlyOnceWith('restored', {
      status: 'active',
    });
    expect(view.options.confirmDialog.mock.calls[0][0].description).toContain(
      'dialogueRestoreAll.description',
    );
    expect(toast.error).toHaveBeenCalledWith(
      'ccAgent.sidebar.unarchiveAll.partialFailure:{"ok":1,"fail":2}',
    );
    expect(emitRefresh).toHaveBeenCalledOnce();
    expect(sessionService.setStatus).not.toHaveBeenCalled();
    expect(makerChatStore.closeSessionQuery).not.toHaveBeenCalled();
  });

  it.each(['active', 'archived'] as const)(
    'rejects remote/mixed groups before any %s writes even when invoked directly',
    async (status) => {
      const members = [
        session('eligible', { status }),
        session('remote', { status, deviceLinkDeviceId: 'remote' }),
      ];
      const view = mount(members, status);
      await act(async () => {
        await view.result.current({ kind: 'dialogue', sessions: members });
      });
      expect(view.options.confirmDialog).not.toHaveBeenCalled();
      expect(sessionService.setStatus).not.toHaveBeenCalled();
      expect(sessionService.restoreIfArchived).not.toHaveBeenCalled();
      expect(toast.warning).toHaveBeenCalledWith(
        'ccAgent.sidebar.dialogueAction.remoteBulkUnavailable',
      );
    },
  );

  it('retains project scope and project wording through the shared lifecycle', async () => {
    const projectTask = session('project', { workspaceKind: 'project', workingDir: '/repo' });
    const view = mount([projectTask, session('dialogue')]);
    const project = {
      projectKey: projectIdentityKeyForSession(projectTask),
      sessions: [projectTask],
    } as ProjectNode;
    worktreeRemovalPreview.mockResolvedValue({ hasWorktree: true, dirty: true });
    await act(async () => {
      await view.result.current({ kind: 'project', project });
    });
    expect(view.writes.get('project')?.status).toBe('archived');
    expect(view.writes.get('dialogue')?.status).toBe('active');
    expect(view.options.confirmDialog.mock.calls[0][0].description).toContain(
      'ccAgent.sidebar.archiveAll.description',
    );
    expect(view.options.confirmDialog.mock.calls[0][0].description).toContain(
      'ccAgent.sidebar.bulkSelection.confirmArchive.dirtyWorktreeWarning:{"count":1}',
    );
    expect(worktreeRemovalPreview).toHaveBeenCalledExactlyOnceWith('project');
  });
});
