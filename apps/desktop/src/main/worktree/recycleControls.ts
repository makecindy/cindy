import { isIpcError } from '../../shared/ipc-errors';
import { createLogger } from '../logger';
import type { WorktreeRecycleAction, WorktreeRecycleStatus } from '../../shared/worktreeRecycle';
import { listRecycleRecords, readRecycleRecord, writeRecycleRecord, worktreeGeneration } from './recycleJournal';
import { isWorktreeRecycleRetrySuspended } from './recycleMaintenance';
import { recyclePolicy } from './recyclePolicy';
import { withWorktreeResourceLock, physicalWorktreeKey } from './resourceLock';
import { notifyWorktreeRecycleOpportunity } from './recycleEvents';
import * as store from './worktreeStore';
import { throwIpcError } from '../utils/ipcValidate';

function visibleReason(reason?: string): WorktreeRecycleStatus['reason'] {
  if (!reason) return 'pending';
  if (reason.startsWith('referenced')) return 'in-use';
  if (reason.includes('changed')) return 'changed';
  if (reason === 'keep-sentinel' || reason === 'user-kept') return 'kept';
  if (reason === 'archive-integrity') return 'integrity';
  if (['ENOSPC', 'EACCES', 'EPERM'].includes(reason)) return 'storage';
  if (['directory-replaced', 'unmanaged-path', 'redirected-worktree-parent', 'legacy-quarantine-needs-review'].includes(reason)) return 'identity';
  return 'failed';
}

async function listWorktreeRecycleStatusInner(): Promise<WorktreeRecycleStatus[]> {
  return (await listRecycleRecords()).filter((record) => {
    if (['removed', 'restoring', 'restored'].includes(record.phase) || record.meta.ephemeral) return false;
    const current = store.get(record.meta.sessionId);
    return !current || worktreeGeneration(current) === record.generation;
  }).map((record) => ({
    id: record.id, generation: record.generation, name: record.meta.name, path: record.meta.path,
    state: recyclePolicy(record).state === 'retrying' && isWorktreeRecycleRetrySuspended(record) ? 'paused' : recyclePolicy(record).state, failures: recyclePolicy(record).failures,
    reason: isWorktreeRecycleRetrySuspended(record) && !record.reason ? 'failed' : visibleReason(record.reason),
  }));
}

/** Changes scheduling only. Actual recycling still revalidates live references and recovery evidence. */
async function controlWorktreeRecycleInner(value: unknown): Promise<void> {
  const input = value as Partial<WorktreeRecycleAction> | null;
  if (!input || typeof input.id !== 'string' || !/^[a-f0-9]{64}$/.test(input.id)
    || typeof input.generation !== 'string' || !input.generation
    || !['retry', 'keep'].includes(input.action ?? '')) throwIpcError('INVALID_PARAMS', 'Invalid or stale worktree recycle request');
  const candidate = (await listRecycleRecords()).find((record) => record.id === input!.id);
  if (!candidate) throwIpcError('NOT_FOUND', 'Worktree recycle request not found');
  await withWorktreeResourceLock(candidate.meta.path, async () => {
    const record = await readRecycleRecord(candidate.meta.path);
    const current = record && store.get(record.meta.sessionId);
    if (!record || record.id !== input!.id || record.generation !== input!.generation
      || (current && worktreeGeneration(current) !== record.generation)
      || ['removed', 'restoring', 'restored'].includes(record.phase)) throwIpcError('INVALID_PARAMS', 'Invalid or stale worktree recycle request');
    record.retryPolicy = { state: input!.action === 'keep' ? 'kept' : 'retrying', failures: 0, failedWorkMs: 0 };
    record.reason = input!.action === 'keep' ? 'user-kept' : undefined;
    record.attempts = 0;
    record.nextAttemptAt = 0;
    await writeRecycleRecord(record);
  });
  if (input!.action === 'retry') notifyWorktreeRecycleOpportunity(await physicalWorktreeKey(candidate.meta.path));
}

const log = createLogger('worktree-recycle-controls');
async function ipcAction<T>(action: () => Promise<T>): Promise<T> {
  try { return await action(); }
  catch (error) {
    if (isIpcError(error)) throw error;
    log.warn('worktree recycle control failed', { code: (error as NodeJS.ErrnoException)?.code ?? 'unavailable' });
    throwIpcError('INTERNAL', 'Worktree recycle control is unavailable');
  }
}
export function listWorktreeRecycleStatus(): Promise<WorktreeRecycleStatus[]> {
  return ipcAction(listWorktreeRecycleStatusInner);
}
export function controlWorktreeRecycle(value: unknown): Promise<void> {
  return ipcAction(() => controlWorktreeRecycleInner(value));
}
