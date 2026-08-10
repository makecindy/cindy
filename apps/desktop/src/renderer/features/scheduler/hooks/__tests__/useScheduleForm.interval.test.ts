/**
 * Schedule -> form 回填回归：相对间隔是调度引擎的权威模式，不能被陈旧 cronExpr 覆盖。
 *
 * @vitest-environment jsdom
 */

import { describe, expect, it } from 'vitest';
import type { Schedule } from '@cindy/maker-scheduler';

import { makeFormFromSchedule } from '../useScheduleForm';

function makeSchedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: 'schedule-1',
    name: 'Every ten minutes',
    prompt: 'run',
    kind: 'cron',
    cronExpr: '*/5 * * * *',
    intervalMs: 10 * 60_000,
    timezone: 'Asia/Shanghai',
    recurring: true,
    manual: false,
    agentKind: 'claude-code',
    workspaceKind: 'dialogue',
    useWorktree: false,
    persistentSession: false,
    silentWhenIdle: false,
    notify: { desktop: true, feishu: false },
    status: 'active',
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

describe('makeFormFromSchedule interval mode', () => {
  it('retains intervalMs when it disagrees with cronExpr', () => {
    const form = makeFormFromSchedule(makeSchedule());

    expect(form.cronExpr).toBe('*/5 * * * *');
    expect(form.intervalMs).toBe(10 * 60_000);
  });

  it('keeps pure cron schedules in cron mode', () => {
    const form = makeFormFromSchedule(makeSchedule({ intervalMs: undefined }));

    expect(form.cronExpr).toBe('*/5 * * * *');
    expect(form.intervalMs).toBeUndefined();
  });

  it('backfills the saved new-session title template into the hidden advanced field', () => {
    expect(
      makeFormFromSchedule(makeSchedule({ sessionTitleTemplate: '{isoWeek} review' }))
        .sessionTitleTemplate,
    ).toBe('{isoWeek} review');
    expect(makeFormFromSchedule(makeSchedule()).sessionTitleTemplate).toBe('');
  });
});
