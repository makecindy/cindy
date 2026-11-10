/**
 * Schedule -> form 回填回归：相对间隔是调度引擎的权威模式，不能被陈旧 cronExpr 覆盖。
 *
 * @vitest-environment jsdom
 */

import { describe, expect, it, vi } from 'vitest';
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
  // System-timezone regression / unit: module-load defaults stayed in Shanghai;
  // new forms must read the current zone while existing schedules keep theirs.
  it('refreshes the system timezone on creation without changing an edited schedule', () => {
    const options = Intl.DateTimeFormat().resolvedOptions();
    const zone = vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions');
    try {
      zone.mockReturnValue({ ...options, timeZone: 'America/New_York' });
      expect(makeFormFromSchedule(null).timezone).toBe('America/New_York');
      zone.mockReturnValue({ ...options, timeZone: 'Europe/Berlin' });
      expect(makeFormFromSchedule(null).timezone).toBe('Europe/Berlin');
      expect(makeFormFromSchedule(makeSchedule()).timezone).toBe('Asia/Shanghai');
    } finally {
      zone.mockRestore();
    }
  });

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
});
