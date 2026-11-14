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
  reportState?: WorkerAttentionRecord['reportState'],
): WorkerAttentionRecord {
  return {
    workerId,
    leadSessionId: LEAD_ID,
    status,
    focused,
    ...(reportState ? { reportState } : {}),
  };
}

describe('computeWorkerAttentionUpdates', () => {
  // 结构化回报 dropped = 无需人工处理，不该亮「完成未读」绿点。
  it('does not mark attention for a worker that reported nothing to act on', () => {
    const result = computeWorkerAttentionUpdates(
      new Map([[WORKER_ID, 'running']]),
      [worker(WORKER_ID, 'done', false, 'dropped')],
      LEAD_ID,
    );

    expect(result.toMark).toEqual([]);
  });

  // 终止事件先广播、dropped 回执后到：状态不会再进入 done，必须由回报变化撤掉已亮的点。
  it('clears a mark when a late report turns out to be dropped', () => {
    const lit = computeWorkerAttentionUpdates(
      new Map([[WORKER_ID, 'running']]),
      [worker(WORKER_ID, 'done', false, 'ready')],
      LEAD_ID,
    );
    expect(lit.toMark).toEqual([WORKER_ID]);

    const corrected = computeWorkerAttentionUpdates(
      lit.nextStatusByWorkerId,
      [worker(WORKER_ID, 'done', false, 'dropped')],
      LEAD_ID,
    );
    expect(corrected.toClear).toEqual([WORKER_ID]);
  });

  // 一轮 dropped 之后的新一轮不能再被旧回报判成「无需处理」（宿主任新 turn 起点清空回报）。
  it('does not treat a fresh done as dropped once the new round cleared the report', () => {
    const result = computeWorkerAttentionUpdates(
      new Map([[WORKER_ID, 'running']]),
      [worker(WORKER_ID, 'done')],
      LEAD_ID,
    );
    expect(result.toMark).toEqual([WORKER_ID]);
    expect(result.toClear).toEqual([]);
  });

  it('still marks attention for ready and blocked reports that need a person', () => {
    const ready = computeWorkerAttentionUpdates(
      new Map([[WORKER_ID, 'running'], [OTHER_WORKER_ID, 'running']]),
      [worker(WORKER_ID, 'done', false, 'ready'), worker(OTHER_WORKER_ID, 'done', false, 'blocked')],
      LEAD_ID,
    );

    expect(ready.toMark).toEqual([WORKER_ID, OTHER_WORKER_ID]);
  });

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

  it('keeps unread completion attention when the worker starts new work', () => {
    const result = computeWorkerAttentionUpdates(
      new Map([[WORKER_ID, 'done']]),
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
