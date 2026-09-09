import { describe, expect, it } from 'vitest';

import { canAccessUsageSettings } from '../usageVisibility';
import { canAccessBillingSettings } from '../billingVisibility';

describe('usageVisibility', () => {
  it('allows every signed-in identity, unlike billing', () => {
    expect(canAccessUsageSettings({ mode: 'local' })).toBe(true);
    expect(canAccessUsageSettings({ mode: 'cloud' })).toBe(true);
    expect(canAccessUsageSettings({ mode: 'signed-out' })).toBe(false);
  });

  it('does not inherit the billing tab identity gate', () => {
    // cloud + org 看不到计费页, 但必须能看到用量历史 —— 它读的是本机用量, 与账单无关。
    expect(canAccessBillingSettings({ mode: 'cloud', membershipKind: 'org' })).toBe(false);
    expect(canAccessUsageSettings({ mode: 'cloud' })).toBe(true);

    // local 同理。
    expect(canAccessBillingSettings({ mode: 'local', membershipKind: null })).toBe(false);
    expect(canAccessUsageSettings({ mode: 'local' })).toBe(true);
  });
});
