import { describe, expect, it } from 'vitest';
import {
  buildGeneratedSessionDispositionPatch,
  buildScheduleDeletePreview,
  buildScheduleDeleteTarget,
  collectGeneratedSessionIds,
  describeScheduleDeletePreview,
  isProjectAutomationSchedule,
} from '@/scheduler/scheduleDelete';
import type { RemoteSchedule, RemoteScheduleRun } from '@/scheduler/types';

function run(patch: Partial<RemoteScheduleRun>): RemoteScheduleRun {
  return {
    id: 'run-1',
    scheduleId: 'sched-1',
    status: 'success',
    ...patch,
  };
}

function schedule(patch: Partial<RemoteSchedule> = {}): RemoteSchedule {
  return {
    id: 'sched-1',
    name: '巡检',
    status: 'active',
    ...patch,
  };
}

describe('mobile schedule delete model', () => {
  it('collects unique generated session ids from known ids and schedule runs', () => {
    expect(collectGeneratedSessionIds([
      run({ id: 'r1', sessionId: 's1' }),
      run({ id: 'r2', sessionId: 's1' }),
      run({ id: 'r3', sessionId: 's2' }),
      run({ id: 'r4', sessionId: undefined }),
    ], ['s0', 's1'])).toEqual(['s0', 's1', 's2']);
  });

  it('builds preview copy with generated session and inflight counts', () => {
    const preview = buildScheduleDeletePreview([
      run({ id: 'r1', sessionId: 's1' }),
      run({ id: 'r2', sessionId: 's2' }),
    ], 1);

    expect(preview).toEqual({
      sessionIds: ['s1', 's2'],
      sessionCount: 2,
      inflightCount: 1,
    });
    expect(describeScheduleDeletePreview(preview)).toBe('找到 2 个由它生成的任务，还有 1 次执行正在进行');
  });

  it('maps deletion dispositions to desktop-compatible session patches', () => {
    expect(buildGeneratedSessionDispositionPatch('keep')).toBeNull();
    expect(buildGeneratedSessionDispositionPatch('archive')).toEqual({
      status: 'archived',
      pinnedAt: null,
    });
    expect(buildGeneratedSessionDispositionPatch('delete')).toEqual({
      status: 'deleted',
    });
  });

  it('detects project automation schedules only when the config id is available', () => {
    expect(isProjectAutomationSchedule(buildScheduleDeleteTarget(schedule({
      source: 'project',
      workingDir: '/repo',
      projectConfigId: 'daily',
    })))).toBe(true);
    expect(isProjectAutomationSchedule(buildScheduleDeleteTarget(schedule({
      source: 'project',
      workingDir: '/repo',
    })))).toBe(false);
  });
});
