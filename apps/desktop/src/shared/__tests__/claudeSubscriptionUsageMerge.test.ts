import { describe, expect, it } from 'vitest';
import { mergeClaudeSubscriptionUsageSnapshot as merge, type ClaudeSubscriptionUsageSnapshot } from '../claudeSubscriptionUsage';

const now = 1_800_000_000_000;
const reset = now / 1000 + 3600;
const endpoint: ClaudeSubscriptionUsageSnapshot = {
  source: 'oauth-endpoint', updatedAt: now, accountFingerprint: 'account-a',
  fiveHour: { utilization: 25, resetsAt: reset, severity: 'normal' },
  sevenDay: { utilization: 76, resetsAt: reset, severity: 'warning' },
  scoped: [{ modelDisplayName: 'Fable', utilization: 10, resetsAt: reset, severity: 'normal' }],
};
const headers: ClaudeSubscriptionUsageSnapshot = {
  source: 'unified-headers', updatedAt: now + 1000, accountFingerprint: 'account-a',
  sevenDay: { utilization: 77, resetsAt: reset }, rateLimitStatus: 'allowed_warning',
};

describe('Claude quota updates preserve valid window severity', () => {
  it('keeps endpoint-only severity through partial headers, then accepts full recovery', () => {
    const updated = merge(endpoint, headers);
    expect(updated.sevenDay).toEqual({ utilization: 77, resetsAt: reset, severity: 'warning' });
    expect(updated.fiveHour).toEqual(endpoint.fiveHour);
    expect(updated.scoped).toEqual(endpoint.scoped);
    const recovered = merge(updated, { ...endpoint, sevenDay: { utilization: 20, resetsAt: reset, severity: 'normal' } });
    expect(recovered.sevenDay?.severity).toBe('normal');
    expect(recovered.rateLimitStatus).toBeUndefined();
  });

  it('does not carry severity to a new window or a different account', () => {
    expect(merge(endpoint, { ...headers, sevenDay: { utilization: 0, resetsAt: reset + 604800 } }).sevenDay?.severity).toBeUndefined();
    expect(merge(endpoint, { ...headers, accountFingerprint: 'account-b' })).toEqual({ ...headers, accountFingerprint: 'account-b' });
  });

  it('drops expired severity even if the new response omits its reset time', () => {
    const partial = merge(endpoint, { ...headers, sevenDay: { utilization: 77 } });
    expect(partial.sevenDay).toEqual({ utilization: 77, resetsAt: reset, severity: 'warning' });
    expect(merge(partial, { ...headers, updatedAt: reset * 1000, sevenDay: { utilization: 0 } }).sevenDay?.severity).toBeUndefined();
  });

  it('accepts explicit severity and applies the same merge to the five-hour window', () => {
    const previous = { ...endpoint, fiveHour: { utilization: 80, resetsAt: reset, severity: 'warning' } };
    const update = { ...headers, fiveHour: { utilization: 81, resetsAt: reset } };
    expect(merge(previous, update).fiveHour?.severity).toBe('warning');
    expect(merge(previous, { ...update, fiveHour: { ...update.fiveHour, severity: 'normal' } }).fiveHour?.severity).toBe('normal');
  });
});
