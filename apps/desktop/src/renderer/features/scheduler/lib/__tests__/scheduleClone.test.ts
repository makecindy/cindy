import { describe, expect, it } from 'vitest';
import type { Schedule } from '@cindy/maker-scheduler';

import { scheduleToUserCreateInput } from '../scheduleClone';

describe('scheduleToUserCreateInput', () => {
  it('preserves the new-session title template when cloning or demoting a schedule', () => {
    const input = scheduleToUserCreateInput({
      id: 'schedule-1',
      name: 'Weekly review',
      prompt: 'Review the project',
      kind: 'cron',
      cronExpr: '0 9 * * 1',
      sessionTitleTemplate: '{isoWeek} {scheduleName}',
    } as Schedule);

    expect(input.sessionTitleTemplate).toBe('{isoWeek} {scheduleName}');
  });
});
