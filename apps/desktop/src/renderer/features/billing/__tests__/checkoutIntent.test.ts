// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  billingCheckoutIntentKey,
  clearBillingCheckoutIntent,
  newBillingIdempotencyKey,
  readBillingCheckoutIntent,
  writeBillingCheckoutIntent,
} from '../checkoutIntent';

const ACCOUNT_A = 'account-a';
const ACCOUNT_B = 'account-b';

describe('billing checkout intent', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('round-trips a valid top-up intent', () => {
    const intent = {
      version: 1 as const,
      kind: 'TOPUP' as const,
      idempotencyKey: 'desktop:topup:fixture-0001',
      request: {
        offerCode: 'credit_topup_custom',
        amount: '20.00',
        purchaseOptionId: 'listing_alipay',
      },
      orderId: null,
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    writeBillingCheckoutIntent(ACCOUNT_A, intent);
    expect(readBillingCheckoutIntent(ACCOUNT_A)).toEqual(intent);
    clearBillingCheckoutIntent(ACCOUNT_A);
    expect(readBillingCheckoutIntent(ACCOUNT_A)).toBeNull();
  });

  it('removes malformed or future-version storage', () => {
    localStorage.setItem(
      billingCheckoutIntentKey(ACCOUNT_A),
      JSON.stringify({ version: 2, kind: 'TOPUP' }),
    );
    expect(readBillingCheckoutIntent(ACCOUNT_A)).toBeNull();
    expect(localStorage.getItem(billingCheckoutIntentKey(ACCOUNT_A))).toBeNull();
  });

  it('removes intents containing undeclared response or payment fields', () => {
    localStorage.setItem(
      billingCheckoutIntentKey(ACCOUNT_A),
      JSON.stringify({
        version: 1,
        kind: 'TOPUP_RETRY',
        idempotencyKey: 'desktop:retry:fixture-0001',
        orderId: 'order_fixture',
        createdAt: '2026-01-01T00:00:00.000Z',
        paymentUrl: 'https://pay.example.test/should-not-persist',
      }),
    );
    expect(readBillingCheckoutIntent(ACCOUNT_A)).toBeNull();
    expect(localStorage.getItem(billingCheckoutIntentKey(ACCOUNT_A))).toBeNull();
  });

  it('creates a fresh namespaced idempotency key per user action', () => {
    vi.stubGlobal('crypto', { randomUUID: () => '00000000-0000-4000-8000-000000000001' });
    expect(newBillingIdempotencyKey('subscription')).toBe(
      'desktop:subscription:00000000-0000-4000-8000-000000000001',
    );
    vi.unstubAllGlobals();
  });

  it('round-trips a retry intent without storing catalog or provider data', () => {
    const intent = {
      version: 1 as const,
      kind: 'TOPUP_RETRY' as const,
      idempotencyKey: 'desktop:retry:fixture-0001',
      orderId: 'order_fixture',
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    writeBillingCheckoutIntent(ACCOUNT_A, intent);
    expect(readBillingCheckoutIntent(ACCOUNT_A)).toEqual(intent);
  });

  it('keeps checkout recovery isolated between accounts', () => {
    const intent = {
      version: 1 as const,
      kind: 'TOPUP_RETRY' as const,
      idempotencyKey: 'desktop:retry:fixture-0001',
      orderId: 'order_fixture',
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    writeBillingCheckoutIntent(ACCOUNT_A, intent);

    expect(readBillingCheckoutIntent(ACCOUNT_B)).toBeNull();
    expect(readBillingCheckoutIntent(ACCOUNT_A)).toEqual(intent);
  });

  it('drops legacy unscoped recovery instead of assigning it to the active account', () => {
    localStorage.setItem(
      'cindy.billing.checkout-intent.v1',
      JSON.stringify({
        version: 1,
        kind: 'TOPUP_RETRY',
        idempotencyKey: 'desktop:retry:fixture-0001',
        orderId: 'order_fixture',
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
    );

    expect(readBillingCheckoutIntent(ACCOUNT_A)).toBeNull();
    expect(localStorage.getItem('cindy.billing.checkout-intent.v1')).toBeNull();
  });
});
