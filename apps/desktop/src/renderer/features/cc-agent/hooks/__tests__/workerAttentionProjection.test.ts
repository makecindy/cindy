import { describe, expect, it } from 'vitest';

import {
  computeWorkerAttentionUpdates,
  type WorkerAttentionObservedState,
  type WorkerAttentionRecord,
} from '../useOrcaWorkerAttentionWatcher';

function worker(overrides: Partial<WorkerAttentionRecord> = {}): WorkerAttentionRecord {
  return {
    workerId: 'worker-1',
    leadSessionId: 'lead-1',
    status: 'idle',
    focused: false,
    pendingPermissionRequestIds: [],
    ...overrides,
  };
}

function observed(
  status: WorkerAttentionObservedState['status'],
  pendingPermissionRequestIds: readonly string[],
): WorkerAttentionObservedState {
  return { status, pendingPermissionRequestIds };
}

describe('Worker attention projection', () => {
  it('projects permission and done as two simultaneous reasons', () => {
    const updates = computeWorkerAttentionUpdates(
      new Map(),
      [worker({ status: 'done', pendingPermissionRequestIds: ['permission-1'] })],
      undefined,
    );

    expect(updates.toMark).toEqual([
      { workerId: 'worker-1', reason: { kind: 'done' } },
      {
        workerId: 'worker-1',
        reason: { kind: 'permission', requestId: 'permission-1' },
      },
    ]);
    expect(updates.toClear).toEqual([]);
  });

  it('keeps the earlier permission when a concurrent request arrives', () => {
    const updates = computeWorkerAttentionUpdates(
      new Map([['worker-1', observed('done', ['permission-1'])]]),
      [
        worker({
          status: 'done',
          pendingPermissionRequestIds: ['permission-1', 'permission-2'],
        }),
      ],
      undefined,
    );

    expect(updates.toClear).toEqual([]);
    expect(updates.toMark).toEqual([
      {
        workerId: 'worker-1',
        reason: { kind: 'permission', requestId: 'permission-2' },
      },
    ]);
  });

  it('keeps other Workers and other reasons intact during resolution', () => {
    const updates = computeWorkerAttentionUpdates(
      new Map([
        ['worker-1', observed('running', ['permission-1'])],
        ['worker-2', observed('idle', ['permission-2'])],
      ]),
      [
        worker({ status: 'done', pendingPermissionRequestIds: [] }),
        worker({
          workerId: 'worker-2',
          leadSessionId: 'lead-2',
          pendingPermissionRequestIds: ['permission-2'],
        }),
      ],
      undefined,
    );

    expect(updates.toClear).toEqual([
      {
        workerId: 'worker-1',
        reason: { kind: 'permission', requestId: 'permission-1' },
      },
    ]);
    expect(updates.toMark).toEqual([{ workerId: 'worker-1', reason: { kind: 'done' } }]);
    expect(updates.toPrune).toEqual([]);
  });

  it('retains live permission state for a focused Worker while suppressing done unread', () => {
    const updates = computeWorkerAttentionUpdates(
      new Map(),
      [
        worker({
          status: 'done',
          focused: true,
          pendingPermissionRequestIds: ['permission-focused'],
        }),
      ],
      'lead-1',
    );

    expect(updates.toMark).toEqual([
      {
        workerId: 'worker-1',
        reason: { kind: 'permission', requestId: 'permission-focused' },
      },
    ]);
  });

  it('prunes every reason when a Worker session leaves the team', () => {
    const updates = computeWorkerAttentionUpdates(
      new Map([['worker-1', observed('done', ['permission-1'])]]),
      [],
      undefined,
    );

    expect(updates.toPrune).toEqual(['worker-1']);
  });
});
