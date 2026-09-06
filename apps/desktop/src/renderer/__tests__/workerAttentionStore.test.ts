import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  __getWorkerAttentionSnapshotForTest,
  __resetWorkerAttentionStoreForTest,
  clearWorkerAttention,
  clearWorkerAttentionMany,
  hasWorkerAttention,
  markWorkerAttention,
  subscribe,
} from '@/features/cc-agent/lib/workerAttentionStore';

const WORKER_ID = 'worker-1';
const OTHER_WORKER_ID = 'worker-2';

afterEach(() => {
  __resetWorkerAttentionStoreForTest();
});

describe('workerAttentionStore', () => {
  it('marks and clears worker attention', () => {
    markWorkerAttention(WORKER_ID);

    expect(hasWorkerAttention(WORKER_ID)).toBe(true);
    expect(__getWorkerAttentionSnapshotForTest().has(WORKER_ID)).toBe(true);

    expect(clearWorkerAttention(WORKER_ID)).toBe(true);
    expect(hasWorkerAttention(WORKER_ID)).toBe(false);
  });

  it('clears many worker attention ids', () => {
    markWorkerAttention(WORKER_ID);
    markWorkerAttention(OTHER_WORKER_ID);

    expect(clearWorkerAttentionMany([WORKER_ID, 'missing'])).toBe(1);

    const snapshot = __getWorkerAttentionSnapshotForTest();
    expect(snapshot.has(WORKER_ID)).toBe(false);
    expect(snapshot.has(OTHER_WORKER_ID)).toBe(true);
  });

  it('notifies subscribers when the snapshot changes', () => {
    const listener = vi.fn();
    const unsubscribe = subscribe(listener);

    markWorkerAttention(WORKER_ID);
    clearWorkerAttention(WORKER_ID);
    unsubscribe();
    markWorkerAttention(WORKER_ID);

    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('keeps done and permission attention as independent reasons', () => {
    markWorkerAttention(WORKER_ID, { kind: 'done' });
    markWorkerAttention(WORKER_ID, { kind: 'permission', requestId: 'permission-1' });
    markWorkerAttention(WORKER_ID, { kind: 'permission', requestId: 'permission-2' });

    expect(__getWorkerAttentionSnapshotForTest().get(WORKER_ID)).toEqual([
      { kind: 'done' },
      { kind: 'permission', requestId: 'permission-1' },
      { kind: 'permission', requestId: 'permission-2' },
    ]);

    // Viewing a Worker acknowledges only its unread completion. A live
    // permission remains actionable until that exact request is dismissed.
    expect(clearWorkerAttention(WORKER_ID)).toBe(true);
    expect(__getWorkerAttentionSnapshotForTest().get(WORKER_ID)).toEqual([
      { kind: 'permission', requestId: 'permission-1' },
      { kind: 'permission', requestId: 'permission-2' },
    ]);

    expect(
      clearWorkerAttention(WORKER_ID, {
        kind: 'permission',
        requestId: 'permission-1',
      }),
    ).toBe(true);
    expect(__getWorkerAttentionSnapshotForTest().get(WORKER_ID)).toEqual([
      { kind: 'permission', requestId: 'permission-2' },
    ]);
  });

  it('clears all reasons only when the Worker leaves the team', () => {
    markWorkerAttention(WORKER_ID, { kind: 'done' });
    markWorkerAttention(WORKER_ID, { kind: 'permission', requestId: 'permission-1' });

    expect(clearWorkerAttentionMany([WORKER_ID])).toBe(1);
    expect(hasWorkerAttention(WORKER_ID)).toBe(false);
    expect(__getWorkerAttentionSnapshotForTest().has(WORKER_ID)).toBe(false);
  });
});
