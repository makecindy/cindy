import { beforeEach, describe, expect, it, vi } from 'vitest';
import { projectScheduleEvent } from '@cindy/maker-shared/schedule-events';
import type { MobileMakerTransport } from '@/device-link/mobileMakerTransport';
import { markSessionScheduleRunsRead, unreadRunIdFromProjection } from '@/session/scheduleRunRead';
import { invalidateScheduleIndexForDevice, invalidateScheduleIndexesAfterLinkRecovery, loadSessionScheduleIndex, loadSessionScheduleIndexThrottled, loadSharedSessionScheduleIndex, resetScheduleIndexThrottleForTesting } from '@/session/scheduleIndex';

function makerWith(
  runs: readonly Record<string, unknown>[],
  markRunRead: (runId: string) => Promise<void>,
  listRuns?: (scheduleId: string, limit?: number) => Promise<readonly Record<string, unknown>[]>,
): Pick<MobileMakerTransport, 'schedule'> {
  return {
    schedule: {
      list: async () => [{ id: 'sched-1', name: '日报', status: 'active' }],
      listRuns: listRuns ?? (async () => runs),
      markRunRead,
    },
  } as unknown as Pick<MobileMakerTransport, 'schedule'>;
}

function transientError(message = 'target timed out'): Error & { code: string } {
  return Object.assign(new Error(message), { code: 'INVOKE_TIMEOUT' });
}

describe('markSessionScheduleRunsRead', () => {
  beforeEach(resetScheduleIndexThrottleForTesting);
  it('finds runs completed while disconnected even when the old success cache is still fresh', async () => {
    const mark = vi.fn(async () => undefined);
    const listRuns = vi.fn().mockResolvedValueOnce([]).mockResolvedValue([
      { id: 'run-offline', scheduleId: 'sched-1', sessionId: 'session-1', status: 'success', firedAt: 1 },
    ]);
    const maker = makerWith([], mark, listRuns);
    await loadSharedSessionScheduleIndex('dev-1', maker);
    // No completed push arrives during disconnection. Recovery alone must refresh.
    invalidateScheduleIndexesAfterLinkRecovery();
    const home = loadSharedSessionScheduleIndex('dev-1', maker);
    await expect(markSessionScheduleRunsRead(maker, 'session-1', 'dev-1')).resolves.toEqual(['run-offline']);
    await home;
    expect(listRuns).toHaveBeenCalledTimes(2);
    expect(mark).toHaveBeenCalledExactlyOnceWith('run-offline');
  });
  it('retries a transient scan inside the shared load before caching failure', async () => {
    const mark = vi.fn(async () => undefined);
    const listRuns = vi.fn().mockRejectedValueOnce(transientError()).mockResolvedValue([
      { id: 'run-1', scheduleId: 'sched-1', sessionId: 'session-1', status: 'success', firedAt: 1 },
    ]);
    const maker = makerWith([], mark, listRuns);
    const home = loadSharedSessionScheduleIndex('dev-1', maker);
    const task = markSessionScheduleRunsRead(maker, 'session-1', 'dev-1');
    await home;
    await expect(task).resolves.toEqual(['run-1']);
    expect(listRuns).toHaveBeenCalledTimes(2);
  });

  it('abandons a queued refresh after blur without poisoning the next visible consumer', async () => {
    let finish!: (index: Map<string, never>) => void;
    const old = loadSessionScheduleIndexThrottled('dev-1', () => new Promise((resolve) => { finish = resolve; }));
    invalidateScheduleIndexForDevice('dev-1');
    let active = true;
    const listRuns = vi.fn(async () => []);
    const maker = makerWith([], vi.fn(async () => undefined), listRuns);
    const task = markSessionScheduleRunsRead(maker, 'session-1', 'dev-1', () => active);
    const assertion = expect(task).rejects.toThrow('consumer inactive');
    active = false;
    finish(new Map<string, never>());
    await old;
    await assertion;
    expect(listRuns).not.toHaveBeenCalled();
    await markSessionScheduleRunsRead(maker, 'session-1', 'dev-1');
    expect(listRuns).toHaveBeenCalledTimes(1);
  });
  it('marks only the target session unread runs as read', async () => {
    const markRunRead = vi.fn(async () => undefined);
    const maker = makerWith([
      { id: 'run-mine-unread', scheduleId: 'sched-1', sessionId: 'session-1', status: 'success', firedAt: 1 },
      { id: 'run-mine-read', scheduleId: 'sched-1', sessionId: 'session-1', status: 'success', firedAt: 2, readAt: 3 },
      { id: 'run-other-session', scheduleId: 'sched-1', sessionId: 'session-2', status: 'success', firedAt: 4 },
      { id: 'run-still-running', scheduleId: 'sched-1', sessionId: 'session-1', status: 'running', firedAt: 5 },
    ], markRunRead);

    const marked = await markSessionScheduleRunsRead(maker, 'session-1', 'dev-1');

    expect(marked).toEqual(['run-mine-unread']);
    expect(markRunRead).toHaveBeenCalledTimes(1);
    expect(markRunRead).toHaveBeenCalledWith('run-mine-unread');
  });

  it('returns empty without invoking markRunRead when the session has no unread runs', async () => {
    const markRunRead = vi.fn(async () => undefined);
    const maker = makerWith([
      { id: 'run-read', scheduleId: 'sched-1', sessionId: 'session-1', status: 'success', firedAt: 1, readAt: 2 },
    ], markRunRead);

    await expect(markSessionScheduleRunsRead(maker, 'session-1', 'dev-1')).resolves.toEqual([]);
    await expect(markSessionScheduleRunsRead(maker, '', 'dev-1')).resolves.toEqual([]);
    expect(markRunRead).not.toHaveBeenCalled();
  });

  it('keeps marking the remaining runs when one markRunRead call fails', async () => {
    const markRunRead = vi.fn(async (runId: string) => {
      if (runId === 'run-a') throw new Error('device offline');
    });
    const maker = makerWith([
      { id: 'run-a', scheduleId: 'sched-1', sessionId: 'session-1', status: 'success', firedAt: 1 },
      { id: 'run-b', scheduleId: 'sched-1', sessionId: 'session-1', status: 'failed', firedAt: 2 },
    ], markRunRead);

    const marked = await markSessionScheduleRunsRead(maker, 'session-1', 'dev-1');

    expect(marked).toEqual(['run-b']);
    expect(markRunRead).toHaveBeenCalledTimes(2);
  });

  it('rejects after the shared transient scan retry is exhausted', async () => {
    vi.useFakeTimers();
    const error = transientError();
    const markRunRead = vi.fn(async () => undefined);
    const maker = makerWith([], markRunRead, async () => {
      throw error;
    });

    try {
      const assertion = expect(markSessionScheduleRunsRead(maker, 'session-1', 'dev-1')).rejects.toBe(error);
      await vi.runAllTimersAsync();
      await assertion;
      expect(markRunRead).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it('rejects on transient markRunRead failures so the caller retry wrapper can rerun the mark', async () => {
    const error = transientError('device offline');
    const markRunRead = vi.fn(async (runId: string) => {
      if (runId === 'run-a') throw error;
    });
    const maker = makerWith([
      { id: 'run-a', scheduleId: 'sched-1', sessionId: 'session-1', status: 'success', firedAt: 1 },
      { id: 'run-b', scheduleId: 'sched-1', sessionId: 'session-1', status: 'failed', firedAt: 2 },
    ], markRunRead);

    await expect(markSessionScheduleRunsRead(maker, 'session-1', 'dev-1')).rejects.toBe(error);
    expect(markRunRead).toHaveBeenCalledTimes(2);
  });

  it('returns marked run ids in the original unread order regardless of resolution timing', async () => {
    const markRunRead = vi.fn((runId: string) => new Promise<void>((resolve) => {
      // run-a 比 run-b 晚 resolve,返回值仍应保持 unreadRunIds 原序。
      setTimeout(resolve, runId === 'run-a' ? 20 : 0);
    }));
    const maker = makerWith([
      { id: 'run-a', scheduleId: 'sched-1', sessionId: 'session-1', status: 'success', firedAt: 1 },
      { id: 'run-b', scheduleId: 'sched-1', sessionId: 'session-1', status: 'success', firedAt: 2 },
    ], markRunRead);

    await expect(markSessionScheduleRunsRead(maker, 'session-1', 'dev-1')).resolves.toEqual(['run-a', 'run-b']);
  });

  it('reuses the home scan across ordinary task visits without losing bound task receipts', async () => {
    const listRuns = vi.fn(async () => [
      { id: 'run-1', scheduleId: 'sched-1', sessionId: 'bound-task', status: 'success', firedAt: 1 },
    ]);
    const mark = vi.fn(async () => undefined);
    const maker = makerWith([], mark, listRuns);
    await loadSessionScheduleIndexThrottled('dev-1', () => loadSessionScheduleIndex(maker));
    await markSessionScheduleRunsRead(maker, 'ordinary-1', 'dev-1');
    await markSessionScheduleRunsRead(maker, 'ordinary-2', 'dev-1');
    await markSessionScheduleRunsRead(maker, 'bound-task', 'dev-1');
    expect(listRuns).toHaveBeenCalledTimes(1);
    expect(mark).toHaveBeenCalledExactlyOnceWith('run-1');
  });

  it('does not start a scan when inactive or mark receipts after leaving during a shared scan', async () => {
    let finish!: (runs: Record<string, unknown>[]) => void;
    const listRuns = vi.fn(() => new Promise<Record<string, unknown>[]>((resolve) => { finish = resolve; }));
    const mark = vi.fn(async () => undefined);
    const maker = makerWith([], mark, listRuns);
    await markSessionScheduleRunsRead(maker, 'session-1', 'dev-1', () => false);
    expect(listRuns).not.toHaveBeenCalled();
    let active = true;
    const pending = markSessionScheduleRunsRead(maker, 'session-1', 'dev-1', () => active);
    await vi.waitFor(() => expect(listRuns).toHaveBeenCalledTimes(1));
    active = false;
    finish([{ id: 'run-1', scheduleId: 'sched-1', sessionId: 'session-1', status: 'success', firedAt: 1 }]);
    await expect(pending).resolves.toEqual([]);
    expect(mark).not.toHaveBeenCalled();
  });
});

describe('unreadRunIdFromProjection', () => {
  it('returns the runId for a completed run bound to this session', () => {
    const projection = projectScheduleEvent({
      type: 'completed',
      scheduleId: 'sched-1',
      runId: 'run-1',
      sessionId: 'session-1',
    });
    expect(unreadRunIdFromProjection(projection, 'session-1')).toBe('run-1');
  });

  it('ignores events for other sessions and non-terminal statuses', () => {
    const completedElsewhere = projectScheduleEvent({
      type: 'completed',
      scheduleId: 'sched-1',
      runId: 'run-1',
      sessionId: 'session-2',
    });
    const bound = projectScheduleEvent({
      type: 'session-bound',
      scheduleId: 'sched-1',
      runId: 'run-1',
      sessionId: 'session-1',
    });
    expect(unreadRunIdFromProjection(completedElsewhere, 'session-1')).toBeNull();
    expect(unreadRunIdFromProjection(bound, 'session-1')).toBeNull();
    expect(unreadRunIdFromProjection(null, 'session-1')).toBeNull();
  });

  it('does not re-trigger on the read event broadcast after marking', () => {
    const readEvent = projectScheduleEvent({ type: 'read', scheduleId: 'sched-1' });
    expect(unreadRunIdFromProjection(readEvent, 'session-1')).toBeNull();
  });

  it('returns null for failed events: they carry no sessionId and are handled by the index probe path', () => {
    const failedEvent = projectScheduleEvent({
      type: 'failed',
      scheduleId: 'sched-1',
      runId: 'run-1',
      error: 'agent crashed',
    });
    expect(unreadRunIdFromProjection(failedEvent, 'session-1')).toBeNull();
  });
});

it('shares the cached index with the notice and ignores a late result after leaving', async () => {
  resetScheduleIndexThrottleForTesting();
  const markRunRead = vi.fn(async () => undefined);
  const runs = [{ id: 'r', scheduleId: 'sched-1', sessionId: 'session-1', status: 'failed', firedAt: 1 }];
  let finish!: (value: typeof runs) => void;
  const rows = new Promise<typeof runs>((resolve) => { finish = resolve; });
  const maker = makerWith([], markRunRead, () => rows);
  const onIndex = vi.fn();
  let active = true;
  const pending = markSessionScheduleRunsRead(maker, 'session-1', 'notice-device', () => active, { onIndex });
  active = false; finish(runs); await pending;
  expect(onIndex).not.toHaveBeenCalled(); expect(markRunRead).not.toHaveBeenCalled();
  await markSessionScheduleRunsRead(maker, 'session-1', 'notice-device', () => true, { onIndex });
  expect(onIndex.mock.calls[0][0].get('session-1')).toMatchObject({ latestFailedRun: { runId: 'r', firedAt: 1 } });
  expect(markRunRead).toHaveBeenCalledWith('r');
});
