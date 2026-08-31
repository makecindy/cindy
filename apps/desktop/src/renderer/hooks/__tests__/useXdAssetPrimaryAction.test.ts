// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { BillingCatalog, BillingSubscription } from '../../../shared/billing';

const mocks = vi.hoisted(() => ({
  getCurrentSubscription: vi.fn(),
  getCatalog: vi.fn(),
  auth: {
    dataOwnerId: 'acc-1' as string | null,
    mode: 'cloud' as const,
    user: { membershipKind: 'personal' as const },
  },
}));

vi.mock('../../features/billing/api', () => ({
  billingApi: {
    getCurrentSubscription: mocks.getCurrentSubscription,
    getCatalog: mocks.getCatalog,
  },
}));

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => mocks.auth,
}));

import { useXdAssetPrimaryAction } from '../useXdAssetPrimaryAction';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

const plusMonth: BillingSubscription = {
  subscriptionId: 'sub_1',
  status: 'ACTIVE',
  provider: 'stripe',
  currentPeriodStartAt: null,
  currentPeriodEndAt: null,
  entitlementValidUntil: null,
  cancelAtPeriodEnd: false,
  effectivePlan: {
    version: 1,
    product: { code: 'plus', kind: 'SUBSCRIPTION', level: 1 },
    offer: { code: 'plus_month', interval: 'MONTH' },
    terms: { amount: '9', currency: 'usd', creditAmount: '100', rolloverCap: '0' },
    capturedAt: '2026-01-01T00:00:00.000Z',
  },
  purchaseAttemptId: null,
  paymentAction: null,
};

const plusAndMaxCatalog: BillingCatalog = {
  products: [
    {
      code: 'plus',
      name: 'Plus',
      kind: 'SUBSCRIPTION',
      level: 1,
      sortOrder: 1,
      offers: [
        {
          code: 'plus_month',
          interval: 'MONTH',
          currency: 'usd',
          amount: '9',
          minAmount: null,
          maxAmount: null,
          creditAmount: '100',
          rolloverCap: '0',
          purchaseOptions: [
            {
              id: 'listing_plus_month',
              provider: 'stripe',
              capability: 'PROVIDER_MANAGED_SUBSCRIPTION',
              paymentAction: 'REDIRECT',
            },
          ],
        },
      ],
    },
    {
      code: 'max',
      name: 'Max',
      kind: 'SUBSCRIPTION',
      level: 2,
      sortOrder: 2,
      offers: [
        {
          code: 'max_month',
          interval: 'MONTH',
          currency: 'usd',
          amount: '20',
          minAmount: null,
          maxAmount: null,
          creditAmount: '250',
          rolloverCap: '0',
          purchaseOptions: [
            {
              id: 'listing_max_month',
              provider: 'stripe',
              capability: 'PROVIDER_MANAGED_SUBSCRIPTION',
              paymentAction: 'REDIRECT',
            },
          ],
        },
      ],
    },
  ],
};

describe('useXdAssetPrimaryAction', () => {
  beforeEach(() => {
    mocks.auth.dataOwnerId = 'acc-1';
    mocks.auth.mode = 'cloud';
    mocks.auth.user = { membershipKind: 'personal' };
    mocks.getCurrentSubscription.mockReset();
    mocks.getCatalog.mockReset();
  });

  it('卸载后再挂载不会画出上一套套餐的 CTA', async () => {
    mocks.getCurrentSubscription.mockResolvedValue({ subscription: null });
    mocks.getCatalog.mockResolvedValue(plusAndMaxCatalog);

    const first = renderHook(() => useXdAssetPrimaryAction(true));
    await waitFor(() => expect(first.result.current).toBe('buy-plan'));
    first.unmount();

    const subscription = deferred<{ subscription: BillingSubscription | null }>();
    const catalog = deferred<BillingCatalog>();
    mocks.getCurrentSubscription.mockReturnValue(subscription.promise);
    mocks.getCatalog.mockReturnValue(catalog.promise);

    const second = renderHook(() => useXdAssetPrimaryAction(true));
    expect(second.result.current).toBeNull();

    await act(async () => {
      subscription.resolve({ subscription: plusMonth });
      catalog.resolve(plusAndMaxCatalog);
    });
    await waitFor(() => expect(second.result.current).toBe('upgrade-plan'));
  });
});
