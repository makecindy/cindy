import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import type { WorktreeRecycleRecord } from '../worktree/recycleJournal';
import type { LocalWorktreeReference } from '../localDb/worker/worktreeReferences';

const state = vi.hoisted(() => ({
  rows: [] as Array<{ id: string; status: string; source: string; currentDatabase: boolean }>,
  records: [] as WorktreeRecycleRecord[],
  changed: () => {},
  watchError: vi.fn<(error: unknown) => void>(),
}));
const remove = vi.hoisted(() => vi.fn());
const list = vi.hoisted(() => vi.fn());
const read = vi.hoisted(() => vi.fn());
const watch = vi.hoisted(() => vi.fn());
const closeWatch = vi.hoisted(() => vi.fn());
const client = vi.hoisted(() => ({ readLocalWorktreeReferences: vi.fn() }));
const git = vi.hoisted(() => vi.fn());
vi.mock('../worktree/gitExec', () => ({ gitExec: git }));
vi.mock('../worktree/runtimeLeases', () => ({ retryPendingWorktreeRuntimeLeaseReleases: vi.fn(async () => 0) }));
vi.mock('../localDb/client/current', () => ({ getDbClient: () => client }));
vi.mock('../worktree/managedRecycle', () => ({ recycleManagedWorktree: remove }));
vi.mock('../worktree/worktreeStore', () => ({ get: () => null, getAll: () => [] }));
vi.mock('../worktree/liveSessionRefs', () => ({ loadLiveSessionPathKeys: async () => new Set(), hasLiveSessionReference: () => false, pathKey: (value: string) => value }));
const write = vi.hoisted(() => vi.fn());
vi.mock('../worktree/recycleJournal', () => ({
  listRecycleRecords: list,
  listRecycleRecordsWithHistory: vi.fn(async () => [...state.records]),
  readRecycleRecord: read,
  writeRecycleRecord: write,
  pruneUnreferencedRecoveryArchives: vi.fn(async () => 0),
  worktreeGeneration: () => 'one',
  watchRecycleJournal: watch,
}));
vi.mock('../worktree/resourceLock', async (original) => ({
  ...await original<typeof import('../worktree/resourceLock')>(),
  withWorktreeResourceLock: async <T>(_value: string, task: () => Promise<T>) => task(),
}));
import {
  releaseObsoleteRecoverySnapshots, startWorktreeRecycleMaintenance,
  stopWorktreeRecycleMaintenance, WorktreeRecycleMaintenance,
} from '../worktree/recycleMaintenance';
import { notifyWorktreeRecycleOpportunity, notifyWorktreeRecycleRecordChanged } from '../worktree/recycleEvents';
import { worktreeResourceId } from '../worktree/resourceLock';

function record(sessionId = 'owner', nextAttemptAt = 0): WorktreeRecycleRecord {
  const baseRepo = path.resolve('test-repo');
  const worktreePath = path.join(baseRepo, '.cindy-worktrees', sessionId);
  return {
    version: 1, id: worktreeResourceId(worktreePath), generation: 'one', phase: 'pending',
    meta: { sessionId, path: worktreePath, baseRepo, name: sessionId, branch: 'cindy/' + sessionId, sourceBranch: 'main', createdAt: '2026-09-08T00:00:00Z' },
    requestedAt: '2026-09-08T00:00:00Z', nextAttemptAt, attempts: 0,
  };
}

// PR #6898 startup responsiveness: existing real-Git tests cover which snapshots may be
// deleted, but not large metadata batches or a slow Git process. Exercise the production
// sweep and Git adapter with in-memory records/refs (unit tier), without timing thresholds.
describe('startup recovery snapshot cleanup', () => {
  let refs: Map<string, string>;
  const saved = (id: string, phase: WorktreeRecycleRecord['phase'] = 'removed'): WorktreeRecycleRecord => ({
    ...record(id), phase,
    snapshot: { head: 'head', tree: 'tree', indexTree: 'index', indexHash: 'hash', commit: `commit-${id}`, ref: `refs/cindy/worktree-recovery/${id}` },
  });
  const deleted = (id: string): LocalWorktreeReference => ({
    id, status: 'deleted', source: 'desktop', currentDatabase: true, workingDir: null, worktreePath: null,
  });
  beforeEach(() => {
    state.records = [];
    refs = new Map();
    git.mockReset().mockImplementation(async (args: string[]) => {
      if (args[0] === 'for-each-ref') return { stdout: [...refs].map(([ref, commit]) => `${ref}\0${commit}`).join('\n') };
      if (args[0] === 'update-ref' && refs.get(args[2]) === args[3]) refs.delete(args[2]);
      return { stdout: '' };
    });
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('yields to other callbacks while indexing thousands of owners and releases their refs', async () => {
    const count = 4_096;
    let idReads = 0;
    let readsAtYield = -1;
    const rows = Array.from({ length: count }, (_, i) => {
      const id = `owner-${i}`;
      const item = saved(id);
      state.records.push(item, { ...item }); // Current and historical copies of the same ref.
      refs.set(item.snapshot!.ref, item.snapshot!.commit);
      return { ...deleted(id), get id() { idReads++; return id; } };
    });
    let callback: Promise<void> | undefined;
    const released = await releaseObsoleteRecoverySnapshots(async () => {
      callback = setImmediate().then(() => { readsAtYield = idReads; });
      return rows;
    });
    await callback;
    expect(readsAtYield).toBeGreaterThan(0);
    expect(readsAtYield).toBeLessThan(count);
    expect(idReads).toBeLessThanOrEqual(count * 3);
    expect(released).toBe(count);
    expect(refs.size).toBe(0);
  });

  it('keeps protected, unknown and concurrently changed refs when indexing duplicate owners', async () => {
    state.records = ['deleted', 'archived', 'bot', 'unknown', 'changed', 'pending', 'restored'].map((id) => saved(id));
    state.records.push({ ...state.records[5], phase: 'pending' });
    state.records.push({ ...state.records[6], phase: 'restored' });
    for (const item of state.records) refs.set(item.snapshot!.ref, item.snapshot!.commit);
    refs.set(state.records[4].snapshot!.ref, 'newer-commit');
    const rows = ['deleted', 'archived', 'bot', 'changed', 'pending'].map(deleted);
    rows.push({ ...deleted('archived'), status: 'archived' }, { ...deleted('bot'), source: 'bot' });
    expect(await releaseObsoleteRecoverySnapshots(async () => rows)).toBe(2);
    expect([...refs.keys()]).toEqual(['archived', 'bot', 'unknown', 'changed', 'pending'].map((id) => `refs/cindy/worktree-recovery/${id}`));
  });

  it('stops launching Git work after the cleanup budget and leaves the remainder for the next start', async () => {
    state.records = [saved('first', 'restored'), saved('second', 'restored')];
    for (const item of state.records) refs.set(item.snapshot!.ref, item.snapshot!.commit);
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const simulateGit = git.getMockImplementation()!;
    git.mockImplementation(async (...args) => {
      const result = await simulateGit(...args);
      if (args[0][0] === 'update-ref') now += 60_000;
      return result;
    });
    const readRows = vi.fn(async () => []);
    expect(await releaseObsoleteRecoverySnapshots(readRows)).toBe(1);
    expect(refs.has(state.records[1].snapshot!.ref)).toBe(true);
    expect(readRows).not.toHaveBeenCalled();
    expect(await releaseObsoleteRecoverySnapshots(readRows)).toBe(1);
    expect(refs.size).toBe(0);
  });

  it('bounds a stalled Git call and continues with another repository without dropping the failed ref', async () => {
    state.records = [saved('slow', 'restored'), saved('fast', 'restored')];
    state.records[1].meta.baseRepo = path.resolve('other-repo');
    for (const item of state.records) refs.set(item.snapshot!.ref, item.snapshot!.commit);
    const simulateGit = git.getMockImplementation()!;
    git.mockImplementation(async (...args) => {
      if (args[0][0] === 'update-ref' && args[0][2] === state.records[0].snapshot!.ref) {
        throw new Error('Git operation deadline exceeded');
      }
      return simulateGit(...args);
    });
    expect(await releaseObsoleteRecoverySnapshots(async () => [])).toBe(1);
    expect([...refs.keys()]).toEqual([state.records[0].snapshot!.ref]);
    // Assert outside the adapter's catch: a missing timeout must not masquerade as a Git error.
    for (const [, , options] of git.mock.calls) {
      expect(options?.timeoutMs).toBeGreaterThan(0);
      expect(options?.timeoutMs).toBeLessThanOrEqual(1_000);
      expect(options?.deadlineAtMs).toBeGreaterThan(0);
    }
  });

  it('stops the sweep if readiness is lost during the reference query', async () => {
    state.records = [saved('owner', 'restored')];
    refs.set(state.records[0].snapshot!.ref, state.records[0].snapshot!.commit);
    let ready = true;
    const simulateGit = git.getMockImplementation()!;
    git.mockImplementation(async (...args) => { ready = false; return simulateGit(...args); });
    expect(await releaseObsoleteRecoverySnapshots(async () => [], () => ready)).toBe(0);
    expect(refs.size).toBe(1);
  });
});

describe('durable worktree maintenance', () => {
  let ready: boolean;
  let maintenance: WorktreeRecycleMaintenance;
  const closeAndRecycle = vi.fn();
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-08T00:00:00Z'));
    ready = true;
    state.records = [record()];
    state.rows = [{ id: 'owner', status: 'archived', source: 'desktop', currentDatabase: true }];
    closeAndRecycle.mockReset().mockResolvedValue(undefined);
    remove.mockReset().mockResolvedValue(true);
    list.mockReset().mockImplementation(async () => [...state.records]);
    read.mockReset().mockImplementation(async (value: string) => state.records.find((item) => item.meta.path === value) ?? null);
    write.mockReset().mockImplementation(async (next: WorktreeRecycleRecord) => {
      state.records = state.records.map((item) => item.id === next.id ? next : item);
    });
    closeWatch.mockReset();
    watch.mockReset().mockImplementation(async (changed, error) => {
      state.changed = changed; state.watchError = error; return closeWatch;
    });
    client.readLocalWorktreeReferences.mockReset().mockImplementation(async () => state.rows);
    maintenance = new WorktreeRecycleMaintenance({ isReady: () => ready, recycleCurrentSession: closeAndRecycle });
  });
  afterEach(() => { maintenance.stop(); stopWorktreeRecycleMaintenance(); vi.useRealTimers(); });

  // Startup must settle before optional audit/cleanup even begins; events cannot shorten
  // the grace. Fake time makes a slow/failing maintenance job deterministic in the unit tier.
  it('returns during the startup grace without scanning and coalesces repeated starts and events', async () => {
    const onReady = vi.fn(async () => {});
    maintenance.options.onReady = onReady;
    expect(startWorktreeRecycleMaintenance(maintenance.options)).toBeUndefined();
    notifyWorktreeRecycleOpportunity(state.records[0].meta.path);
    startWorktreeRecycleMaintenance(maintenance.options);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(onReady).not.toHaveBeenCalled();
    expect(watch).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
    expect(client.readLocalWorktreeReferences).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(onReady).toHaveBeenCalledOnce();
    expect(closeAndRecycle).toHaveBeenCalledExactlyOnceWith('owner', 'archived');
  });

  it('contains deferred startup failures and cancels remaining work on shutdown', async () => {
    const onReady = vi.fn(async () => { throw new Error('disk unavailable'); });
    maintenance.options.onReady = onReady;
    await expect(maintenance.start(30_000)).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(onReady).toHaveBeenCalledOnce();
    expect(list).not.toHaveBeenCalled();
    maintenance.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onReady).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not start delayed cleanup if the main window or database is no longer ready', async () => {
    await maintenance.start(30_000);
    ready = false;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(list).not.toHaveBeenCalled();
    expect(watch).not.toHaveBeenCalled();
    ready = true;
    await maintenance.start(30_000);
    expect(closeAndRecycle).toHaveBeenCalledOnce();
  });

  it('waits for both database and runtime services without polling readiness', async () => {
    ready = false; await maintenance.start();
    expect(vi.getTimerCount()).toBe(0); expect(watch).not.toHaveBeenCalled();
    expect(closeAndRecycle).not.toHaveBeenCalled();
    ready = true; await maintenance.start();
    expect(closeAndRecycle).toHaveBeenCalledWith('owner', 'archived'); expect(watch).toHaveBeenCalledOnce();
  });
  it.each(['recycle-failed', 'EPERM'])('retries a request an older client paused over its archive (%s) exactly once', async (reason) => {
    state.records = [{ ...record(), reason, attempts: 3, retryPolicy: { state: 'paused', failures: 3, failedWorkMs: 1_800_000 } }];
    closeAndRecycle.mockImplementation(async () => {
      const [current] = state.records;
      state.records = [{ ...current, reason, retryPolicy: { state: 'paused', failures: 3, failedWorkMs: 0 } }];
    });
    await maintenance.start();
    expect(closeAndRecycle).toHaveBeenCalledExactlyOnceWith('owner', 'archived');
    expect(state.records[0].legacyArchiveRetry).toBe(true);

    maintenance.stop();
    maintenance = new WorktreeRecycleMaintenance({ isReady: () => ready, recycleCurrentSession: closeAndRecycle });
    await maintenance.start();
    expect(closeAndRecycle).toHaveBeenCalledOnce();
  });
  it('keeps a pause the user chose or a newer client recorded', async () => {
    state.records = [
      { ...record('kept'), reason: 'user-kept', retryPolicy: { state: 'kept', failures: 0, failedWorkMs: 0 } },
      { ...record('identity'), reason: 'directory-replaced', retryPolicy: { state: 'paused', failures: 1, failedWorkMs: 0 } },
    ];
    state.rows = ['kept', 'identity'].map((id) => ({ id, status: 'archived', source: 'desktop', currentDatabase: true }));
    await maintenance.start();
    expect(write).not.toHaveBeenCalled();
    expect(closeAndRecycle).not.toHaveBeenCalled();
  });
  it('does not infer deletion from a row missing in the local view', async () => {
    state.rows = []; await maintenance.start();
    expect(remove).not.toHaveBeenCalled(); expect(closeAndRecycle).not.toHaveBeenCalled();
  });
  it('keeps missing owners recoverable beyond three checks without charging failures', async () => {
    state.rows = [];
    await maintenance.start();
    await vi.advanceTimersByTimeAsync(70_000);
    expect(client.readLocalWorktreeReferences).toHaveBeenCalledTimes(4);
    expect(maintenance.isRetrySuspended(state.records[0])).toBe(false);
    expect(closeAndRecycle).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
    state.rows = [{ id: 'owner', status: 'archived', source: 'desktop', currentDatabase: true }];
    closeAndRecycle.mockImplementationOnce(async () => { state.records[0].phase = 'removed'; });
    await vi.advanceTimersByTimeAsync(80_000);
    expect(closeAndRecycle).toHaveBeenCalledExactlyOnceWith('owner', 'archived');
    expect(vi.getTimerCount()).toBe(0);
  });
  it('bounds genuine prerequisite failures without executing the removal core', async () => {
    read.mockRejectedValue(new Error('journal unavailable'));
    await maintenance.start();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(read).toHaveBeenCalledTimes(3);
    expect(maintenance.isRetrySuspended(state.records[0])).toBe(true);
    expect(closeAndRecycle).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('charges a rejected core attempt once rather than again in its catch', async () => {
    closeAndRecycle.mockRejectedValue(new Error('lock unavailable'));
    await maintenance.start();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(closeAndRecycle).toHaveBeenCalledTimes(3);
    expect(maintenance.isRetrySuspended(state.records[0])).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('leaves an empty queue idle without reading databases or scanning historical registrations', async () => {
    state.records = []; await maintenance.start();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(list).toHaveBeenCalledOnce(); expect(client.readLocalWorktreeReferences).not.toHaveBeenCalled();
    expect(closeAndRecycle).not.toHaveBeenCalled();
  });
  it('does not schedule completed recovery records', async () => {
    state.records[0].phase = 'removed';
    state.records.push({ ...record('restored'), phase: 'restored' });
    await maintenance.start();
    expect(vi.getTimerCount()).toBe(0); expect(client.readLocalWorktreeReferences).not.toHaveBeenCalled();
  });
  it('does not close a task through another selected database', async () => {
    state.rows[0].currentDatabase = false;
    await maintenance.start(); expect(closeAndRecycle).not.toHaveBeenCalled(); expect(remove).toHaveBeenCalledOnce();
    const guard = remove.mock.calls[0][1].canRemove;
    expect(await guard()).toBe(true);
    state.rows[0].status = 'active'; expect(await guard()).toBe(false);
  });
  it('uses one timer for the earliest request with no intermediate 30-second scans', async () => {
    state.records[0].nextAttemptAt = Date.now() + 90_000;
    state.records.push(record('second', Date.now() + 120_000)); state.rows.push({ ...state.rows[0], id: 'second' });
    closeAndRecycle.mockImplementation(async (id) => { state.records.find((r) => r.meta.sessionId === id)!.phase = 'removed'; });
    await maintenance.start(); expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(89_999);
    expect(list).toHaveBeenCalledOnce(); expect(client.readLocalWorktreeReferences).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(closeAndRecycle).toHaveBeenCalledExactlyOnceWith('owner', 'archived'); expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(closeAndRecycle).toHaveBeenLastCalledWith('second', 'archived'); expect(vi.getTimerCount()).toBe(0);
  });
  it('coalesces overlapping ready events without concurrent cleanup', async () => {
    let finish!: () => void;
    closeAndRecycle.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const first = maintenance.start(); await vi.advanceTimersByTimeAsync(0);
    const second = maintenance.run(); expect(second).toBe(first);
    expect(closeAndRecycle).toHaveBeenCalledOnce(); finish(); await first;
    await vi.advanceTimersByTimeAsync(100); expect(closeAndRecycle).toHaveBeenCalledOnce();
  });
  it('wakes only the released resource instead of bypassing every request backoff', async () => {
    state.records[0].nextAttemptAt = Date.now() + 60_000;
    state.records.push(record('second', Date.now() + 60_000)); state.rows.push({ ...state.rows[0], id: 'second' });
    await maintenance.start(); notifyWorktreeRecycleOpportunity(state.records[0].meta.path);
    await vi.advanceTimersByTimeAsync(100);
    expect(closeAndRecycle).toHaveBeenCalledExactlyOnceWith('owner', 'archived');
  });
  it('stops automatic retries after the budget and permits an explicit resource wake', async () => {
    await maintenance.start();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(closeAndRecycle).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
    notifyWorktreeRecycleOpportunity(state.records[0].meta.path);
    await vi.advanceTimersByTimeAsync(100);
    expect(closeAndRecycle).toHaveBeenCalledTimes(4);
  });
  it('never wakes durable pauses on incidental resource events', async () => {
    state.records[0].retryPolicy = { state: 'paused', failures: 3, failedWorkMs: 100 };
    await maintenance.start();
    notifyWorktreeRecycleOpportunity(state.records[0].meta.path);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(closeAndRecycle).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('rechecks waiting references once at startup, then waits for a release event', async () => {
    state.records[0].retryPolicy = { state: 'waiting', failures: 0, failedWorkMs: 0 };
    await maintenance.start();
    expect(closeAndRecycle).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    notifyWorktreeRecycleOpportunity(state.records[0].meta.path);
    await vi.advanceTimersByTimeAsync(100);
    expect(closeAndRecycle).toHaveBeenCalledTimes(2);
  });
  it('continues with other resources after one request fails', async () => {
    state.records.push(record('second')); state.rows.push({ ...state.rows[0], id: 'second' });
    closeAndRecycle.mockRejectedValueOnce(new Error('lock busy'));
    await maintenance.start(); expect(closeAndRecycle).toHaveBeenLastCalledWith('second', 'archived');
  });
  it('isolates a journal read failure to its own resource', async () => {
    state.records.push(record('second')); state.rows.push({ ...state.rows[0], id: 'second' });
    read.mockRejectedValueOnce(new Error('journal unavailable'));
    await maintenance.start(); expect(closeAndRecycle).toHaveBeenCalledExactlyOnceWith('second', 'archived');
  });
  it('rechecks readiness after asynchronously reading a request', async () => {
    read.mockImplementationOnce(async () => { ready = false; return state.records[0]; });
    await maintenance.start(); expect(closeAndRecycle).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('does not fan out a startup batch while the first cleanup is still running', async () => {
    state.records.push(record('second')); state.rows.push({ ...state.rows[0], id: 'second' });
    let finish!: () => void;
    closeAndRecycle.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const running = maintenance.start();
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(closeAndRecycle).toHaveBeenCalledExactlyOnceWith('owner', 'archived');
    } finally { finish?.(); }
    await running; expect(closeAndRecycle).toHaveBeenLastCalledWith('second', 'archived');
  });
  it('coalesces cross-instance journal notifications and local writes without idle database reads', async () => {
    state.records = []; await maintenance.start();
    state.records.push(record('owner', Date.now() + 60_000));
    for (let i = 0; i < 20; i++) { state.changed(); notifyWorktreeRecycleRecordChanged(state.records[0].id); }
    await vi.advanceTimersByTimeAsync(100);
    expect(list).toHaveBeenCalledTimes(2); expect(client.readLocalWorktreeReferences).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
    state.records[0].phase = 'removed'; state.changed();
    await vi.advanceTimersByTimeAsync(100); expect(vi.getTimerCount()).toBe(0);
  });
  it('resumes durable deadlines after a restart', async () => {
    state.records[0].nextAttemptAt = Date.now() + 60_000;
    await maintenance.start(); maintenance.stop();
    maintenance = new WorktreeRecycleMaintenance({ isReady: () => true, recycleCurrentSession: closeAndRecycle });
    await maintenance.start(); await vi.advanceTimersByTimeAsync(59_999); expect(closeAndRecycle).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(closeAndRecycle).toHaveBeenCalledOnce();
  });
  it('backs off unavailable reference reads without a hot loop', async () => {
    client.readLocalWorktreeReferences.mockRejectedValue(new Error('database unavailable'));
    await maintenance.start(); await vi.advanceTimersByTimeAsync(9_999);
    expect(client.readLocalWorktreeReferences).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1); expect(client.readLocalWorktreeReferences).toHaveBeenCalledTimes(2);
    expect(closeAndRecycle).not.toHaveBeenCalled();
  });
  it('reconnects a failed watcher with backoff without querying an empty task queue', async () => {
    state.records = []; watch.mockRejectedValueOnce(new Error('watch unavailable'));
    await maintenance.start();
    await vi.advanceTimersByTimeAsync(9_999); expect(watch).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1); expect(watch).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0); expect(client.readLocalWorktreeReferences).not.toHaveBeenCalled();
    state.watchError(new Error('watch lost')); expect(closeWatch).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(10_000); expect(watch).toHaveBeenCalledTimes(3);
  });
  it('stops pending timers and ignores events after disposal', async () => {
    await maintenance.start(); maintenance.stop();
    state.changed(); notifyWorktreeRecycleOpportunity(state.records[0].meta.path);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(closeWatch).toHaveBeenCalledOnce(); expect(closeAndRecycle).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('stops a startup batch before the next resource when readiness is lost', async () => {
    state.records.push(record('second')); state.rows.push({ ...state.rows[0], id: 'second' });
    closeAndRecycle.mockImplementationOnce(async () => { ready = false; });
    await maintenance.start(); expect(closeAndRecycle).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
});
