import { describe, expect, it } from 'vitest';

import {
  computeWorkerAttentionUpdates,
  type WorkerAttentionRecord,
  type WorkerAttentionObservedState,
} from '@/features/cc-agent/hooks/useOrcaWorkerAttentionWatcher';
import type { OrcaWorkerStatus } from '../../shared/orca-worker-status';

const LEAD_ID = 'lead-1';
const WORKER_ID = 'worker-1';
const OTHER_WORKER_ID = 'worker-2';

function worker(
  workerId: string,
  status: OrcaWorkerStatus,
  focused = false,
): WorkerAttentionRecord {
  return {
    workerId,
    leadSessionId: LEAD_ID,
    status,
    focused,
    pendingPermissionRequestIds: [],
  };
}

function observed(status: OrcaWorkerStatus): WorkerAttentionObservedState {
  return { status, pendingPermissionRequestIds: [] };
}

const doneMutation = (workerId: string) => ({ workerId, reason: { kind: 'done' as const } });

describe('computeWorkerAttentionUpdates', () => {
  it('marks attention on running to done transition', () => {
    const result = computeWorkerAttentionUpdates(
      new Map([[WORKER_ID, observed('running')]]),
      [worker(WORKER_ID, 'done')],
      LEAD_ID,
    );

    expect(result.toMark).toEqual([doneMutation(WORKER_ID)]);
  });

  it('marks attention for first observed done status so remount can restore unread state', () => {
    const result = computeWorkerAttentionUpdates(
      new Map(),
      [worker(WORKER_ID, 'done')],
      LEAD_ID,
    );

    expect(result.toMark).toEqual([doneMutation(WORKER_ID)]);
  });

  it('marks multiple first-observed done workers independently', () => {
    const result = computeWorkerAttentionUpdates(
      new Map(),
      [
        worker(WORKER_ID, 'done'),
        worker(OTHER_WORKER_ID, 'done'),
        worker('worker-3', 'idle'),
      ],
      LEAD_ID,
    );

    expect(result.toMark).toEqual([doneMutation(WORKER_ID), doneMutation(OTHER_WORKER_ID)]);
  });

  it('marks again when a read worker runs new work and finishes again', () => {
    const running = computeWorkerAttentionUpdates(
      new Map([[WORKER_ID, observed('done')]]),
      [worker(WORKER_ID, 'running')],
      LEAD_ID,
    );
    const doneAgain = computeWorkerAttentionUpdates(
      running.nextStateByWorkerId,
      [worker(WORKER_ID, 'done')],
      LEAD_ID,
    );

    expect(doneAgain.toMark).toEqual([doneMutation(WORKER_ID)]);
  });

  it('keeps unread completion attention when the worker starts new work', () => {
    const result = computeWorkerAttentionUpdates(
      new Map([[WORKER_ID, observed('done')]]),
      [worker(WORKER_ID, 'idle')],
      undefined,
    );

    expect(result.toPrune).not.toContain(WORKER_ID);
  });

  it('does not mark when the focused worker finishes in the active lead', () => {
    const result = computeWorkerAttentionUpdates(
      new Map(),
      [worker(WORKER_ID, 'done', true)],
      LEAD_ID,
    );

    expect(result.toMark).toEqual([]);
  });

  it('does not re-mark when switching away and back without a status change', () => {
    const prev = new Map<string, WorkerAttentionObservedState>([[WORKER_ID, observed('done')]]);

    const away = computeWorkerAttentionUpdates(prev, [worker(WORKER_ID, 'done')], undefined);
    const back = computeWorkerAttentionUpdates(
      away.nextStateByWorkerId,
      [worker(WORKER_ID, 'done', true)],
      LEAD_ID,
    );

    expect(away.toMark).toEqual([]);
    expect(back.toMark).toEqual([]);
  });

  it('prunes workers that no longer exist', () => {
    const result = computeWorkerAttentionUpdates(
      new Map([
        [WORKER_ID, observed('done')],
        [OTHER_WORKER_ID, observed('idle')],
      ]),
      [worker(OTHER_WORKER_ID, 'idle')],
      LEAD_ID,
    );

    expect(result.toPrune).toEqual([WORKER_ID]);
    expect(result.nextStateByWorkerId.has(WORKER_ID)).toBe(false);
  });
});
