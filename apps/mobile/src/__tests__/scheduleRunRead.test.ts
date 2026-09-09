import { describe, expect, it, vi } from 'vitest';
import { projectScheduleEvent } from '@cindy/maker-shared/schedule-events';
import type { MobileMakerTransport } from '@/device-link/mobileMakerTransport';
import { markSessionScheduleRunsRead, unreadRunIdFromProjection } from '@/session/scheduleRunRead';

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
  it('marks only the target session unread runs as read', async () => {
    const markRunRead = vi.fn(async () => undefined);
    const maker = makerWith([
      { id: 'run-mine-unread', scheduleId: 'sched-1', sessionId: 'session-1', status: 'success', firedAt: 1 },
      { id: 'run-mine-read', scheduleId: 'sched-1', sessionId: 'session-1', status: 'success', firedAt: 2, readAt: 3 },
      { id: 'run-other-session', scheduleId: 'sched-1', sessionId: 'session-2', status: 'success', firedAt: 4 },
      { id: 'run-still-running', scheduleId: 'sched-1', sessionId: 'session-1', status: 'running', firedAt: 5 },
    ], markRunRead);

    const marked = await markSessionScheduleRunsRead(maker, 'session-1');

    expect(marked).toEqual(['run-mine-unread']);
    expect(markRunRead).toHaveBeenCalledTimes(1);
    expect(markRunRead).toHaveBeenCalledWith('run-mine-unread');
  });

  it('returns empty without invoking markRunRead when the session has no unread runs', async () => {
    const markRunRead = vi.fn(async () => undefined);
    const maker = makerWith([
      { id: 'run-read', scheduleId: 'sched-1', sessionId: 'session-1', status: 'success', firedAt: 1, readAt: 2 },
    ], markRunRead);

    await expect(markSessionScheduleRunsRead(maker, 'session-1')).resolves.toEqual([]);
    await expect(markSessionScheduleRunsRead(maker, '')).resolves.toEqual([]);
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

    const marked = await markSessionScheduleRunsRead(maker, 'session-1');

    expect(marked).toEqual(['run-b']);
    expect(markRunRead).toHaveBeenCalledTimes(2);
  });

  it('rejects on transient listRuns failures so the caller retry wrapper can rerun the probe', async () => {
    const error = transientError();
    const markRunRead = vi.fn(async () => undefined);
    const maker = makerWith([], markRunRead, async () => {
      throw error;
    });

    await expect(markSessionScheduleRunsRead(maker, 'session-1')).rejects.toBe(error);
    expect(markRunRead).not.toHaveBeenCalled();
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

    await expect(markSessionScheduleRunsRead(maker, 'session-1')).rejects.toBe(error);
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

    await expect(markSessionScheduleRunsRead(maker, 'session-1')).resolves.toEqual(['run-a', 'run-b']);
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

it('shares the supplied index with the notice and ignores a late result after leaving', async () => {
  const markRunRead = vi.fn(async () => undefined);
  const maker = makerWith([], markRunRead);
  const onIndex = vi.fn();
  const index = new Map([['session-1', { scheduleId: 's', scheduleName: 's', unreadRunIds: ['r'], unreadCount: 1,
    running: false, latestRunAt: 1, latestFailedRun: { runId: 'r', firedAt: 1 } }]]);
  let active = true;
  let finish!: (value: typeof index) => void;
  const pending = markSessionScheduleRunsRead(maker, 'session-1', {
    isActive: () => active, onIndex, loadIndex: () => new Promise((resolve) => { finish = resolve; }),
  });
  active = false; finish(index); await pending;
  expect(onIndex).not.toHaveBeenCalled(); expect(markRunRead).not.toHaveBeenCalled();
  await markSessionScheduleRunsRead(maker, 'session-1', { isActive: () => true, onIndex, loadIndex: async () => index });
  expect(onIndex).toHaveBeenCalledWith(index); expect(markRunRead).toHaveBeenCalledWith('r');
});
