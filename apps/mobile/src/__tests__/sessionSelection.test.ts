import { beforeAll, describe, expect, it } from 'vitest';
import { i18n } from '@/i18n';
import {
  isMobileSessionBulkActionAvailable,
  mobileSessionBulkActionButtonLabel,
  mobileSessionBulkPatch,
  pruneSessionSelection,
  summarizeMobileSessionBulkAction,
  toggleSessionSelection,
  visibleMobileSessionBulkActions,
  visibleSessionIdsFromSections,
} from '@/session/sessionSelection';
import type { RemoteSession } from '@/session/types';
import type { RemoteSessionSection } from '@/session/sessionList';

beforeAll(async () => {
  await i18n.changeLanguage('zh-CN');
});

function session(id: string, patch: Partial<RemoteSession> = {}): RemoteSession {
  return {
    id,
    userId: 'user-1',
    title: id,
    workingDir: '/repo/app',
    workspaceKind: 'project',
    model: 'claude-sonnet-4-6',
    effort: 'medium',
    permissionMode: 'ask',
    fastMode: false,
    status: 'active',
    agentKind: 'cc',
    pinnedAt: null,
    userSendAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...patch,
  };
}

describe('mobile session selection', () => {
  it('toggles and prunes selection against visible rows', () => {
    expect(toggleSessionSelection(['s1'], 's2')).toEqual(['s1', 's2']);
    expect(toggleSessionSelection(['s1', 's2'], 's1')).toEqual(['s2']);
    expect(pruneSessionSelection(['s1', 's2', 's3'], ['s2', 's4'])).toEqual(['s2']);
  });

  it('flattens visible session ids from rendered sections', () => {
    const sections: RemoteSessionSection[] = [
      {
        key: 'pinned',
        title: '置顶',
        data: [{
          session: session('s1'),
          title: 's1',
          subtitle: '',
          detail: '',
          lastActivityAt: '',
          pendingInteractionCount: 0,
          scheduleInfo: null,
          automationGroup: {
            key: 'schedule:sched-1',
            baseKey: 'schedule:sched-1',
            title: 'Daily',
            sessionIds: ['s1', 's1b'],
            sessionCount: 2,
            primarySessionId: 's1',
            children: [],
            items: [],
          },
        }],
      },
      {
        key: 'project:/repo/app',
        title: 'app',
        data: [{
          session: session('s2'),
          title: 's2',
          subtitle: '',
          detail: '',
          lastActivityAt: '',
          pendingInteractionCount: 0,
          scheduleInfo: null,
        }],
      },
    ];

    expect(visibleSessionIdsFromSections(sections)).toEqual(['s1', 's1b', 's2']);
  });

  it('summarizes archive candidates and clears pin state in the patch', () => {
    const summary = summarizeMobileSessionBulkAction([
      session('active', { pinnedAt: '2026-01-01T00:00:00.000Z' }),
      session('archived', { status: 'archived' }),
      session('deleted', { status: 'deleted' }),
    ], 'archive');

    expect(summary.candidates.map((item) => item.id)).toEqual(['active']);
    expect(summary.skippedCount).toBe(2);
    expect(summary.description).toContain('跳过 2 个不适用的任务');
    expect(isMobileSessionBulkActionAvailable(summary)).toBe(true);
    expect(mobileSessionBulkActionButtonLabel(summary)).toBe('归档 1');
    expect(mobileSessionBulkPatch('archive')).toEqual({ status: 'archived', pinnedAt: null });
  });

  it('summarizes delete candidates without re-deleting deleted sessions', () => {
    const summary = summarizeMobileSessionBulkAction([
      session('active'),
      session('archived', { status: 'archived' }),
      session('deleted', { status: 'deleted' }),
    ], 'delete');

    expect(summary.candidates.map((item) => item.id)).toEqual(['active', 'archived']);
    expect(summary.skippedCount).toBe(1);
    expect(mobileSessionBulkPatch('delete')).toEqual({ status: 'deleted' });
  });

  it('summarizes restore candidates and patches archived sessions back to active', () => {
    const summary = summarizeMobileSessionBulkAction([
      session('active'),
      session('archived', { status: 'archived' }),
      session('deleted', { status: 'deleted' }),
    ], 'restore');

    expect(summary.candidates.map((item) => item.id)).toEqual(['archived']);
    expect(summary.skippedCount).toBe(2);
    expect(summary.description).toContain('跳过 2 个不适用的任务');
    expect(mobileSessionBulkPatch('restore')).toEqual({ status: 'active' });
  });

  it('summarizes pin candidates and stamps pinnedAt once for the bulk patch', () => {
    const summary = summarizeMobileSessionBulkAction([
      session('active'),
      session('pinned', { pinnedAt: '2026-01-01T00:00:00.000Z' }),
      session('archived', { status: 'archived' }),
      session('deleted', { status: 'deleted' }),
    ], 'pin');

    expect(summary.candidates.map((item) => item.id)).toEqual(['active']);
    expect(summary.skippedCount).toBe(3);
    expect(mobileSessionBulkPatch('pin', Date.parse('2026-01-01T00:05:00.000Z'))).toEqual({
      pinnedAt: '2026-01-01T00:05:00.000Z',
    });
  });

  it('summarizes unpin candidates without touching unpinned rows', () => {
    const summary = summarizeMobileSessionBulkAction([
      session('active'),
      session('pinned', { pinnedAt: '2026-01-01T00:00:00.000Z' }),
      session('deleted-pinned', { status: 'deleted', pinnedAt: '2026-01-01T00:00:00.000Z' }),
    ], 'unpin');

    expect(summary.candidates.map((item) => item.id)).toEqual(['pinned']);
    expect(summary.skippedCount).toBe(2);
    expect(mobileSessionBulkPatch('unpin')).toEqual({ pinnedAt: null });
  });

  it('marks unavailable bulk actions and keeps their button label stable', () => {
    const summary = summarizeMobileSessionBulkAction([
      session('active'),
      session('deleted', { status: 'deleted' }),
    ], 'restore');

    expect(summary.candidates).toEqual([]);
    expect(isMobileSessionBulkActionAvailable(summary)).toBe(false);
    expect(mobileSessionBulkActionButtonLabel(summary)).toBe('恢复');
  });

  it('only exposes executable bulk actions for the mobile action bar', () => {
    const active = session('active');
    const pinned = session('pinned', { pinnedAt: '2026-01-01T00:00:00.000Z' });
    const summaries = {
      archive: summarizeMobileSessionBulkAction([active, pinned], 'archive'),
      delete: summarizeMobileSessionBulkAction([active, pinned], 'delete'),
      pin: summarizeMobileSessionBulkAction([active, pinned], 'pin'),
      restore: summarizeMobileSessionBulkAction([active, pinned], 'restore'),
      unpin: summarizeMobileSessionBulkAction([active, pinned], 'unpin'),
    };

    expect(visibleMobileSessionBulkActions(summaries)).toEqual({
      primary: ['pin', 'unpin', 'archive'],
      destructive: ['delete'],
    });
  });
});
