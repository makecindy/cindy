import { describe, expect, it } from 'vitest';

import {
  buildUsageLimitScheduleFormOverrides,
  oneTimeCronAfterUsageReset,
  readUsageLimitScheduleCreateIntent,
  usageLimitScheduleNavigationState,
  type UsageLimitScheduleCreateIntent,
} from '../usageLimitScheduleCreateIntent';

const intent: UsageLimitScheduleCreateIntent = {
  kind: 'usage-limit-recovery',
  requestId: 'request-1',
  sessionId: 'session-1',
  agentKind: 'codex',
  resetAtMs: Date.parse('2026-01-24T10:30:00.000Z'),
};

describe('usage-limit Automation create intent', () => {
  it('formats reset plus one minute as a one-shot cron expression', () => {
    expect(
      oneTimeCronAfterUsageReset(
        Date.parse('2026-01-24T10:30:00.000Z'),
        'UTC',
        Date.parse('2026-01-24T10:00:00.000Z'),
      ),
    ).toBe('31 10 24 1 *');
  });

  it('leaves the schedule blank when no reset time can be identified', () => {
    expect(oneTimeCronAfterUsageReset(null, 'UTC')).toBe('');
    const form = buildUsageLimitScheduleFormOverrides(
      { ...intent, resetAtMs: null },
      { name: 'Continue later', prompt: 'Continue the task.' },
    );
    expect(form).toMatchObject({
      name: 'Continue later',
      prompt: 'Continue the task.',
      cronExpr: '',
      recurring: false,
      targetSessionId: 'session-1',
      agentKind: 'codex',
    });
  });

  it('round-trips a valid navigation intent and rejects malformed state', () => {
    expect(readUsageLimitScheduleCreateIntent(usageLimitScheduleNavigationState(intent))).toEqual(
      intent,
    );
    expect(
      readUsageLimitScheduleCreateIntent({
        scheduleCreateIntent: { ...intent, sessionId: '', resetAtMs: 'tomorrow' },
      }),
    ).toBeNull();
    expect(readUsageLimitScheduleCreateIntent(null)).toBeNull();
  });
});
