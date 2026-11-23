// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { Schedule, SchedulerEvent } from '@cindy/maker-scheduler';
import { useScheduleRunSummary } from '@/features/scheduler/hooks/useScheduleRunSummary';
import type { ScheduleSidebarIndexRun } from '@/features/scheduler/lib/scheduleSidebarIndexRuns';

function run(overrides: Partial<ScheduleSidebarIndexRun>): ScheduleSidebarIndexRun {
  return {
    runId: 'failure', scheduleId: 'schedule-1', scheduleName: 'Schedule',
    scheduleStatus: 'active', status: 'failed', firedAt: 10, ...overrides,
  };
}

function mountCounts(runs: ScheduleSidebarIndexRun[]) {
  let listener: ((event: SchedulerEvent) => void) | undefined;
  vi.stubGlobal('electronAPI', { maker: { schedule: {
    listSidebarIndexRuns: vi.fn().mockResolvedValue({ runs }),
    onEvent: vi.fn((callback: (event: SchedulerEvent) => void) => {
      listener = callback;
      return () => { listener = undefined; };
    }),
  } } });
  const schedules = [{ id: 'schedule-1' }, { id: 'schedule-2' }] as Schedule[];
  return {
    ...renderHook(() => useScheduleRunSummary(schedules)),
    read: () => listener?.({ type: 'read', scheduleId: 'schedule-1' }),
    complete: () => listener?.({ type: 'completed', scheduleId: 'schedule-1', runId: 'success', sessionId: 'session-1' }),
  };
}

afterEach(() => vi.unstubAllGlobals());

it('clears recovered failures on completion while retaining unread success until read', async () => {
  const runs = [run({})];
  const view = mountCounts(runs);
  await waitFor(() => expect(view.result.current.unreadRunCounts.get('schedule-1')).toBe(1));

  runs.unshift(run({ runId: 'success', status: 'success', firedAt: 20 }));
  await act(async () => view.complete());
  expect(view.result.current.unreadRunCounts.get('schedule-1')).toBe(1);
  expect(view.result.current.unrecoveredFailures.has('schedule-1')).toBe(false);

  runs[0].readAt = 30;
  await act(async () => view.complete());
  expect(view.result.current.unreadRunCounts.get('schedule-1') ?? 0).toBe(0);
  expect(runs[1].readAt).toBeUndefined();

  runs.push(run({ runId: 'new-failure', status: 'interrupted', firedAt: 40 }));
  await act(async () => view.complete());
  expect(view.result.current.unreadRunCounts.get('schedule-1')).toBe(1);
  expect(view.result.current.unrecoveredFailures.get('schedule-1')?.runId).toBe('new-failure');
});

// #10941, renderer unit tier: a read event clears the dot, not the failure status.
it('keeps a sessionless failure visible after its run is marked read', async () => {
  const runs = [run({})];
  const view = mountCounts(runs);
  await waitFor(() => expect(view.result.current.unreadRunCounts.get('schedule-1')).toBe(1));
  runs[0].readAt = 15;
  await act(async () => view.read());
  expect(view.result.current.unreadRunCounts.has('schedule-1')).toBe(false);
  expect(view.result.current.unrecoveredFailures.get('schedule-1')?.runId).toBe('failure');
});

it('honors host recovery flags without requiring the success row or a session binding', async () => {
  const view = mountCounts([
    run({ failureRecovered: true }),
    run({ runId: 'unread-success', status: 'success', scheduleId: 'schedule-2' }),
  ]);
  await waitFor(() => expect(view.result.current.unreadRunCounts.get('schedule-2')).toBe(1));
  expect(view.result.current.unreadRunCounts.get('schedule-1') ?? 0).toBe(0);
  expect(view.result.current.unrecoveredFailures.has('schedule-1')).toBe(false);
});

it('keeps real failures when another schedule succeeds and ignores hidden schedules', async () => {
  const view = mountCounts([
    run({}),
    run({ runId: 'other-success', status: 'success', scheduleId: 'schedule-2', firedAt: 20, readAt: 30 }),
    run({ runId: 'hidden-failure', scheduleId: 'hidden' }),
  ]);
  await waitFor(() => expect(view.result.current.unreadRunCounts.get('schedule-1')).toBe(1));
  expect(view.result.current.unreadRunCounts.size).toBe(1);
  expect([...view.result.current.unrecoveredFailures.keys()]).toEqual(['schedule-1']);
});
