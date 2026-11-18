import { describe, expect, it, vi } from 'vitest';
import type { OrcaWorkerStatus } from '../../../../shared/orca-worker-status';

vi.mock('../workerProjectionStore', () => ({
  getWorkerProjectionSnapshot: () => ({ workers: [] }),
  useWorkerProjectionOwners: () => undefined,
  useWorkerProjectionVersion: () => 0,
}));

import {
  computeWorkerAttentionUpdates,
  type WorkerAttentionRecord,
} from '../useOrcaWorkerAttentionWatcher';

function worker(
  workerId: string,
  status: OrcaWorkerStatus,
  opts: { focused?: boolean; reportDropped?: boolean } = {},
): WorkerAttentionRecord {
  return {
    workerId,
    leadSessionId: 'lead',
    status,
    focused: opts.focused ?? false,
    reportDropped: opts.reportDropped ?? false,
  };
}

describe('computeWorkerAttentionUpdates', () => {
  it('非聚焦 Worker 进入 done 且回报非 dropped 时标记未读', () => {
    const updates = computeWorkerAttentionUpdates(
      new Map(),
      [worker('w1', 'running'), worker('w2', 'done')],
      undefined,
    );
    expect(updates.toMark).toEqual(['w2']);
    expect(updates.toClear).toEqual([]);
  });

  it('dropped 回报到达即撤销未读标记,不再产生新标记', () => {
    const updates = computeWorkerAttentionUpdates(
      new Map([['w1', 'done']]),
      [worker('w1', 'done', { reportDropped: true })],
      undefined,
    );
    expect(updates.toMark).toEqual([]);
    expect(updates.toClear).toEqual(['w1']);
  });

  it('已标记未读的 Worker 状态保持 done 时不再重复标记', () => {
    const updates = computeWorkerAttentionUpdates(
      new Map([['w1', 'done']]),
      [worker('w1', 'done')],
      undefined,
    );
    expect(updates.toMark).toEqual([]);
  });
});
