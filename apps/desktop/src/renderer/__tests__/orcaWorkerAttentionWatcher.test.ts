import { describe, expect, it } from 'vitest';

import {
  computeWorkerAttentionUpdates,
  type WorkerAttentionRecord,
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
  };
}

describe('computeWorkerAttentionUpdates', () => {
  it('marks attention on running to done transition', () => {
    const result = computeWorkerAttentionUpdates(
      new Map([[WORKER_ID, 'running']]),
      [worker(WORKER_ID, 'done')],
      LEAD_ID,
    );

    expect(result.toMark).toEqual([WORKER_ID]);
  });

  it('marks attention for first observed done status so remount can restore unread state', () => {
    const result = computeWorkerAttentionUpdates(
      new Map(),
      [worker(WORKER_ID, 'done')],
      LEAD_ID,
    );

    expect(result.toMark).toEqual([WORKER_ID]);
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

    expect(result.toMark).toEqual([WORKER_ID, OTHER_WORKER_ID]);
  });

  it('marks again when a read worker runs new work and finishes again', () => {
    const running = computeWorkerAttentionUpdates(
      new Map([[WORKER_ID, 'done']]),
      [worker(WORKER_ID, 'running')],
      LEAD_ID,
    );
    const doneAgain = computeWorkerAttentionUpdates(
      running.nextStatusByWorkerId,
      [worker(WORKER_ID, 'done')],
      LEAD_ID,
    );

    expect(doneAgain.toMark).toEqual([WORKER_ID]);
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
    const prev = new Map<string, OrcaWorkerStatus>([[WORKER_ID, 'done']]);

    const away = computeWorkerAttentionUpdates(prev, [worker(WORKER_ID, 'done')], undefined);
    const back = computeWorkerAttentionUpdates(
      away.nextStatusByWorkerId,
      [worker(WORKER_ID, 'done', true)],
      LEAD_ID,
    );

    expect(away.toMark).toEqual([]);
    expect(back.toMark).toEqual([]);
  });

  it('prunes workers that no longer exist', () => {
    const result = computeWorkerAttentionUpdates(
      new Map([
        [WORKER_ID, 'done'],
        [OTHER_WORKER_ID, 'idle'],
      ]),
      [worker(OTHER_WORKER_ID, 'idle')],
      LEAD_ID,
    );

    expect(result.toPrune).toEqual([WORKER_ID]);
    expect(result.nextStatusByWorkerId.has(WORKER_ID)).toBe(false);
  });
});
