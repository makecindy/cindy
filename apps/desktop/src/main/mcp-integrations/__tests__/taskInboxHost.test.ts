/**
 * Inbox "Done" and inbox signals on the owning computer (unit tier, injected fakes).
 *
 * Production entry: completeLocalSessions / readTaskInboxSignals behind complete_sessions and
 * list_sessions include_inbox.
 * Rule: docs/product-rules/task-inbox.md (a followed task is only marked read; running and
 * IM-taken-over tasks are never archived; unknown bindings count as none).
 * Gap: the sidebar applies these rules in the renderer only; nothing covered a host path.
 * Minimal failing inputs: a followed task (must not be archived), unknown automation bindings,
 * and a task that starts running before the write.
 */
import { describe, expect, it, vi } from 'vitest';

import { completeLocalSessions, readTaskInboxSignals, type TaskInboxCompleteDeps } from '../taskInboxHost.js';

function deps(overrides: Partial<TaskInboxCompleteDeps> = {}) {
  const rows: Record<string, { status: string; title: string }> = {
    plain: { status: 'active', title: 'Plain' },
    followed: { status: 'active', title: 'Followed' },
    busy: { status: 'active', title: 'Busy' },
    im: { status: 'active', title: 'IM' },
    archived: { status: 'archived', title: 'Old' },
    deleted: { status: 'deleted', title: 'Gone' },
  };
  const value = {
    readSession: vi.fn(async (id: string) => rows[id] ?? null),
    isBusy: vi.fn((id: string) => id === 'busy'),
    isImAttached: vi.fn((id: string) => id === 'im'),
    followingSessionIds: vi.fn(async () => new Set(['followed'])),
    markRead: vi.fn(async () => {}),
    archive: vi.fn(async (_id: string, recheck: () => void) => recheck()),
    ...overrides,
  } satisfies TaskInboxCompleteDeps;
  return value;
}

describe('completeLocalSessions', () => {
  it('marks a followed task read, archives the rest and reports every blocked task', async () => {
    const d = deps();
    const items = await completeLocalSessions(['plain', 'followed', 'busy', 'im', 'archived', 'deleted', 'missing'], d);
    expect(items.map(({ sessionId, outcome, reason }) => [sessionId, outcome, reason])).toEqual([
      ['plain', 'archived', undefined],
      ['followed', 'marked_read', undefined],
      ['busy', 'blocked', 'RUNNING'],
      ['im', 'blocked', 'IM_ATTACHED'],
      ['archived', 'already_archived', undefined],
      ['deleted', 'blocked', 'DELETED'],
      ['missing', 'blocked', 'NOT_FOUND'],
    ]);
    expect(vi.mocked(d.archive).mock.calls.map(([id]) => id)).toEqual(['plain']);
    expect(vi.mocked(d.markRead).mock.calls).toEqual([['followed']]);
    expect(d.followingSessionIds).toHaveBeenCalledTimes(1);
  });

  it('archives when the automation bindings cannot be read yet, like the sidebar', async () => {
    const unknownBindings = deps({ followingSessionIds: vi.fn(async () => null) });
    expect(await completeLocalSessions(['followed'], unknownBindings)).toMatchObject([{ outcome: 'archived' }]);
    expect(unknownBindings.markRead).not.toHaveBeenCalled();
  });

  it('rechecks running inside the archive write', async () => {
    let running = false;
    const d = deps({
      isBusy: () => running,
      archive: vi.fn(async (_id: string, recheck: () => void) => {
        running = true; // a send landed while the worktree preflight ran
        recheck();
      }),
    });
    expect(await completeLocalSessions(['plain'], d)).toMatchObject([{ outcome: 'blocked', reason: 'RUNNING' }]);
  });
});

describe('readTaskInboxSignals', () => {
  it('derives waiting, running and unread like the sidebar row status', async () => {
    const signals = await readTaskInboxSignals(['ask', 'run', 'done', 'seen', 'alert', 'run-alert', 'automation'], {
      liveActivity: () => [
        { sessionId: 'ask', phase: 'needs-interaction', attention: true },
        { sessionId: 'run', phase: 'running', attention: false },
        { sessionId: 'done', phase: 'completed', attention: true },
        { sessionId: 'seen', phase: 'completed', attention: false },
        { sessionId: 'run-alert', phase: 'running', attention: false },
      ],
      pendingAlertSessionIds: async () => new Set(['alert', 'run-alert']),
      followingSessionIds: async () => new Set(['automation']),
      unreadRunSessionIds: async () => new Set(['automation']),
    });
    const flags = (id: string) => signals[id];
    expect(flags('ask')).toMatchObject({ waiting: true, running: false, unread: false });
    expect(flags('run')).toMatchObject({ waiting: false, running: true });
    expect(flags('done')).toMatchObject({ waiting: false, unread: true });
    expect(flags('seen')).toMatchObject({ waiting: false, running: false, unread: false });
    // A stored error alert needs the user until a new round starts.
    expect(flags('alert')).toMatchObject({ waiting: true });
    expect(flags('run-alert')).toMatchObject({ waiting: false, running: true });
    expect(flags('automation')).toEqual({ waiting: false, running: false, unread: true, following: true });
  });
});
