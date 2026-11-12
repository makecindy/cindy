import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorktreeRecycleRecord } from '../worktree/recycleJournal';

const state = vi.hoisted(() => ({ record: null as WorktreeRecycleRecord | null, registeredGeneration: 'g1' }));
const wake = vi.hoisted(() => vi.fn());
vi.mock('../worktree/recycleJournal', () => ({
  listRecycleRecords: async () => state.record ? [state.record] : [],
  readRecycleRecord: async () => state.record,
  writeRecycleRecord: async (record: WorktreeRecycleRecord) => { state.record = JSON.parse(JSON.stringify(record)); },
  worktreeGeneration: (meta: { generation: string }) => meta.generation,
}));
vi.mock('../worktree/worktreeStore', () => ({ get: () => ({ generation: state.registeredGeneration }) }));
vi.mock('../worktree/resourceLock', () => ({
  withWorktreeResourceLock: async (_path: string, run: () => Promise<void>) => run(),
  physicalWorktreeKey: async (path: string) => path,
}));
vi.mock('../worktree/recycleEvents', () => ({ notifyWorktreeRecycleOpportunity: wake }));
vi.mock('../worktree/recycleMaintenance', () => ({ isWorktreeRecycleRetrySuspended: () => false }));
import { controlWorktreeRecycle, listWorktreeRecycleStatus } from '../worktree/recycleControls';

const id = 'a'.repeat(64);
describe('local worktree recycle controls', () => {
  beforeEach(() => {
    wake.mockClear(); state.registeredGeneration = 'g1';
    state.record = { id, generation: 'g1', phase: 'snapshotted', attempts: 3, nextAttemptAt: 200,
      reason: 'archive-integrity', retryPolicy: { state: 'paused', failures: 3, failedWorkMs: 100 },
      meta: { sessionId: 'owner', generation: 'g1', path: '/fixture/worktree', name: 'fixture' },
      archive: { file: 'encrypted-evidence' }, snapshot: { commit: 'saved-commit' },
    } as WorktreeRecycleRecord;
  });
  it('shows a paused failure and restarts only its budget, preserving all recovery evidence', async () => {
    expect(await listWorktreeRecycleStatus()).toMatchObject([{ state: 'paused', reason: 'integrity' }]);
    await controlWorktreeRecycle({ id, generation: 'g1', action: 'retry' });
    expect(state.record).toMatchObject({ phase: 'snapshotted', attempts: 0, nextAttemptAt: 0,
      retryPolicy: { state: 'retrying', failures: 0, failedWorkMs: 0 },
      archive: { file: 'encrypted-evidence' }, snapshot: { commit: 'saved-commit' } });
    expect(wake).toHaveBeenCalledOnce();
  });
  it('keeps the directory without waking the recycler or dropping recovery evidence', async () => {
    await controlWorktreeRecycle({ id, generation: 'g1', action: 'keep' });
    expect(state.record!.retryPolicy!.state).toBe('kept');
    expect(state.record!.archive).toBeDefined();
    expect(wake).not.toHaveBeenCalled();
  });
  it.each([
    { id, generation: 'old', action: 'retry' },
    { id: '../path', generation: 'g1', action: 'retry' },
    { id, generation: 'g1', action: 'delete' },
  ])('rejects stale or malformed controls: %j', async (input) => {
    await expect(controlWorktreeRecycle(input)).rejects.toThrow();
    expect(state.record!.retryPolicy!.state).toBe('paused');
    expect(wake).not.toHaveBeenCalled();
  });
  it('does not modify a replacement generation or a completed recovery', async () => {
    state.registeredGeneration = 'g2';
    await expect(controlWorktreeRecycle({ id, generation: 'g1', action: 'retry' })).rejects.toThrow();
    state.registeredGeneration = 'g1'; state.record!.phase = 'removed';
    await expect(controlWorktreeRecycle({ id, generation: 'g1', action: 'retry' })).rejects.toThrow();
  });
});
