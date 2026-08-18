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

function compactPagingMaker(
  runs: readonly { id: string; scheduleId: string }[],
  markImpl: (runId: string) => Promise<void> = async () => undefined,
) {
  const read = new Set<string>();
  const listSidebarIndexRuns = vi.fn(async () => ({
    runs: runs
      .filter((run) => !read.has(run.id))
      .slice(0, 50)
      .map((run, index) => ({
        runId: run.id,
        scheduleId: run.scheduleId,
        sessionId: 'session-1',
        firedAt: runs.length - index,
        status: 'success' as const,
      })),
    inflightRunIds: [],
  }));
  const markRunRead = vi.fn(async (runId: string) => {
    await markImpl(runId);
    read.add(runId);
  });
  const maker = {
    schedule: {
      list: async () => [
        { id: 'sched-a', name: 'A', status: 'active' },
        { id: 'sched-b', name: 'B', status: 'active' },
      ],
      listRuns: vi.fn(async () => []),
      listSidebarIndexRuns,
      markRunRead,
    },
  } as unknown as Pick<MobileMakerTransport, 'schedule'>;
  return { listSidebarIndexRuns, maker, markRunRead };
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

  it('drains 60 unread runs across compact pages and schedules', async () => {
    const runs = [
      ...Array.from({ length: 30 }, (_, index) => ({ id: `a-${index}`, scheduleId: 'sched-a' })),
      ...Array.from({ length: 30 }, (_, index) => ({ id: `b-${index}`, scheduleId: 'sched-b' })),
    ];
    const { listSidebarIndexRuns, maker, markRunRead } = compactPagingMaker(runs);

    await expect(markSessionScheduleRunsRead(maker, 'session-1'))
      .resolves.toEqual(runs.map((run) => run.id));
    expect(markRunRead).toHaveBeenCalledTimes(60);
    expect(listSidebarIndexRuns).toHaveBeenCalledTimes(3);
  });

  it('lets a permanent failure occupy one slot while draining later pages, then stops', async () => {
    const runs = Array.from({ length: 55 }, (_, index) => ({
      id: `run-${index}`,
      scheduleId: index < 30 ? 'sched-a' : 'sched-b',
    }));
    const { listSidebarIndexRuns, maker, markRunRead } = compactPagingMaker(
      runs,
      async (runId) => {
        if (runId === 'run-0') throw new Error('not found');
      },
    );

    await expect(markSessionScheduleRunsRead(maker, 'session-1'))
      .resolves.toEqual(runs.slice(1).map((run) => run.id));
    expect(markRunRead).toHaveBeenCalledTimes(55);
    expect(markRunRead.mock.calls.filter(([runId]) => runId === 'run-0')).toHaveLength(1);
    expect(listSidebarIndexRuns).toHaveBeenCalledTimes(3);
  });

  it('does not remark or loop on a repeated static compact page', async () => {
    const markRunRead = vi.fn(async (_runId: string) => undefined);
    const listSidebarIndexRuns = vi.fn(async () => ({
      runs: ['run-a', 'run-b'].map((runId, index) => ({
        runId,
        scheduleId: 'sched-a',
        sessionId: 'session-1',
        firedAt: index + 1,
        status: 'success' as const,
      })),
      inflightRunIds: [],
    }));
    const maker = {
      schedule: {
        list: async () => [{ id: 'sched-a', name: 'A', status: 'active' }],
        listRuns: vi.fn(async () => []),
        listSidebarIndexRuns,
        markRunRead,
      },
    } as unknown as Pick<MobileMakerTransport, 'schedule'>;

    await expect(markSessionScheduleRunsRead(maker, 'session-1'))
      .resolves.toEqual(['run-a', 'run-b']);
    expect(markRunRead.mock.calls.map(([runId]) => runId)).toEqual(['run-a', 'run-b']);
    expect(listSidebarIndexRuns).toHaveBeenCalledTimes(2);
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
