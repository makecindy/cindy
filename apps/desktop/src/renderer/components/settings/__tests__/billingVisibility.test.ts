import { describe, expect, it } from 'vitest';

import { canAccessBillingSettings, type BillingSettingsIdentity } from '../billingVisibility';

function identity(overrides: Partial<BillingSettingsIdentity> = {}): BillingSettingsIdentity {
  return { mode: 'cloud', membershipKind: 'personal', ...overrides };
}

describe('billingVisibility', () => {
  it('allows only personal cloud accounts', () => {
    expect(canAccessBillingSettings(identity())).toBe(true);
    expect(canAccessBillingSettings(identity({ membershipKind: 'org' }))).toBe(false);
    expect(canAccessBillingSettings(identity({ mode: 'local', membershipKind: null }))).toBe(false);
    expect(canAccessBillingSettings(identity({ mode: 'signed-out', membershipKind: null }))).toBe(
      false,
    );
  });
});
