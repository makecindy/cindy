// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { clearLegacyBillingIntentStorage, newBillingIdempotencyKey } from '../checkoutIntent';

const ACCOUNT_A = 'account-a';
const ACCOUNT_B = 'account-b';

describe('billing checkout intent hygiene', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('creates a fresh namespaced idempotency key per user action', () => {
    vi.stubGlobal('crypto', { randomUUID: () => '00000000-0000-4000-8000-000000000001' });
    expect(newBillingIdempotencyKey('subscription')).toBe(
      'desktop:subscription:00000000-0000-4000-8000-000000000001',
    );
    vi.unstubAllGlobals();
  });

  it('removes every legacy persisted intent for the active account', () => {
    localStorage.setItem('cindy.billing.checkout-intent.v1', JSON.stringify({ version: 1 }));
    localStorage.setItem(
      `cindy.billing.checkout-intent.v2:${encodeURIComponent(ACCOUNT_A)}`,
      JSON.stringify({ version: 1, kind: 'TOPUP' }),
    );
    localStorage.setItem(
      `cindy.billing.plan-change-intent.v1:${encodeURIComponent(ACCOUNT_A)}`,
      JSON.stringify({ version: 1 }),
    );
    const otherKey = `cindy.billing.checkout-intent.v2:${encodeURIComponent(ACCOUNT_B)}`;
    localStorage.setItem(otherKey, JSON.stringify({ version: 1, kind: 'TOPUP' }));

    clearLegacyBillingIntentStorage(ACCOUNT_A);

    expect(localStorage.getItem('cindy.billing.checkout-intent.v1')).toBeNull();
    expect(
      localStorage.getItem(`cindy.billing.checkout-intent.v2:${encodeURIComponent(ACCOUNT_A)}`),
    ).toBeNull();
    expect(
      localStorage.getItem(`cindy.billing.plan-change-intent.v1:${encodeURIComponent(ACCOUNT_A)}`),
    ).toBeNull();
    // 其他账号的残留由其自身会话启动时清理。
    expect(localStorage.getItem(otherKey)).not.toBeNull();
  });

  it('still removes the unscoped legacy key when no account is active', () => {
    localStorage.setItem('cindy.billing.checkout-intent.v1', JSON.stringify({ version: 1 }));
    clearLegacyBillingIntentStorage(null);
    expect(localStorage.getItem('cindy.billing.checkout-intent.v1')).toBeNull();
  });
});
