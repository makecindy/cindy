// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { Schedule, SchedulerEvent } from '@cindy/maker-scheduler';
import { useScheduleRunAttention } from '@/features/scheduler/hooks/useScheduleUnreadRunCounts';
import type { ScheduleSidebarIndexRun } from '@/features/scheduler/lib/scheduleSidebarIndexRuns';

function run(overrides: Partial<ScheduleSidebarIndexRun>): ScheduleSidebarIndexRun {
  return {
    runId: 'failure', scheduleId: 'schedule-1', scheduleName: 'Schedule',
    scheduleStatus: 'active', status: 'failed', firedAt: 10, ...overrides,
  };
}

function mountAttention(
  runs: ScheduleSidebarIndexRun[],
  schedules: Schedule[] = [{ id: 'schedule-1' }, { id: 'schedule-2' }] as Schedule[],
) {
  let listener: ((event: SchedulerEvent) => void) | undefined;
  vi.stubGlobal('electronAPI', { maker: { schedule: {
    listSidebarIndexRuns: vi.fn().mockResolvedValue({ runs }),
    onEvent: vi.fn((callback: (event: SchedulerEvent) => void) => {
      listener = callback;
      return () => { listener = undefined; };
    }),
  } } });
  return {
    ...renderHook(() => useScheduleRunAttention(schedules)),
    complete: () => listener?.({ type: 'completed', scheduleId: 'schedule-1', runId: 'success', sessionId: 'session-1' }),
  };
}

afterEach(() => vi.unstubAllGlobals());

it('shows red for an unread failure, clears it once read, and lets a later success recover it', async () => {
  const runs = [run({})];
  const view = mountAttention(runs);
  await waitFor(() => expect(view.result.current.get('schedule-1')).toBe('error'));

  runs[0].readAt = 11;
  await act(async () => view.complete());
  expect(view.result.current.get('schedule-1')).toBeUndefined();

  runs[0].readAt = undefined;
  runs.unshift(run({ runId: 'success', status: 'success', firedAt: 20 }));
  await act(async () => view.complete());
  expect(view.result.current.get('schedule-1')).toBe('done');

  runs[0].readAt = 30;
  await act(async () => view.complete());
  expect(view.result.current.get('schedule-1')).toBeUndefined();

  runs.push(run({ runId: 'new-failure', status: 'interrupted', firedAt: 40 }));
  await act(async () => view.complete());
  expect(view.result.current.get('schedule-1')).toBe('error');
});

it('honors host recovery flags and ignores hidden schedules', async () => {
  const view = mountAttention([
    run({ failureRecovered: true }),
    run({ runId: 'unread-success', status: 'success', scheduleId: 'schedule-2' }),
    run({ runId: 'hidden-failure', scheduleId: 'hidden' }),
  ]);
  await waitFor(() => expect(view.result.current.get('schedule-2')).toBe('done'));
  expect([...view.result.current.keys()]).toEqual(['schedule-2']);
});

it('paused schedule 的未读运行依然会点亮 —— paused 语义已由降饱和和副标题表达,不再走点', async () => {
  // 维护者裁决(#10492): 黄点取消,paused 状态不扣点;运行记录是什么就显示什么。
  const pausedSchedule = [{ id: 'schedule-1', status: 'paused' } as Schedule];
  const view = mountAttention([run({ status: 'success' })], pausedSchedule);
  await waitFor(() => expect(view.result.current.get('schedule-1')).toBe('done'));
});
