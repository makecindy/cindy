import { claudeAccountUsageLimit } from '../accountUsageLimit';
import { describe, expect, it } from 'vitest';
import { parseClaudeSdkRateLimitInfo, mergeClaudeSubscriptionUsageSnapshot as merge, type ClaudeSubscriptionUsageSnapshot } from '../claudeSubscriptionUsage';
import { mergeClaudeSubscriptionUsageDuringRead } from '../claudeSubscriptionUsage';

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
    expect(updated.sevenDay).toMatchObject({ utilization: 76, resetsAt: reset, severity: 'warning' });
    expect(updated.fiveHour).toMatchObject(endpoint.fiveHour!);
    expect(updated.scoped).toEqual(endpoint.scoped);
    const recovered = merge(updated, { ...endpoint, updatedAt: now + 2000, sevenDay: { utilization: 20, resetsAt: reset, severity: 'normal' } });
    expect(recovered.sevenDay?.severity).toBe('normal');
    expect(recovered.rateLimitStatus).toBeUndefined();
  });

  it('does not carry severity to a new window or a different account', () => {
    expect(merge(endpoint, { ...headers, sevenDay: { utilization: 0, resetsAt: reset + 604800 } }).sevenDay?.severity).toBeUndefined();
    expect(merge(endpoint, { ...headers, accountFingerprint: 'account-b' })).toEqual({ ...headers, accountFingerprint: 'account-b' });
  });

  it('drops expired severity even if the new response omits its reset time', () => {
    const partial = merge(endpoint, { ...headers, sevenDay: { utilization: 77 } });
    expect(partial.sevenDay).toMatchObject({ utilization: 76, resetsAt: reset, severity: 'warning' });
    expect(merge(partial, { ...headers, updatedAt: reset * 1000, sevenDay: { utilization: 0 } }).sevenDay?.severity).toBeUndefined();
  });

  it('accepts explicit severity and applies the same merge to the five-hour window', () => {
    const previous = { ...endpoint, fiveHour: { utilization: 80, resetsAt: reset, severity: 'warning' } };
    const update = { ...headers, fiveHour: { utilization: 81, resetsAt: reset } };
    expect(merge(previous, update).fiveHour?.severity).toBe('warning');
    expect(merge(previous, { ...update, fiveHour: { ...update.fiveHour, severity: 'normal' } }).fiveHour?.severity).toBe('normal');
  });
});

// User-reported percentage oscillation / unit. Existing tests cover severity,
// not repeated competing sources within one live quota window.
describe('Claude quota percentage authority', () => {
  it('keeps endpoint percentages across higher/lower SDK events and accepts endpoint corrections', () => {
    let view = endpoint;
    for (const utilization of [0.70, 0.80, 0.70]) {
      view = merge(view, parseClaudeSdkRateLimitInfo({
        rateLimitType: 'seven_day', utilization, resetsAt: reset, status: 'rejected',
      }, now + 1000)!);
      expect(view.sevenDay?.utilization).toBe(76);
      expect(view.rateLimitStatus).toBe('rejected');
      expect(claudeAccountUsageLimit(view, 'claude-sonnet', now)?.limited).toBe(true);
    }
    view = merge(view, { ...endpoint, updatedAt: now + 2000, sevenDay: { utilization: 74, resetsAt: reset } });
    expect(view.sevenDay?.utilization).toBe(74);
    expect(merge(view, { ...headers, updatedAt: now + 3000 }).sevenDay?.utilization).toBe(74);
  });

  it('tracks authority separately when only one window resets', () => {
    const nextReset = reset + 18000;
    let view = merge(endpoint, { ...headers, fiveHour: { utilization: 1, resetsAt: nextReset } });
    view = merge(view, { ...headers, fiveHour: { utilization: 2, resetsAt: nextReset } });
    expect(view.fiveHour?.utilization).toBe(2);
    expect(view.sevenDay?.utilization).toBe(76);
  });

  it('does not roll a newer observation back to an older timestamp', () => {
    expect(merge(headers, { ...endpoint, updatedAt: now - 1 })).toEqual(headers);
  });

  // #9951 P2 / unit: overlapping endpoint reads must retain fresh full data,
  // applying only concurrent event windows/status without reviving old windows.
  it('merges concurrent headers without carrying old windows or another account into a read', () => {
    const latest = merge(endpoint, { ...headers, rateLimitStatus: 'rejected', representativeClaim: 'seven_day' });
    const read = { ...endpoint, updatedAt: now + 2000,
      sevenDay: { utilization: 80, resetsAt: reset + 604800, severity: 'normal' } };
    const result = mergeClaudeSubscriptionUsageDuringRead(endpoint, read, latest);
    expect(result.sevenDay).toMatchObject(read.sevenDay);
    expect(result.rateLimitStatus).toBeUndefined();
    expect(result.scoped).toEqual(read.scoped);
    expect(mergeClaudeSubscriptionUsageDuringRead(endpoint,
      { ...endpoint, sevenDay: { ...endpoint.sevenDay!, severity: 'normal' } }, latest).sevenDay?.severity).toBe('normal');
    expect(mergeClaudeSubscriptionUsageDuringRead(endpoint, { ...read, accountFingerprint: 'new-account' }, latest))
      .toEqual({ ...read, accountFingerprint: 'new-account' });
    const next = { ...headers, sevenDay: { utilization: 1, resetsAt: reset + 604800 } };
    expect(mergeClaudeSubscriptionUsageDuringRead(endpoint, endpoint, next).sevenDay?.utilization).toBe(1);
  });
});

// #9995 / unit: new statuses must not inherit another event's claim. Previous
// merge coverage did not exercise status-only updates after a shared-window event.
describe('Claude rejection claim belongs to its status event', () => {
  it.each([null, undefined])('clears a stale claim on a new status with claim=%s', (claim) => {
    const previous = merge(endpoint, { ...headers, representativeClaim: 'five_hour' });
    const rejected = merge(previous, { source: 'unified-headers', updatedAt: now + 2000,
      rateLimitStatus: 'rejected', representativeClaim: claim });
    expect(claudeAccountUsageLimit(rejected, 'claude-opus', now)?.limited).toBe(false);
    expect(rejected.representativeClaim).toBeNull();
    // A usage-only update still preserves the status and its actual claim.
    const shared = merge(previous, { ...headers, rateLimitStatus: 'rejected', representativeClaim: 'seven_day' });
    const partial = merge(shared, { source: 'unified-headers', fiveHour: { utilization: 26 } });
    expect(claudeAccountUsageLimit(partial, 'claude-opus', now)?.limited).toBe(true);
    expect(partial.representativeClaim).toBe('seven_day');
  });
});
