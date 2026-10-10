import { describe, expect, it } from 'vitest';
import { mergeClaudeSubscriptionUsageSnapshot, parseClaudeOAuthUsageResponse, parseClaudeSdkRateLimitInfo } from '../claudeSubscriptionUsage';

describe('Claude per-window freshness', () => {
  it('does not freshen weekly and model windows when only the session window changes', () => {
    const original = parseClaudeOAuthUsageResponse({ five_hour: { utilization: 20 }, seven_day: { utilization: 40 }, seven_day_fable: { utilization: 60 } }, 1000)!;
    const update = parseClaudeSdkRateLimitInfo({ rateLimitType: 'five_hour', utilization: 0.3 }, 5000)!;
    const merged = mergeClaudeSubscriptionUsageSnapshot(original, update);
    expect(merged.updatedAt).toBe(5000);
    expect(merged.fiveHour?.observedAt).toBe(5000);
    expect(merged.sevenDay?.observedAt).toBe(1000);
    expect(merged.scoped?.[0].observedAt).toBe(1000);
  });
  it('leaves legacy mixed cache timestamps unknown rather than using the newest event time', () => {
    const merged = mergeClaudeSubscriptionUsageSnapshot({ source: 'unified-headers', updatedAt: 4000, sevenDay: { utilization: 40 } }, parseClaudeSdkRateLimitInfo({ rateLimitType: 'five_hour', utilization: 0.3 }, 5000)!);
    expect(merged.sevenDay?.observedAt).toBeNull();
  });
  it('does not retain another account’s plan or windows', () => {
    const merged = mergeClaudeSubscriptionUsageSnapshot({ accountFingerprint: 'a', subscriptionType: 'max', sevenDay: { utilization: 40, observedAt: 1000 } }, { accountFingerprint: 'b', source: 'unified-headers', fiveHour: { utilization: 30, observedAt: 5000 } });
    expect(merged.sevenDay).toBeUndefined();
    expect(merged.subscriptionType).toBeUndefined();
  });
});
