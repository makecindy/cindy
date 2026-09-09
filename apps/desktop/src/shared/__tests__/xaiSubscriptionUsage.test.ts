import { describe, expect, it } from 'vitest';

import {
  buildXaiSubscriptionUsageSnapshot,
  formatXaiProductLabel,
  inferXaiWeeklyUsagePercent,
  isXaiSubscriptionAlerting,
  isXaiWeeklyUsageCurrent,
  parseXaiBillingCreditsConfig,
  parseXaiSettingsPlanLabel,
} from '../xaiSubscriptionUsage';

const CREDITS_FIXTURE = {
  config: {
    currentPeriod: {
      type: 'USAGE_PERIOD_TYPE_WEEKLY',
      start: '2026-08-11T09:53:45.527500+00:00',
      end: '2026-08-18T09:53:45.527500+00:00',
    },
    creditUsagePercent: 2,
    onDemandCap: { val: 0 },
    onDemandUsed: { val: 0 },
    productUsage: [{ product: 'GrokBuild', usagePercent: 2 }],
    isUnifiedBillingUser: true,
    prepaidBalance: { val: 0 },
    billingPeriodEnd: '2026-08-18T09:53:45.527500+00:00',
  },
};

describe('parseXaiSettingsPlanLabel', () => {
  it('reads subscription_tier_display', () => {
    expect(parseXaiSettingsPlanLabel({ subscription_tier_display: 'SuperGrok Heavy' }))
      .toBe('SuperGrok Heavy');
  });

  it('returns null for missing or empty labels', () => {
    expect(parseXaiSettingsPlanLabel({})).toBeNull();
    expect(parseXaiSettingsPlanLabel({ subscription_tier_display: '  ' })).toBeNull();
    expect(parseXaiSettingsPlanLabel(null)).toBeNull();
  });
});

describe('parseXaiBillingCreditsConfig', () => {
  it('reads the grok.com weekly included pool fields', () => {
    const parsed = parseXaiBillingCreditsConfig(CREDITS_FIXTURE);
    expect(parsed).toEqual({
      creditUsagePercent: 2,
      resetsAt: Math.floor(Date.parse('2026-08-18T09:53:45.527500+00:00') / 1000),
      productUsage: [{ product: 'GrokBuild', usagePercent: 2 }],
      prepaidBalance: 0,
    });
  });

  it('ignores onDemand counters when computing weekly percent', () => {
    const parsed = parseXaiBillingCreditsConfig({
      config: {
        creditUsagePercent: 40,
        onDemandCap: { val: 0 },
        onDemandUsed: { val: 0 },
      },
    });
    expect(parsed?.creditUsagePercent).toBe(40);
  });

  it('returns null when neither percent nor reset exists', () => {
    expect(parseXaiBillingCreditsConfig({ config: { prepaidBalance: { val: 0 } } })).toBeNull();
    expect(parseXaiBillingCreditsConfig(null)).toBeNull();
  });

  it('treats an omitted percent as 0% while the weekly window is still open', () => {
    const nowMs = Date.parse('2026-08-15T00:00:00.000Z');
    const parsed = parseXaiBillingCreditsConfig({
      config: {
        currentPeriod: {
          type: 'USAGE_PERIOD_TYPE_WEEKLY',
          end: '2026-08-18T09:53:45.527500+00:00',
        },
      },
    }, nowMs);
    expect(parsed?.creditUsagePercent).toBe(0);
    expect(parsed?.resetsAt).toBe(Math.floor(Date.parse('2026-08-18T09:53:45.527500+00:00') / 1000));
  });

  it('does not invent 0% after the weekly window has already ended', () => {
    const nowMs = Date.parse('2026-08-19T00:00:00.000Z');
    const parsed = parseXaiBillingCreditsConfig({
      config: {
        currentPeriod: {
          type: 'USAGE_PERIOD_TYPE_WEEKLY',
          end: '2026-08-18T09:53:45.527500+00:00',
        },
      },
    }, nowMs);
    expect(parsed?.creditUsagePercent).toBeNull();
    expect(inferXaiWeeklyUsagePercent(null, 1_800_000_000, 1_800_000_000 * 1000, true)).toBeNull();
    expect(inferXaiWeeklyUsagePercent(null, 1_800_000_000, 1_800_000_000 * 1000 - 1, true)).toBe(0);
    expect(inferXaiWeeklyUsagePercent(null, 1_800_000_000, 1_800_000_000 * 1000 - 1, false)).toBeNull();
  });

  it('does not invent 0% when creditUsagePercent is present but unparseable', () => {
    const nowMs = Date.parse('2026-08-15T00:00:00.000Z');
    const weekly = {
      type: 'USAGE_PERIOD_TYPE_WEEKLY',
      end: '2026-08-18T09:53:45.527500+00:00',
    };
    expect(parseXaiBillingCreditsConfig({
      config: { currentPeriod: weekly, creditUsagePercent: 'nope' },
    }, nowMs)?.creditUsagePercent).toBeNull();
    expect(parseXaiBillingCreditsConfig({
      config: { currentPeriod: weekly, creditUsagePercent: { val: 2 } },
    }, nowMs)?.creditUsagePercent).toBeNull();
    expect(parseXaiBillingCreditsConfig({
      config: { currentPeriod: weekly, creditUsagePercent: null },
    }, nowMs)?.creditUsagePercent).toBeNull();
  });

  it('does not invent 0% from a future billingPeriodEnd or non-weekly period', () => {
    const nowMs = Date.parse('2026-08-15T00:00:00.000Z');
    expect(parseXaiBillingCreditsConfig({
      config: { billingPeriodEnd: '2026-09-18T00:00:00.000Z' },
    }, nowMs)?.creditUsagePercent).toBeNull();
    expect(parseXaiBillingCreditsConfig({
      config: {
        currentPeriod: {
          type: 'USAGE_PERIOD_TYPE_MONTHLY',
          end: '2026-09-18T00:00:00.000Z',
        },
      },
    }, nowMs)?.creditUsagePercent).toBeNull();
    expect(parseXaiBillingCreditsConfig({
      config: {
        currentPeriod: { end: '2026-09-18T00:00:00.000Z' },
      },
    }, nowMs)?.creditUsagePercent).toBeNull();
  });

  it('skips malformed product rows', () => {
    const parsed = parseXaiBillingCreditsConfig({
      config: {
        creditUsagePercent: 1,
        productUsage: [
          { product: 'GrokBuild', usagePercent: 1 },
          { product: '', usagePercent: 9 },
          { usagePercent: 3 },
          null,
        ],
      },
    });
    expect(parsed?.productUsage).toEqual([{ product: 'GrokBuild', usagePercent: 1 }]);
  });
});

describe('buildXaiSubscriptionUsageSnapshot', () => {
  it('requires at least a plan or a credits window', () => {
    expect(buildXaiSubscriptionUsageSnapshot({ now: 1 })).toBeNull();
    expect(buildXaiSubscriptionUsageSnapshot({
      planLabel: 'SuperGrok Heavy',
      now: 10,
      accountFingerprint: 'abc',
    })).toMatchObject({
      planLabel: 'SuperGrok Heavy',
      source: 'cli-billing',
      updatedAt: 10,
      accountFingerprint: 'abc',
    });
  });
});

describe('formatXaiProductLabel', () => {
  it('splits GrokBuild into Grok Build', () => {
    expect(formatXaiProductLabel('GrokBuild')).toBe('Grok Build');
    expect(formatXaiProductLabel('Grok Build')).toBe('Grok Build');
  });
});

describe('isXaiSubscriptionAlerting', () => {
  it('alerts at 90% used', () => {
    const now = Date.now();
    const fresh = { creditUsagePercent: 89, updatedAt: now, resetsAt: now / 1000 + 3600 };
    expect(isXaiSubscriptionAlerting({ ...fresh, creditUsagePercent: 89 }, now)).toBe(false);
    expect(isXaiSubscriptionAlerting({ ...fresh, creditUsagePercent: 90 }, now)).toBe(true);
    expect(isXaiSubscriptionAlerting(null, now)).toBe(false);
  });
});

describe('isXaiWeeklyUsageCurrent', () => {
  it('hides numbers after TTL or after reset', () => {
    const now = 2_000_000;
    expect(isXaiWeeklyUsageCurrent({
      creditUsagePercent: 2,
      updatedAt: now - 60_000,
      resetsAt: now / 1000 + 3600,
    }, now)).toBe(true);
    expect(isXaiWeeklyUsageCurrent({
      creditUsagePercent: 2,
      updatedAt: now - 31 * 60 * 1000,
      resetsAt: now / 1000 + 3600,
    }, now)).toBe(false);
    expect(isXaiWeeklyUsageCurrent({
      creditUsagePercent: 2,
      updatedAt: now - 1000,
      resetsAt: now / 1000 - 1,
    }, now)).toBe(false);
    expect(isXaiWeeklyUsageCurrent({
      creditUsagePercent: 2,
      resetsAt: now / 1000 + 3600,
    }, now)).toBe(false);
  });
});
