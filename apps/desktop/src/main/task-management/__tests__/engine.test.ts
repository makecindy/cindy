import { describe, expect, it, vi } from 'vitest';
import { createTaskArchiveEngine } from '../engine.js';
import type { ArchiveCandidateRow, ArchiveProtection } from '../eligibility.js';
import {
  TASK_ARCHIVE_DAY_MS as DAY,
  type TaskArchiveSettings,
} from '../../../shared/taskManagement.js';

// #10310, unit: ordinary archive tests do not exercise an idle scan or its races.
// Minimal input: one old active task; mutations below must preserve newer work.
function fixture() {
  let now = 40 * DAY;
  let scope = 'owner-a:1';
  const settings: TaskArchiveSettings = { enabled: true, days: 7 };
  const restored: Record<string, number> = {};
  const protection: ArchiveProtection = {
    ready: true,
    viewed: new Set(),
    drafts: new Set(),
    remoteUnknown: false,
  };
  const rows = new Map<string, ArchiveCandidateRow>();
  const add = (id: string, patch: Partial<ArchiveCandidateRow> = {}) => {
    const row: ArchiveCandidateRow = {
      id,
      status: 'active',
      updatedAt: DAY,
      lastActivityAt: DAY,
      pinnedAt: null,
      hiddenAt: null,
      source: 'desktop',
      worktreePath: null,
      remoteHostId: null,
      agentDeviceId: null,
      orcaRole: null,
      orcaRemoteLead: null,
      activeTurnStartedAt: null,
      lastTurnEndedAt: null,
      automation: 0,
      goal: 0,
      shared: 0,
      queued: 0,
      attached: 0,
      ...patch,
    };
    rows.set(id, row);
    return row;
  };
  const ports = {
    scope: () => scope,
    ownerId: () => scope.split(':')[0],
    settings: () => settings,
    canRun: () => true,
    restoredAt: () => restored,
    countActive: vi.fn(
      async () => [...rows.values()].filter((row) => row.status === 'active').length,
    ),
    list: vi.fn(async (after: string) =>
      [...rows.values()]
        .filter((row) => row.id > after && row.status === 'active')
        .sort((a, b) => a.id.localeCompare(b.id))
        .slice(0, 2)
        .map((row) => ({ ...row })),
    ),
    read: vi.fn(async (id: string) => rows.get(id)),
    protection: () => protection,
    busy: vi.fn((_id: string) => false),
    waiting: vi.fn((_id: string) => false),
    pending: vi.fn(async (_id: string) => false),
    withLock: async <T>(_id: string, run: () => Promise<T>) => run(),
    archive: vi.fn(async (id: string, _cutoff: number, beforeWrite: () => void) => {
      beforeWrite();
      const row = rows.get(id)!;
      row.status = 'archived';
      row.updatedAt = now;
      return now;
    }),
    restore: vi.fn(async (id: string, beforeWrite: () => void) => {
      beforeWrite();
      rows.get(id)!.status = 'active';
      restored[id] = now;
    }),
    notice: vi.fn(),
    now: () => now,
    warn: vi.fn(),
    yieldToUser: vi.fn(async () => {}),
  };
  const engine = createTaskArchiveEngine(ports);
  return {
    engine,
    ports,
    rows,
    add,
    settings,
    restored,
    protection,
    advance: (days: number) => {
      now += days * DAY;
    },
    switchOwner: () => {
      scope = 'owner-b:2';
      engine.invalidate();
    },
  };
}

describe('idle archive lifecycle', () => {
  it('counts no candidates while disabled, then uses the selected days before archiving through the lifecycle port', async () => {
    const f = fixture();
    f.add('a');
    f.add('b', { source: 'plugin' });
    f.add('c', { source: 'shared' });
    f.settings.enabled = false;
    await f.engine.check(true);
    expect(f.ports.archive).not.toHaveBeenCalled();
    expect(await f.engine.preview()).toEqual({
      candidateCount: 0,
      keptCount: 3,
      lastCheckAt: null,
    });
    expect(f.ports.list).not.toHaveBeenCalled();
    expect(f.ports.countActive).toHaveBeenCalledOnce();
    f.settings.enabled = true;
    expect((await f.engine.preview()).candidateCount).toBe(3);
    f.settings.days = 40;
    expect((await f.engine.preview()).candidateCount).toBe(0);
    f.settings.days = 7;
    await Promise.all([f.engine.check(true), f.engine.check(true)]);
    expect([...f.rows.values()].map((row) => row.status)).toEqual([
      'archived',
      'archived',
      'archived',
    ]);
    expect(f.ports.archive).toHaveBeenCalledTimes(3);
    expect(f.ports.notice).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: 'owner-a', count: 3 }),
    );
  });

  it('keeps drafts, viewed tasks, pinned tasks, runtime work and managed lifecycles', async () => {
    const f = fixture();
    f.add('draft');
    f.protection.drafts = new Set(['draft']);
    f.add('viewed');
    f.protection.viewed = new Set(['viewed']);
    f.add('pinned', { pinnedAt: DAY });
    f.add('running');
    f.ports.busy.mockImplementation((id) => id === 'running');
    f.add('queue', { queued: 1 });
    f.add('question', { activeTurnStartedAt: 39 * DAY });
    f.ports.waiting.mockImplementation((id) => id === 'question');
    f.add('automation', { automation: 1 });
    f.add('goal', { goal: 1 });
    f.add('teammate', { source: 'bot' });
    f.add('collaboration', { orcaRole: 'worker' });
    f.add('shared', { shared: 1 });
    f.add('worktree', { worktreePath: '/worktree' });
    f.add('recent', { lastActivityAt: 39 * DAY });
    f.add('eligible');
    const preview = await f.engine.preview();
    expect(preview).toEqual({ candidateCount: 1, keptCount: 13, lastCheckAt: null });
    await f.engine.check();
    expect(f.ports.archive.mock.calls.map(([id]) => id)).toEqual(['eligible']);
  });

  it('does not archive until all viewing and draft states can be confirmed', async () => {
    const f = fixture();
    f.add('old');
    f.protection.ready = false;
    await f.engine.check();
    f.protection.ready = true;
    f.protection.remoteUnknown = true;
    await f.engine.check(true);
    expect(f.rows.get('old')?.status).toBe('active');
    f.protection.remoteUnknown = false;
    await f.engine.check(true);
    expect(f.rows.get('old')?.status).toBe('archived');
  });

  it('previews the selected rule in a passive host without allowing background writes', async () => {
    const f = fixture();
    f.add('old');
    f.ports.canRun = () => false;
    expect((await f.engine.preview()).candidateCount).toBe(1);
    await f.engine.check(true);
    expect(f.ports.archive).not.toHaveBeenCalled();
  });

  it('rechecks input, new activity and a newly opened draft after asynchronous preparation', async () => {
    const f = fixture();
    f.add('queued');
    f.add('message');
    f.add('draft');
    f.ports.pending.mockImplementation(async (id) => {
      if (id === 'message') f.rows.get(id)!.lastActivityAt = 40 * DAY;
      if (id === 'draft') f.protection.drafts = new Set([id]);
      return id === 'queued';
    });
    await f.engine.check(true);
    expect(f.ports.archive).not.toHaveBeenCalled();
  });

  it.each(['disable', 'owner', 'draft'] as const)(
    'rejects %s arriving at the final write boundary',
    async (change) => {
      const f = fixture();
      f.add('old');
      f.ports.archive.mockImplementation(async (_id, _cutoff, beforeWrite) => {
        if (change === 'disable') {
          f.settings.enabled = false;
          f.engine.invalidate();
        }
        if (change === 'owner') f.switchOwner();
        if (change === 'draft') f.protection.drafts = new Set(['old']);
        beforeWrite();
        throw new Error('should not reach mutation');
      });
      await f.engine.check(true);
      expect(f.rows.get('old')?.status).toBe('active');
      expect(f.ports.notice).not.toHaveBeenCalled();
    },
  );

  it('undoes only unchanged members of this batch and grants a full retention period', async () => {
    const f = fixture();
    f.add('a');
    f.add('b');
    f.add('c');
    await f.engine.check(true);
    const batch = f.ports.notice.mock.calls[0][0].batchId;
    f.rows.get('b')!.status = 'deleted';
    f.rows.get('c')!.updatedAt++;
    expect(await f.engine.undo(batch)).toEqual({ restored: 1 });
    expect(f.rows.get('a')!.status).toBe('active');
    expect(await f.engine.preview()).toEqual({
      candidateCount: 0,
      keptCount: 1,
      lastCheckAt: 40 * DAY,
    });
    f.advance(6);
    await f.engine.check(true);
    expect(f.rows.get('a')!.status).toBe('active');
    f.advance(1);
    await f.engine.check(true);
    expect(f.rows.get('a')!.status).toBe('archived');
    expect(await f.engine.undo(batch)).toEqual({ restored: 0 });
  });

  it('continues past a failed archive and reports only committed items', async () => {
    const f = fixture();
    f.add('a');
    f.add('b');
    f.ports.archive.mockRejectedValueOnce(new Error('storage unavailable'));
    await f.engine.check();
    expect(f.rows.get('a')!.status).toBe('active');
    expect(f.rows.get('b')!.status).toBe('archived');
    expect(f.ports.notice).toHaveBeenCalledWith(expect.objectContaining({ count: 1 }));
  });

  it('keeps the first undo available when a changed rule produces another batch', async () => {
    const f = fixture();
    f.add('a');
    await f.engine.check(true);
    const first = f.ports.notice.mock.calls[0][0].batchId;
    f.add('b');
    await f.engine.check(true);
    expect(await f.engine.undo(first)).toEqual({ restored: 1 });
    expect(f.rows.get('b')!.status).toBe('archived');
  });

  // Startup/performance follow-up to #10310: the old loop never yielded between
  // archive writes. Unit input: nine old tasks, with new work arriving at a pause.
  it('lets ordinary work run between archive chunks without holding a task lock', async () => {
    const f = fixture();
    for (let i = 0; i < 9; i++) f.add(String(i));
    f.ports.list.mockImplementation(async (after) =>
      [...f.rows.values()]
        .filter((row) => row.id > after && row.status === 'active')
        .map((row) => ({ ...row })),
    );
    let locked = false;
    f.ports.withLock = async (_id, run) => {
      locked = true;
      try {
        return await run();
      } finally {
        locked = false;
      }
    };
    f.ports.yieldToUser.mockImplementationOnce(async () => {
      expect(locked).toBe(false);
      expect(f.ports.archive).toHaveBeenCalledTimes(8);
      f.rows.get('8')!.lastActivityAt = 40 * DAY;
    });
    await f.engine.check();
    expect(f.rows.get('8')!.status).toBe('active');
    expect(f.ports.notice).toHaveBeenCalledWith(expect.objectContaining({ count: 8 }));
  });

  it('yields between read-only preview pages and rejects an owner change before reading again', async () => {
    const f = fixture();
    f.add('a');
    f.add('b');
    f.add('c');
    f.ports.yieldToUser.mockImplementationOnce(async () => f.switchOwner());
    await expect(f.engine.preview()).rejects.toThrow('TASK_ARCHIVE_SCOPE_CHANGED');
    expect(f.ports.list).toHaveBeenCalledTimes(1);
    expect(f.ports.archive).not.toHaveBeenCalled();
  });

  // Count-only preview follow-up, unit: concurrent windows used to perform
  // duplicate scans. Three rows force multiple pages; the result must contain
  // only totals, and a later request must observe changed draft protection.
  it('shares an in-flight count without retaining task lists or stale completed results', async () => {
    const f = fixture();
    f.add('a');
    f.add('b');
    f.add('c');
    const first = f.engine.preview();
    const second = f.engine.preview();
    expect(first).toBe(second);
    const expected = { candidateCount: 3, keptCount: 0, lastCheckAt: null };
    expect(await first).toEqual(expected);
    expect(await second).toEqual(expected);
    expect(f.ports.list).toHaveBeenCalledTimes(3);
    f.protection.drafts = new Set(['a']);
    expect(await f.engine.preview()).toEqual({
      candidateCount: 2,
      keptCount: 1,
      lastCheckAt: null,
    });
  });

  it('stops before the next scan page when disabled during a pause', async () => {
    const f = fixture();
    f.add('a');
    f.add('b');
    f.add('c');
    f.ports.yieldToUser.mockImplementationOnce(async () => {
      f.settings.enabled = false;
      f.engine.invalidate();
    });
    await f.engine.check();
    expect(f.rows.get('c')!.status).toBe('active');
    expect(f.ports.list).toHaveBeenCalledTimes(1);
    expect(f.ports.notice).toHaveBeenCalledWith(expect.objectContaining({ count: 2 }));
  });
});
