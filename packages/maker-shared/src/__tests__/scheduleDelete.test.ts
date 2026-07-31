import { describe, expect, it } from 'vitest';
import {
  buildGeneratedSessionDispositionPatch,
  buildScheduleDeletePreview,
  buildScheduleDeleteTarget,
  collectGeneratedSessionIds,
  describeScheduleDeletePreview,
  isProjectAutomationSchedule,
} from '../scheduleDelete.js';
import type { RemoteSchedule, RemoteScheduleRun } from '../scheduleTypes.js';

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

  it('buildScheduleDeletePreview excludes the hand-bound targetSessionId from the mobile preview', () => {
    // mobile 删除确认(runDeleteSchedule)用 preview.sessionIds 批量 patchSessionMeta 改状态,
    // 手绑的用户既有会话(schedule.targetSessionId)必须从预览里排除,否则会被误软删
    // (apps/mobile/app/automations/[deviceId].tsx 透传 schedule.targetSessionId 作 excludeSessionId)。
    const boundId = 'user-session-bound';
    const preview = buildScheduleDeletePreview([
      run({ id: 'r1', sessionId: boundId }),
      run({ id: 'r2', sessionId: 'gen-1' }),
    ], 0, [], boundId);

    expect(preview.sessionIds).not.toContain(boundId);
    expect(preview.sessionIds).toEqual(['gen-1']);
    expect(preview.sessionCount).toBe(1);
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

describe('hand-bound targetSessionId exclusion', () => {
  // Bug 复现:手绑任务(runner.ts 把 schedule.targetSessionId 当每轮 run 的 sessionId
  // 落进 schedule_runs)删除时,收集"本任务生成的会话"必须排除这个手绑的用户既有会话,
  // 否则 applyGeneratedSessionDisposition 会把它 status='deleted' 软删。
  // 硬不变量:删除 schedule 时绝不能软删/归档一个不是本任务生成的会话。
  const boundId = 'user-session-bound';

  it('excludes the bound targetSessionId even when it appears in run history', () => {
    // run 历史里 sessionId===boundId(心跳 run 沿用用户既有会话)+ knownSessionIds 也含它
    const runs = [
      run({ id: 'r1', sessionId: boundId }),
      run({ id: 'r2', sessionId: 'gen-1' }),
      run({ id: 'r3', sessionId: undefined }),
    ];
    const known = ['gen-2', boundId];

    const result = collectGeneratedSessionIds(runs, known, boundId);

    expect(result).not.toContain(boundId);
    expect(result).toEqual(expect.arrayContaining(['gen-1', 'gen-2']));
    expect(result).toHaveLength(2);
  });

  it('buildScheduleDeletePreview excludes the bound session from count and copy', () => {
    const preview = buildScheduleDeletePreview([
      run({ id: 'r1', sessionId: boundId }),
      run({ id: 'r2', sessionId: 'gen-1' }),
    ], 0, ['gen-2', boundId], boundId);

    expect(preview.sessionIds).not.toContain(boundId);
    expect(preview.sessionCount).toBe(2);
    expect(describeScheduleDeletePreview(preview)).toBe('找到 2 个由它生成的任务');
  });

  it('keeps all generated sessions when no bound id is given (backward compat)', () => {
    const runs = [
      run({ id: 'r1', sessionId: 'gen-1' }),
      run({ id: 'r2', sessionId: 'gen-2' }),
    ];
    const result = collectGeneratedSessionIds(runs, ['gen-3']);
    expect(result).toEqual(expect.arrayContaining(['gen-1', 'gen-2', 'gen-3']));
    expect(result).toHaveLength(3);
  });
});
