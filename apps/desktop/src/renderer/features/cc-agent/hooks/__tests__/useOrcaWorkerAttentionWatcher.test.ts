import { describe, expect, it, vi } from 'vitest';

vi.mock('../workerProjectionStore', () => ({
  getWorkerProjectionSnapshot: () => ({
    workers: [],
    softLimit: 0,
    hardLimit: 0,
    workerStatus: 'applied',
    requestId: 0,
    updatedAt: 0,
  }),
  useWorkerProjectionOwners: () => undefined,
  useWorkerProjectionVersion: () => 0,
}));

import { computeWorkerAttentionUpdates } from '../useOrcaWorkerAttentionWatcher';

function worker(id: string, status: 'running' | 'done', reportDropped: boolean) {
  return {
    workerId: id,
    leadSessionId: 'lead',
    sessionId: id,
    role: 'developer' as const,
    agent: 'claude-code',
    model: 'm',
    effort: null,
    label: null,
    status,
    focused: false,
    idleSince: null,
    reportState: reportDropped ? 'dropped' : null,
    reportDropped,
  };
}

describe('computeWorkerAttentionUpdates', () => {
  it('running→done 标未读;dropped 回报映射的 done 不标', () => {
    const updates = computeWorkerAttentionUpdates(
      new Map(),
      [worker('w1', 'done', false), worker('w2', 'done', true)],
      undefined,
    );
    expect(updates.toMark).toEqual(['w1']);
    expect(updates.nextStatusByWorkerId.get('w1')).toBe('done');
    expect(updates.nextStatusByWorkerId.get('w2')).toBe('done');
  });

  it('已是 done 不重复标记;非 done 状态不标记', () => {
    const updates = computeWorkerAttentionUpdates(
      new Map([['w1', 'done' as const]]),
      [worker('w1', 'done', false), worker('w2', 'running', false)],
      undefined,
    );
    expect(updates.toMark).toEqual([]);
  });
});
