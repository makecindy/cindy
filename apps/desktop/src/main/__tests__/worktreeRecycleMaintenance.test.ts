import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import type { WorktreeRecycleRecord } from '../worktree/recycleJournal';

const state = vi.hoisted(() => ({
  rows: [] as Array<{ id: string; status: string; source: string; currentDatabase: boolean }>,
  records: [] as WorktreeRecycleRecord[],
  changed: () => {},
  watchError: (_error: unknown) => {},
}));
const remove = vi.hoisted(() => vi.fn());
const list = vi.hoisted(() => vi.fn());
const read = vi.hoisted(() => vi.fn());
const watch = vi.hoisted(() => vi.fn());
const closeWatch = vi.hoisted(() => vi.fn());
const client = vi.hoisted(() => ({ readLocalWorktreeReferences: vi.fn() }));
vi.mock('../worktree/runtimeLeases', () => ({ retryPendingWorktreeRuntimeLeaseReleases: vi.fn(async () => 0) }));
vi.mock('../localDb/client/current', () => ({ getDbClient: () => client }));
vi.mock('../worktree/managedRecycle', () => ({ recycleManagedWorktree: remove }));
vi.mock('../worktree/worktreeStore', () => ({ get: () => null, getAll: () => [] }));
vi.mock('../worktree/liveSessionRefs', () => ({ loadLiveSessionPathKeys: async () => new Set(), hasLiveSessionReference: () => false, pathKey: (value: string) => value }));
vi.mock('../worktree/recycleJournal', () => ({
  listRecycleRecords: list,
  readRecycleRecord: read,
  worktreeGeneration: () => 'one',
  watchRecycleJournal: watch,
}));
import { WorktreeRecycleMaintenance } from '../worktree/recycleMaintenance';
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
    closeWatch.mockReset();
    watch.mockReset().mockImplementation(async (changed, error) => {
      state.changed = changed; state.watchError = error; return closeWatch;
    });
    client.readLocalWorktreeReferences.mockReset().mockImplementation(async () => state.rows);
    maintenance = new WorktreeRecycleMaintenance({ isReady: () => ready, recycleCurrentSession: closeAndRecycle });
  });
  afterEach(() => { maintenance.stop(); vi.useRealTimers(); });

  it('waits for both database and runtime services without polling readiness', async () => {
    ready = false; await maintenance.start();
    expect(vi.getTimerCount()).toBe(0); expect(watch).not.toHaveBeenCalled();
    expect(closeAndRecycle).not.toHaveBeenCalled();
    ready = true; await maintenance.start();
    expect(closeAndRecycle).toHaveBeenCalledWith('owner', 'archived'); expect(watch).toHaveBeenCalledOnce();
  });
  it('does not infer deletion from a row missing in the local view', async () => {
    state.rows = []; await maintenance.start();
    expect(remove).not.toHaveBeenCalled(); expect(closeAndRecycle).not.toHaveBeenCalled();
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
  it('keeps retrying after the backoff cap and lets a resource event wake it early', async () => {
    await maintenance.start();
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(closeAndRecycle).toHaveBeenCalledTimes(8);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(closeAndRecycle).toHaveBeenCalledTimes(9);
    notifyWorktreeRecycleOpportunity(state.records[0].meta.path);
    await vi.advanceTimersByTimeAsync(100);
    expect(closeAndRecycle.mock.calls.length).toBeGreaterThan(9);
    expect(vi.getTimerCount()).toBe(1);
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
