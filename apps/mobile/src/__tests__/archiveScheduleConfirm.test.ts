import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  mayHave: vi.fn(() => true),
}));

vi.mock('react-native', () => ({ Alert: { alert: vi.fn() } }));
vi.mock('@/session/scheduleIndex', () => ({ sessionMayHaveScheduleRuns: mocks.mayHave }));

import {
  countSessionsWithActiveBoundSchedules,
  loadActiveBoundScheduleNames,
  SCHEDULE_LOOKUP_WAIT_MS,
} from '@/session/archiveScheduleConfirm';

const args = { deviceId: 'pc', invoke: mocks.list, sessionId: 'task' } as never;

describe('archive schedule lookup deadline', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.list.mockReset();
    mocks.mayHave.mockReturnValue(true);
  });
  afterEach(() => vi.useRealTimers());

  it('treats a slow list request as no binding instead of blocking archive', async () => {
    mocks.list.mockReturnValue(new Promise(() => {}));

    const single = loadActiveBoundScheduleNames(args);
    const bulk = countSessionsWithActiveBoundSchedules('pc', mocks.list as never, [{ id: 'task' }]);
    await vi.advanceTimersByTimeAsync(SCHEDULE_LOOKUP_WAIT_MS);

    await expect(single).resolves.toEqual([]);
    await expect(bulk).resolves.toBe(0);
  });

  it('reports both ordinary and persistent active bindings that will restore the task', async () => {
    mocks.list.mockResolvedValue([
      { id: 'a', name: 'Daily', status: 'active', targetSessionId: 'task' },
      { id: 'b', name: 'Persistent', status: 'active', targetSessionId: 'task', persistentSession: true },
    ]);

    await expect(loadActiveBoundScheduleNames(args)).resolves.toEqual(['Daily', 'Persistent']);
  });

  it('asks only for the binding projection so a large list cannot overflow the frame', async () => {
    mocks.list.mockResolvedValue([]);

    await loadActiveBoundScheduleNames(args);
    await countSessionsWithActiveBoundSchedules('pc', mocks.list as never, [{ id: 'task' }]);

    for (const call of mocks.list.mock.calls) {
      expect(call).toEqual(['pc', 'maker:schedule:list', [null, { sessionBindings: true }]]);
    }
  });

  it('bulk archive skips the request when every candidate is known unbound', async () => {
    mocks.mayHave.mockReturnValue(false);

    await expect(
      countSessionsWithActiveBoundSchedules('pc', mocks.list as never, [{ id: 'a' }, { id: 'b' }]),
    ).resolves.toBe(0);
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it('bulk archive still queries once when any candidate may be bound', async () => {
    mocks.mayHave.mockImplementation(((_d: string, id: string) => id === 'b') as never);
    mocks.list.mockResolvedValue([{ id: 's', name: 'Daily', status: 'active', targetSessionId: 'b' }]);

    await expect(
      countSessionsWithActiveBoundSchedules('pc', mocks.list as never, [{ id: 'a' }, { id: 'b' }]),
    ).resolves.toBe(1);
    expect(mocks.list).toHaveBeenCalledTimes(1);
  });

  it('skips the request for tasks known to be unbound', async () => {
    mocks.mayHave.mockReturnValue(false);

    await expect(loadActiveBoundScheduleNames(args)).resolves.toEqual([]);
    expect(mocks.list).not.toHaveBeenCalled();
  });
});
