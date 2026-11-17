import { describe, expect, it } from 'vitest';
import { providerGroupCodexUsageSnapshot, providerGroupMemberQuotaWindows } from '../../provider-group/usage.js';
import { subscriptionWindowRoom } from '../scheduler.js';

// Unit / opt-in recovery contract: all model windows must leave room for a real turn.
// Unlike the retired parallel new-assignment picker, this cannot change normal pool strategy.
// The full failure → recovery → accepted-send chain is covered by runtime.test.ts.
const NOW = Date.parse('2026-11-14T10:00:00Z');
const HOUR = 3_600_000;
function windows(short: number, week: number, reset = NOW + HOUR) {
  const codexUsage = providerGroupCodexUsageSnapshot({ nativeAccountPool: true, appServerBuckets: { codex: {
    updatedAt: NOW, primary: { usedPercent: short, windowMinutes: 300, resetsAt: reset / 1000 },
    secondary: { usedPercent: week, windowMinutes: 10080, resetsAt: (NOW + 24 * HOUR) / 1000 },
  } } })!;
  return providerGroupMemberQuotaWindows({ codexUsage }, 'gpt-6', NOW, 'codex');
}

describe('recovered account safe window eligibility', () => {
  it.each([
    [84, 94, true], [85, 0, false], [0, 95, false], [0, 100, false],
  ] as const)('requires room in both short=%s and week=%s windows', (short, week, expected) => {
    expect(subscriptionWindowRoom(windows(short, week))).toBe(expected);
  });
  it('does not turn an unknown or unrefreshed reset window into recovered capacity', () => {
    expect(subscriptionWindowRoom(null)).toBe(false);
    expect(subscriptionWindowRoom([])).toBe(false);
    expect(subscriptionWindowRoom(windows(0, 0, NOW - 1))).toBe(false);
  });
});
