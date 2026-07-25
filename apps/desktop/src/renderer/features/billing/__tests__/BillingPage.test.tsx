// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BillingPaymentOrder, BillingSubscription } from '../../../../shared/billing';

const i18n = {
  language: 'en',
  resolvedLanguage: 'en' as string | undefined,
};

const checkout = {
  state: {
    open: false,
    kind: null,
    phase: 'IDLE',
    intent: null,
    order: null,
    subscription: null,
    error: false,
  },
  recoverables: {
    topups: [] as BillingPaymentOrder[],
    subscription: null as BillingSubscription | null,
  },
  recovering: false,
  startTopup: vi.fn(),
  startSubscription: vi.fn(),
  refreshActive: vi.fn(),
  retry: vi.fn(),
  cancel: vi.fn(),
  close: vi.fn(),
  resumeTopup: vi.fn(),
  resumeSubscription: vi.fn(),
  resumeFailed: vi.fn(),
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n,
    t: (key: string, params?: Record<string, string>) => {
      const providerLabels: Record<string, string> = {
        'billing.providers.alipay': 'alipay',
        'billing.providers.stripe': 'stripe',
      };
      if (providerLabels[key]) return providerLabels[key];
      return params ? `${key}:${JSON.stringify(params)}` : key;
    },
  }),
}));
vi.mock('@/features/feature-context', () => ({
  useRegisterSidebarUpper: vi.fn(),
  useRegisterContentHeader: vi.fn(),
}));
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ dataOwnerId: 'account-fixture' }),
}));
vi.mock('../useBillingCheckout', () => ({
  useBillingCheckout: () => checkout,
}));
vi.mock('qrcode', () => ({
  toDataURL: vi.fn(async () => 'data:image/png;base64,fixture'),
}));

import { BillingPage } from '../BillingPage';

describe('BillingPage remote catalog rendering', () => {
  beforeEach(() => {
    i18n.language = 'en';
    i18n.resolvedLanguage = 'en';
    Object.assign(checkout.state, {
      open: false,
      kind: null,
      phase: 'IDLE',
      intent: null,
      order: null,
      subscription: null,
      error: false,
    });
    checkout.startTopup.mockClear();
    checkout.startSubscription.mockClear();
    checkout.close.mockClear();
    checkout.resumeTopup.mockClear();
    checkout.resumeSubscription.mockClear();
    checkout.resumeFailed.mockClear();
    checkout.recoverables.topups = [];
    checkout.recoverables.subscription = null;
    checkout.recovering = false;
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        billing: {
          getBalance: vi.fn(async () => ({
            planCredits: '7.000000001',
            purchasedCredits: '5.000000002',
            promotionalCredits: '0.345678898',
            available: '12.345678901',
            scale: 9 as const,
            observedAt: '2026-07-23T12:00:00.000Z',
          })),
          getCatalog: vi.fn(async () => ({
            products: [
              {
                code: 'credit_topup',
                name: 'Configured top-up',
                kind: 'CREDIT_TOPUP',
                level: null,
                sortOrder: 1,
                offers: [
                  {
                    code: 'credit_topup_custom',
                    interval: null,
                    currency: 'cny',
                    amount: null,
                    minAmount: '1',
                    maxAmount: '100',
                    creditAmount: null,
                    rolloverCap: null,
                    purchaseOptions: [
                      {
                        id: 'listing_alipay',
                        provider: 'alipay',
                        capability: 'ONE_TIME_PAYMENT',
                        paymentAction: 'QR_CODE',
                      },
                      {
                        id: 'listing_unknown',
                        provider: 'unknown_provider',
                        capability: 'ONE_TIME_PAYMENT',
                        paymentAction: 'REDIRECT',
                      },
                    ],
                  },
                ],
              },
              {
                code: 'plus',
                name: 'Configured subscription',
                kind: 'SUBSCRIPTION',
                level: 1,
                sortOrder: 2,
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
                        id: 'listing_stripe',
                        provider: 'stripe',
                        capability: 'PROVIDER_MANAGED_SUBSCRIPTION',
                        paymentAction: 'REDIRECT',
                      },
                    ],
                  },
                ],
              },
              {
                code: 'unknown_provider_only',
                name: 'Unknown-provider offer',
                kind: 'CREDIT_TOPUP',
                level: null,
                sortOrder: 3,
                offers: [
                  {
                    code: 'unknown_provider_offer',
                    interval: null,
                    currency: 'cny',
                    amount: '10',
                    minAmount: null,
                    maxAmount: null,
                    creditAmount: '10',
                    rolloverCap: null,
                    purchaseOptions: [
                      {
                        id: 'listing_unknown_only',
                        provider: 'unknown_provider',
                        capability: 'ONE_TIME_PAYMENT',
                        paymentAction: 'REDIRECT',
                      },
                    ],
                  },
                ],
              },
              {
                code: 'coming_soon',
                name: 'Coming soon top-up',
                kind: 'CREDIT_TOPUP',
                level: null,
                sortOrder: 4,
                offers: [
                  {
                    code: 'coming_soon_offer',
                    salesState: 'COMING_SOON',
                    purchasable: false,
                    unavailableReason: 'OFFER_COMING_SOON',
                    interval: null,
                    currency: 'cny',
                    amount: '30',
                    minAmount: null,
                    maxAmount: null,
                    creditAmount: '30',
                    rolloverCap: null,
                    purchaseOptions: [],
                  },
                ],
              },
              {
                code: 'no_available_channel',
                name: 'No-channel top-up',
                kind: 'CREDIT_TOPUP',
                level: null,
                sortOrder: 5,
                offers: [
                  {
                    code: 'no_available_channel_offer',
                    salesState: 'AVAILABLE',
                    purchasable: false,
                    unavailableReason: 'NO_AVAILABLE_PAYMENT_CHANNEL',
                    interval: null,
                    currency: 'cny',
                    amount: '40',
                    minAmount: null,
                    maxAmount: null,
                    creditAmount: '40',
                    rolloverCap: null,
                    purchaseOptions: [],
                  },
                ],
              },
              {
                code: 'hidden',
                name: 'Unconfigured offer',
                kind: 'CREDIT_TOPUP',
                level: null,
                sortOrder: 6,
                offers: [
                  {
                    code: 'hidden_offer',
                    interval: null,
                    currency: 'cny',
                    amount: '10',
                    minAmount: null,
                    maxAmount: null,
                    creditAmount: '10',
                    rolloverCap: null,
                    purchaseOptions: [],
                  },
                ],
              },
              {
                code: 'legacy',
                name: 'Legacy offer without channel projection',
                kind: 'CREDIT_TOPUP',
                level: null,
                sortOrder: 7,
                offers: [
                  {
                    code: 'legacy_offer',
                    interval: null,
                    currency: 'cny',
                    amount: '20',
                    minAmount: null,
                    maxAmount: null,
                    creditAmount: '20',
                    rolloverCap: null,
                  },
                ],
              },
              {
                code: 'unsupported_action',
                name: 'Unsupported payment action',
                kind: 'CREDIT_TOPUP',
                level: null,
                sortOrder: 8,
                offers: [
                  {
                    code: 'unsupported_action_offer',
                    interval: null,
                    currency: 'cny',
                    amount: '10',
                    minAmount: null,
                    maxAmount: null,
                    creditAmount: '10',
                    rolloverCap: null,
                    purchaseOptions: [
                      {
                        id: 'listing_future_action',
                        provider: 'alipay',
                        capability: 'ONE_TIME_PAYMENT',
                        paymentAction: 'FUTURE_ACTION' as never,
                      },
                    ],
                  },
                ],
              },
              {
                code: 'unsupported_capability',
                name: 'Unsupported payment capability',
                kind: 'CREDIT_TOPUP',
                level: null,
                sortOrder: 9,
                offers: [
                  {
                    code: 'unsupported_capability_offer',
                    interval: null,
                    currency: 'cny',
                    amount: '10',
                    minAmount: null,
                    maxAmount: null,
                    creditAmount: '10',
                    rolloverCap: null,
                    purchaseOptions: [
                      {
                        id: 'listing_wrong_capability',
                        provider: 'stripe',
                        capability: 'PROVIDER_MANAGED_SUBSCRIPTION',
                        paymentAction: 'REDIRECT',
                      },
                    ],
                  },
                ],
              },
            ],
          })),
          getCurrentSubscription: vi.fn(async () => ({ subscription: null })),
        },
        openExternal: vi.fn(),
      },
    });
  });

  it('shows the server ledger total and all three balance pools', async () => {
    render(<BillingPage />);

    expect(await screen.findByText('billing.balance.plan')).toBeTruthy();
    expect(screen.getByText('billing.balance.purchased')).toBeTruthy();
    expect(screen.getByText('billing.balance.promotional')).toBeTruthy();
    expect(
      screen.getByText(
        new Intl.NumberFormat('en', { style: 'currency', currency: 'CNY' }).format(12.345678901),
      ),
    ).toBeTruthy();
    expect(screen.getByText('billing.usage.detailsUnavailable')).toBeTruthy();
  });

  it('shows current plan price, included credits, status, and renewal date', async () => {
    i18n.resolvedLanguage = 'ja';
    window.electronAPI.billing.getCurrentSubscription = vi.fn(async () => ({
      subscription: {
        subscriptionId: 'subscription_fixture',
        status: 'ACTIVE' as const,
        currentPeriodStartAt: '2026-07-01T00:00:00.000Z',
        currentPeriodEndAt: '2026-08-01T00:00:00.000Z',
        entitlementValidUntil: '2026-08-02T00:00:00.000Z',
        cancelAtPeriodEnd: false,
        effectivePlan: {
          version: 1 as const,
          product: { code: 'plus', kind: 'SUBSCRIPTION' as const, level: 1 },
          offer: { code: 'plus_month', interval: 'MONTH' as const },
          terms: { amount: '9', currency: 'usd', creditAmount: '100', rolloverCap: '0' },
          capturedAt: '2026-07-01T00:00:00.000Z',
        },
        purchaseAttemptId: null,
        paymentAction: null,
      },
    }));

    render(<BillingPage />);

    expect(await screen.findByText('Configured subscription')).toBeTruthy();
    expect(screen.getByText('billing.subscriptionStatus.ACTIVE')).toBeTruthy();
    expect(
      screen.getByText((text) =>
        text.startsWith('billing.settings.subscriptionCard.priceInterval'),
      ),
    ).toBeTruthy();
    expect(
      screen.getByText((text) =>
        text.startsWith('billing.settings.subscriptionCard.includedCredits'),
      ),
    ).toBeTruthy();
    expect(
      screen.getByText('billing.settings.subscriptionCard.renewsAt:{"date":"2026/08/01"}'),
    ).toBeTruthy();
    expect(screen.getByText('billing.settings.subscriptionCard.changeAction')).toBeTruthy();
  });

  it('preserves the server order for offers within the same product', async () => {
    window.electronAPI.billing.getCatalog = vi.fn(async () => ({
      products: [
        {
          code: 'ordered_topup',
          name: 'Ordered top-up',
          kind: 'CREDIT_TOPUP' as const,
          level: null,
          sortOrder: 1,
          offers: [
            {
              code: 'z_twenty',
              interval: null,
              currency: 'cny',
              amount: '20',
              minAmount: null,
              maxAmount: null,
              creditAmount: '20',
              rolloverCap: null,
              purchaseOptions: [
                {
                  id: 'listing_twenty',
                  provider: 'alipay',
                  capability: 'ONE_TIME_PAYMENT' as const,
                  paymentAction: 'QR_CODE' as const,
                },
              ],
            },
            {
              code: 'a_hundred',
              interval: null,
              currency: 'cny',
              amount: '100',
              minAmount: null,
              maxAmount: null,
              creditAmount: '100',
              rolloverCap: null,
              purchaseOptions: [
                {
                  id: 'listing_hundred',
                  provider: 'alipay',
                  capability: 'ONE_TIME_PAYMENT' as const,
                  paymentAction: 'QR_CODE' as const,
                },
              ],
            },
          ],
        },
      ],
    }));

    render(<BillingPage />);
    fireEvent.click(await screen.findByText('billing.settings.topupCard.action'));

    const offerNames = await screen.findAllByText('Ordered top-up');
    const offerButtons = offerNames.map((name) => name.closest('button')!);
    const twenty = new Intl.NumberFormat('en', {
      style: 'currency',
      currency: 'CNY',
    }).format(20);
    const hundred = new Intl.NumberFormat('en', {
      style: 'currency',
      currency: 'CNY',
    }).format(100);
    expect(offerButtons[0].textContent).toContain(twenty);
    expect(offerButtons[1].textContent).toContain(hundred);
  });

  it('shows an end date for period-end cancellation and omits invalid dates', async () => {
    const subscription = {
      subscriptionId: 'subscription_fixture',
      status: 'ACTIVE' as const,
      currentPeriodStartAt: null,
      currentPeriodEndAt: '2026-08-01T00:00:00.000Z',
      entitlementValidUntil: null,
      cancelAtPeriodEnd: true,
      effectivePlan: null,
      purchaseAttemptId: null,
      paymentAction: null,
    };
    window.electronAPI.billing.getCurrentSubscription = vi
      .fn()
      .mockResolvedValueOnce({ subscription })
      .mockResolvedValueOnce({
        subscription: { ...subscription, currentPeriodEndAt: 'not-a-date' },
      });

    render(<BillingPage />);
    expect(
      await screen.findByText((text) =>
        text.startsWith('billing.settings.subscriptionCard.endsAt'),
      ),
    ).toBeTruthy();

    fireEvent.click(screen.getByText('billing.actions.refreshCatalog'));
    await waitFor(() =>
      expect(
        screen.queryByText((text) => text.startsWith('billing.settings.subscriptionCard.endsAt')),
      ).toBeNull(),
    );
    expect(
      screen.queryByText((text) => text.startsWith('billing.settings.subscriptionCard.renewsAt')),
    ).toBeNull();
  });

  it('places recoverable checkout actions before the balance overview', async () => {
    const order = {
      orderId: 'order_pending',
      productCode: 'credit_topup',
      offerCode: 'credit_topup_custom',
      amount: '10',
      currency: 'cny',
      status: 'PENDING' as const,
      fulfillmentStatus: 'NOT_STARTED' as const,
      paymentAction: null,
      createdAt: '2026-07-24T00:00:00.000Z',
      updatedAt: '2026-07-24T00:00:00.000Z',
    };
    checkout.recoverables.topups = [order];

    render(<BillingPage />);

    const recovery = screen.getByText('billing.recovery.title');
    const balanceTitle = await screen.findByText('billing.balance.title');
    expect(recovery.compareDocumentPosition(balanceTitle) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    fireEvent.click(screen.getByText((text) => text.startsWith('billing.recovery.continueTopup')));
    expect(checkout.resumeTopup).toHaveBeenCalledWith(order);
  });

  it('offers a user-initiated retry entry after background recovery fails', async () => {
    Object.assign(checkout.state, {
      open: false,
      kind: 'TOPUP',
      phase: 'FAILED',
      intent: {
        version: 1,
        kind: 'TOPUP',
        idempotencyKey: 'desktop:topup:uncertain',
        request: {
          offerCode: 'credit_topup_custom',
          amount: '10',
          purchaseOptionId: 'listing_alipay',
        },
        orderId: null,
        createdAt: '2026-07-24T00:00:00.000Z',
      },
      order: null,
      subscription: null,
      error: true,
    });

    render(<BillingPage />);

    const resume = screen.getByText('billing.recovery.continueFailed');
    const balanceTitle = await screen.findByText('billing.balance.title');
    expect(resume.compareDocumentPosition(balanceTitle) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    fireEvent.click(resume);
    expect(checkout.resumeFailed).toHaveBeenCalledTimes(1);
    expect(checkout.retry).not.toHaveBeenCalled();
  });

  it('shows usage progress and each promotional grant with its own state and expiry', async () => {
    window.electronAPI.billing.getCreditUsage = vi.fn(async () => ({
      available: '66',
      plan: { remaining: '40', used: '60', total: '100' },
      purchased: { remaining: '20', used: '30', total: '50' },
      promotional: { remaining: '6', used: '6', total: '12' },
      promotionalGrants: [
        {
          grantId: 'welcome',
          displayName: 'Welcome grant',
          originalAmount: '10',
          usedAmount: '4',
          remainingAmount: '6',
          expiresAt: '2026-08-01T00:00:00Z',
          state: 'active' as const,
        },
        {
          grantId: 'depleted',
          displayName: 'Depleted grant',
          originalAmount: '2',
          usedAmount: '2',
          remainingAmount: '0',
          expiresAt: '2026-08-02T00:00:00Z',
          state: 'depleted' as const,
        },
        {
          grantId: 'expired',
          displayName: null,
          originalAmount: '5',
          usedAmount: '1.25',
          remainingAmount: '0',
          expiresAt: '2026-07-01T00:00:00Z',
          state: 'expired' as const,
        },
        {
          grantId: 'voided',
          displayName: 'Voided grant',
          originalAmount: '3',
          usedAmount: '0.5',
          remainingAmount: '0',
          expiresAt: '2026-08-03T00:00:00Z',
          state: 'voided' as const,
        },
      ],
      promotionalGrantsComplete: true,
      promotionalGrantConsistency: 'OBSERVED' as const,
      ledgerUpdatedAt: '2026-07-23T12:00:00Z',
      scale: 9 as const,
      observedAt: '2026-07-23T12:00:00Z',
    }));

    render(<BillingPage />);

    expect(await screen.findByText('Welcome grant')).toBeTruthy();
    expect(screen.getByText('billing.usage.promotionalDetails.unnamed')).toBeTruthy();
    expect(screen.getByText('billing.usage.promotionalDetails.states.active')).toBeTruthy();
    expect(screen.getByText('billing.usage.promotionalDetails.states.depleted')).toBeTruthy();
    expect(screen.getByText('billing.usage.promotionalDetails.states.expired')).toBeTruthy();
    expect(screen.getByText('billing.usage.promotionalDetails.states.voided')).toBeTruthy();

    const grantRows = within(screen.getByRole('list')).getAllByRole('listitem');
    const formatter = new Intl.NumberFormat('en', { style: 'currency', currency: 'CNY' });
    for (const [row, usedAmount] of [
      [grantRows[0], 4],
      [grantRows[1], 2],
      [grantRows[2], 1.25],
      [grantRows[3], 0.5],
    ] as const) {
      const usedLabel = within(row).getByText('billing.usage.promotionalDetails.used');
      expect(usedLabel.nextElementSibling?.textContent).toBe(formatter.format(usedAmount));
    }
    const legacyWarningKey = `billing.usage.promotionalDetails.${[
      'historical',
      'UsageUnavailable',
    ].join('')}`;
    expect(screen.queryByText(legacyWarningKey)).toBeNull();
    expect(screen.getAllByRole('progressbar')).toHaveLength(3);
    expect(window.electronAPI.billing.getBalance).not.toHaveBeenCalled();
  });

  it('refreshes the balance once and shows no recovery action when a top-up succeeds', async () => {
    const pendingOrder = {
      orderId: 'order_paid',
      productCode: 'credit_topup',
      offerCode: 'credit_topup_custom',
      amount: '10',
      currency: 'cny',
      status: 'PENDING' as const,
      paymentAction: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:01:00.000Z',
    };
    Object.assign(checkout.state, {
      open: true,
      kind: 'TOPUP',
      phase: 'AWAITING_PAYMENT',
      order: pendingOrder,
    });
    const getBalance = window.electronAPI.billing.getBalance;
    const view = render(<BillingPage />);
    await waitFor(() => expect(getBalance).toHaveBeenCalledTimes(1));

    Object.assign(checkout.state, {
      phase: 'COMPLETED',
      order: {
        ...pendingOrder,
        status: 'SUCCEEDED',
        fulfillmentStatus: 'FAILED',
      },
    });
    view.rerender(<BillingPage />);
    await waitFor(() => expect(getBalance).toHaveBeenCalledTimes(2));
    expect(screen.getByText('billing.checkout.completedTitle')).toBeTruthy();
    expect(screen.getByText('billing.checkout.paymentCompleted')).toBeTruthy();
    expect(screen.queryByText('billing.recovery.title')).toBeNull();
    expect(
      screen.queryByText((text) => text.startsWith('billing.recovery.continueTopup')),
    ).toBeNull();

    view.rerender(<BillingPage />);
    expect(getBalance).toHaveBeenCalledTimes(2);
  });

  it('does not show zero or block purchases when balance is not provisioned', async () => {
    window.electronAPI.billing.getBalance = vi.fn(async () => {
      throw Object.assign(new Error('[NOT_FOUND] balance account is not provisioned'), {
        code: 'NOT_FOUND' as const,
      });
    });

    render(<BillingPage />);

    expect(await screen.findByText('billing.balance.notProvisioned')).toBeTruthy();
    expect(
      screen.queryByText(
        new Intl.NumberFormat('en', { style: 'currency', currency: 'CNY' }).format(0),
      ),
    ).toBeNull();
    await waitFor(() =>
      expect(
        screen.getByText('billing.settings.subscriptionCard.action').closest('button'),
      ).toHaveProperty('disabled', false),
    );
    expect(screen.getByText('billing.settings.topupCard.action').closest('button')).toHaveProperty(
      'disabled',
      false,
    );
  });

  it('does not wait for a slow balance response before enabling purchase entry points', async () => {
    window.electronAPI.billing.getBalance = vi.fn(() => new Promise<never>(() => undefined));

    render(<BillingPage />);

    await waitFor(() =>
      expect(
        screen.getByText('billing.settings.subscriptionCard.action').closest('button'),
      ).toHaveProperty('disabled', false),
    );
    expect(screen.getByText('billing.settings.topupCard.action').closest('button')).toHaveProperty(
      'disabled',
      false,
    );
  });

  it('shows server-visible unavailable offers and only enables purchasable offers', async () => {
    render(<BillingPage />);

    expect(screen.getByText('billing.settings.subscriptionCard.action')).toBeTruthy();
    expect(screen.getByText('billing.settings.topupCard.action')).toBeTruthy();
    expect(screen.queryByText('Configured top-up')).toBeNull();
    expect(screen.queryByText('Configured subscription')).toBeNull();

    fireEvent.click(screen.getByText('billing.settings.topupCard.action'));
    await screen.findByText('Configured top-up');
    expect(screen.getByText('Coming soon top-up').closest('button')).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByText('No-channel top-up').closest('button')).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByText('billing.catalog.unavailableReasons.OFFER_COMING_SOON')).toBeTruthy();
    expect(
      screen.getByText('billing.catalog.unavailableReasons.NO_AVAILABLE_PAYMENT_CHANNEL'),
    ).toBeTruthy();
    expect(screen.queryByText('Unknown-provider offer')).toBeNull();
    expect(screen.queryByText('Unconfigured offer')).toBeNull();
    expect(screen.queryByText('Legacy offer without channel projection')).toBeNull();
    expect(screen.queryByText('Unsupported payment action')).toBeNull();
    expect(screen.queryByText('Unsupported payment capability')).toBeNull();
    expect(screen.queryByText('Configured subscription')).toBeNull();
    expect(screen.queryByText('unknown_provider')).toBeNull();
    expect(screen.queryByText('alipay')).toBeNull();
    expect(screen.queryByText('stripe')).toBeNull();

    fireEvent.click(screen.getByText('Configured top-up').closest('button')!);
    expect(await screen.findByText('alipay')).toBeTruthy();
    expect(screen.queryByText('unknown_provider')).toBeNull();
    expect(screen.queryByText('stripe')).toBeNull();

    fireEvent.click(screen.getByText('alipay').closest('button')!);
    fireEvent.change(screen.getByPlaceholderText('billing.amount.placeholder'), {
      target: { value: '1.001' },
    });
    expect(screen.getByText('billing.actions.pay').closest('button')).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByText('billing.amount.formatError:{"digits":2}')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('billing.actions.close'));
    await waitFor(() => expect(screen.queryByText('Configured top-up')).toBeNull());

    fireEvent.click(screen.getByText('billing.settings.subscriptionCard.action'));
    fireEvent.click((await screen.findByText('Configured subscription')).closest('button')!);
    expect(screen.getByText('stripe')).toBeTruthy();
    expect(screen.queryByText('alipay')).toBeNull();
    fireEvent.click(screen.getByText('stripe').closest('button')!);
    fireEvent.click(screen.getByText('billing.actions.pay'));
    expect(checkout.startSubscription).toHaveBeenCalledWith({
      offerCode: 'plus_month',
      purchaseOptionId: 'listing_stripe',
    });
  });

  it('keeps checkout disabled until startup recovery finishes', async () => {
    checkout.recovering = true;
    const view = render(<BillingPage />);

    fireEvent.click(screen.getByText('billing.settings.topupCard.action'));
    fireEvent.click((await screen.findByText('Configured top-up')).closest('button')!);
    fireEvent.click((await screen.findByText('alipay')).closest('button')!);
    fireEvent.change(screen.getByPlaceholderText('billing.amount.placeholder'), {
      target: { value: '10' },
    });

    const pay = screen.getByText('billing.actions.pay').closest('button')!;
    expect(pay).toHaveProperty('disabled', true);
    fireEvent.click(pay);
    expect(checkout.startTopup).not.toHaveBeenCalled();

    checkout.recovering = false;
    view.rerender(<BillingPage />);
    expect(pay).toHaveProperty('disabled', false);
  });

  it('does not create a second subscription while one is still live', async () => {
    window.electronAPI.billing.getCurrentSubscription = vi.fn(async () => ({
      subscription: {
        subscriptionId: 'subscription_fixture',
        status: 'ACTIVE' as const,
        currentPeriodStartAt: null,
        currentPeriodEndAt: null,
        entitlementValidUntil: null,
        cancelAtPeriodEnd: false,
        effectivePlan: null,
        purchaseAttemptId: null,
        paymentAction: null,
      },
    }));

    render(<BillingPage />);
    fireEvent.click(await screen.findByText('billing.settings.subscriptionCard.action'));
    fireEvent.click((await screen.findByText('Configured subscription')).closest('button')!);
    fireEvent.click((await screen.findByText('stripe')).closest('button')!);

    const pay = screen.getByText('billing.actions.pay').closest('button')!;
    expect(pay).toHaveProperty('disabled', true);
    expect(screen.getByText('billing.currentSubscription.purchaseBlocked')).toBeTruthy();
    fireEvent.click(pay);
    expect(checkout.startSubscription).not.toHaveBeenCalled();
  });

  it('keeps subscription purchases disabled when subscription status is unavailable', async () => {
    window.electronAPI.billing.getCurrentSubscription = vi.fn(async () => {
      throw new Error('subscription status unavailable');
    });

    render(<BillingPage />);

    expect(await screen.findByText('billing.settings.subscriptionCard.unavailable')).toBeTruthy();
    expect(
      screen.getByText('billing.settings.subscriptionCard.action').closest('button'),
    ).toHaveProperty('disabled', true);
    expect(screen.getByText('billing.settings.topupCard.action').closest('button')).toHaveProperty(
      'disabled',
      false,
    );
  });

  it('clears a previously loaded subscription when refresh fails', async () => {
    window.electronAPI.billing.getCurrentSubscription = vi
      .fn()
      .mockResolvedValueOnce({
        subscription: {
          subscriptionId: 'subscription_fixture',
          status: 'ACTIVE' as const,
          currentPeriodStartAt: null,
          currentPeriodEndAt: null,
          entitlementValidUntil: null,
          cancelAtPeriodEnd: false,
          effectivePlan: {
            version: 1 as const,
            product: {
              code: 'plus',
              kind: 'SUBSCRIPTION' as const,
              level: 1,
            },
            offer: {
              code: 'plus_month',
              interval: 'MONTH' as const,
            },
            terms: {
              amount: '9',
              currency: 'usd',
              creditAmount: '100',
              rolloverCap: '0',
            },
            capturedAt: '2026-07-23T12:00:00.000Z',
          },
          purchaseAttemptId: null,
          paymentAction: null,
        },
      })
      .mockRejectedValueOnce(new Error('subscription status unavailable'));

    render(<BillingPage />);

    expect(await screen.findByText('Configured subscription')).toBeTruthy();
    fireEvent.click(screen.getByText('billing.actions.refreshCatalog'));

    expect(await screen.findByText('billing.settings.subscriptionCard.unavailable')).toBeTruthy();
    expect(screen.queryByText('Configured subscription')).toBeNull();
    expect(
      screen.getByText('billing.settings.subscriptionCard.action').closest('button'),
    ).toHaveProperty('disabled', true);
  });

  it('renders multiple remote subscription offers as independent choices', async () => {
    window.electronAPI.billing.getCatalog = vi.fn(async () => ({
      products: (['alipay', 'stripe', 'alipay'] as const).map((provider, index) => ({
        code: `plan_${index + 1}`,
        name: `Remote plan ${index + 1}`,
        kind: 'SUBSCRIPTION' as const,
        level: index + 1,
        sortOrder: index + 1,
        offers: [
          {
            code: `plan_${index + 1}_month`,
            interval: 'MONTH' as const,
            currency: 'cny',
            amount: String(index + 1),
            minAmount: null,
            maxAmount: null,
            creditAmount: String((index + 1) * 100),
            rolloverCap: '0',
            purchaseOptions: [
              {
                id: `listing_${provider}_${index + 1}`,
                provider,
                capability: 'PROVIDER_MANAGED_SUBSCRIPTION' as const,
                paymentAction: provider === 'alipay' ? ('QR_CODE' as const) : ('REDIRECT' as const),
              },
            ],
          },
        ],
      })),
    }));

    render(<BillingPage />);
    const viewPlans = screen
      .getByText('billing.settings.subscriptionCard.action')
      .closest('button')!;
    await waitFor(() => expect(viewPlans).toHaveProperty('disabled', false));
    fireEvent.click(viewPlans);

    const planButtons = await screen.findAllByRole('button', { name: /Remote plan/ });
    expect(planButtons).toHaveLength(3);
    expect(planButtons.map((button) => button.getAttribute('aria-pressed'))).toEqual([
      'false',
      'false',
      'false',
    ]);

    fireEvent.click(planButtons[1]);
    expect(planButtons[1].getAttribute('aria-pressed')).toBe('true');
    expect(await screen.findByText('stripe')).toBeTruthy();
    expect(screen.queryByText('alipay')).toBeNull();
  });

  it('allows an uncertain failed checkout to be dismissed for later recovery', async () => {
    Object.assign(checkout.state, {
      open: true,
      kind: 'TOPUP',
      phase: 'FAILED',
      intent: {
        version: 1,
        kind: 'TOPUP',
        idempotencyKey: 'desktop:topup:fixture-0001',
        request: {
          offerCode: 'credit_topup_custom',
          amount: '10',
          purchaseOptionId: 'listing_alipay',
        },
        orderId: null,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      order: null,
      subscription: null,
      error: true,
    });

    render(<BillingPage />);
    await screen.findByText('billing.checkout.requestFailed');
    fireEvent.click(screen.getByLabelText('billing.actions.close'));

    expect(checkout.close).toHaveBeenCalledTimes(1);
  });
});

describe('BillingPage plan change', () => {
  const subscriptionCatalog = {
    products: [
      {
        code: 'plus',
        name: 'Plus plan',
        kind: 'SUBSCRIPTION' as const,
        level: 1,
        sortOrder: 1,
        offers: [
          {
            code: 'plus_month',
            interval: 'MONTH' as const,
            currency: 'usd',
            amount: '9',
            minAmount: null,
            maxAmount: null,
            creditAmount: '100',
            rolloverCap: '0',
            purchaseOptions: [
              {
                id: 'listing_plus_stripe',
                provider: 'stripe',
                capability: 'PROVIDER_MANAGED_SUBSCRIPTION' as const,
                paymentAction: 'REDIRECT' as const,
              },
            ],
          },
        ],
      },
      {
        code: 'max',
        name: 'Max plan',
        kind: 'SUBSCRIPTION' as const,
        level: 2,
        sortOrder: 2,
        offers: [
          {
            code: 'max_month',
            interval: 'MONTH' as const,
            currency: 'usd',
            amount: '20',
            minAmount: null,
            maxAmount: null,
            creditAmount: '250',
            rolloverCap: '0',
            purchaseOptions: [
              {
                id: 'listing_max_stripe',
                provider: 'stripe',
                capability: 'PROVIDER_MANAGED_SUBSCRIPTION' as const,
                paymentAction: 'REDIRECT' as const,
              },
            ],
          },
        ],
      },
      {
        code: 'cn_max',
        name: 'Alipay-only Max',
        kind: 'SUBSCRIPTION' as const,
        level: 2,
        sortOrder: 3,
        offers: [
          {
            code: 'cn_max_month',
            interval: 'MONTH' as const,
            currency: 'cny',
            amount: '140',
            minAmount: null,
            maxAmount: null,
            creditAmount: '250',
            rolloverCap: '0',
            purchaseOptions: [
              {
                id: 'listing_cn_max_alipay',
                provider: 'alipay',
                capability: 'MERCHANT_INITIATED_MANDATE' as const,
                paymentAction: 'QR_CODE' as const,
              },
            ],
          },
        ],
      },
      {
        code: 'future_max',
        name: 'Coming soon Max',
        kind: 'SUBSCRIPTION' as const,
        level: 3,
        sortOrder: 4,
        offers: [
          {
            code: 'future_max_month',
            salesState: 'COMING_SOON' as const,
            purchasable: false,
            unavailableReason: 'OFFER_COMING_SOON' as const,
            interval: 'MONTH' as const,
            currency: 'usd',
            amount: '30',
            minAmount: null,
            maxAmount: null,
            creditAmount: '500',
            rolloverCap: '0',
            purchaseOptions: [],
          },
        ],
      },
    ],
  };

  const activeSubscription = (
    pendingPlanChange: unknown = null,
    interval: 'MONTH' | 'YEAR' = 'MONTH',
  ) => ({
    subscriptionId: 'subscription_active',
    status: 'ACTIVE' as const,
    provider: 'stripe',
    currentPeriodStartAt: '2026-07-01T00:00:00.000Z',
    currentPeriodEndAt: '2026-08-01T00:00:00.000Z',
    entitlementValidUntil: '2026-08-02T00:00:00.000Z',
    cancelAtPeriodEnd: false,
    effectivePlan: {
      version: 1 as const,
      product: { code: 'plus', kind: 'SUBSCRIPTION' as const, level: 1 },
      offer: { code: 'plus_month', interval },
      terms: { amount: '9', currency: 'usd', creditAmount: '100', rolloverCap: '0' },
      capturedAt: '2026-07-01T00:00:00.000Z',
    },
    purchaseAttemptId: null,
    paymentAction: null,
    pendingPlanChange,
  });

  const billingMocks = () => ({
    getBalance: vi.fn(async () => ({
      planCredits: '7.000000001',
      purchasedCredits: '5.000000002',
      promotionalCredits: '0.345678898',
      available: '12.345678901',
      scale: 9 as const,
      observedAt: '2026-07-23T12:00:00.000Z',
    })),
    getCatalog: vi.fn(async () => subscriptionCatalog),
    getCurrentSubscription: vi.fn(async () => ({ subscription: activeSubscription() })),
    quotePlanChange: vi.fn(),
    confirmPlanChange: vi.fn(),
    refreshPlanChange: vi.fn(),
    cancelPlanChange: vi.fn(),
  });

  const install = (billing: ReturnType<typeof billingMocks>) => {
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { billing, openExternal: vi.fn() },
    });
    return billing;
  };

  beforeEach(() => {
    localStorage.clear();
    checkout.recoverables.topups = [];
    checkout.recoverables.subscription = null;
    checkout.recovering = false;
    Object.assign(checkout.state, {
      open: false,
      kind: null,
      phase: 'IDLE',
      intent: null,
      order: null,
      subscription: null,
      error: false,
    });
    vi.stubGlobal('crypto', {
      randomUUID: () => '00000000-0000-4000-8000-000000000042',
    });
  });

  it('offers plan change for an active subscription with same-provider candidates only', async () => {
    const billing = install(billingMocks());
    billing.quotePlanChange.mockResolvedValue({
      planChangeId: 'plan_change_1',
      changeType: 'UPGRADE',
      status: 'QUOTED',
      quotedAmountMinor: 1100,
      quotedCurrency: 'usd',
      quoteExpiresAt: '2099-01-01T00:00:00.000Z',
      effectiveAt: '2026-07-24T00:00:00.000Z',
      paymentAction: null,
    });

    render(<BillingPage />);
    fireEvent.click(await screen.findByText('billing.settings.subscriptionCard.changeAction'));

    await screen.findByText('billing.planChange.targetTitle');
    expect(screen.getByText('Max plan')).toBeTruthy();
    expect(screen.queryByText('Alipay-only Max')).toBeNull();
    expect(screen.queryByText('Coming soon Max')).toBeNull();
    // The current plan renders in the summary card but must not be a candidate.
    expect(screen.getByText('billing.planChange.upgradeBadge')).toBeTruthy();

    fireEvent.click(screen.getByText('Max plan'));
    await screen.findByText('billing.planChange.quoteTitle');
    expect(billing.quotePlanChange).toHaveBeenCalledTimes(1);
    expect(billing.quotePlanChange).toHaveBeenCalledWith({
      targetOfferCode: 'max_month',
      idempotencyKey: 'desktop:plan-change:00000000-0000-4000-8000-000000000042',
    });
    expect(
      screen.getByText((text) => text.startsWith('billing.planChange.upgradeDueNow')),
    ).toBeTruthy();

    billing.confirmPlanChange.mockResolvedValue({
      planChangeId: 'plan_change_1',
      changeType: 'UPGRADE',
      status: 'APPLIED',
      quotedAmountMinor: 1100,
      quotedCurrency: 'usd',
      quoteExpiresAt: null,
      effectiveAt: '2026-07-24T00:00:00.000Z',
      paymentAction: null,
    });
    fireEvent.click(screen.getByText('billing.planChange.confirm'));
    await screen.findByText('billing.planChange.appliedTitle');
    // APPLIED refreshes subscription, catalog, and balance exactly once more.
    await waitFor(() => expect(billing.getBalance).toHaveBeenCalledTimes(2));
    expect(billing.getCurrentSubscription).toHaveBeenCalledTimes(2);
  });

  it('does not expose plan change for yearly subscriptions while server v1 is monthly-only', async () => {
    const billing = billingMocks();
    billing.getCurrentSubscription = vi.fn(async () => ({
      subscription: activeSubscription(null, 'YEAR'),
    }));
    install(billing);

    render(<BillingPage />);

    await screen.findByText('Plus plan');
    expect(screen.queryByText('billing.settings.subscriptionCard.changeAction')).toBeNull();
    expect(screen.getByText('billing.settings.subscriptionCard.action')).toBeTruthy();
    expect(billing.quotePlanChange).not.toHaveBeenCalled();
  });

  it('shows a scheduled downgrade banner and undoes it through DELETE', async () => {
    const billing = billingMocks();
    billing.getCurrentSubscription = vi.fn(async () => ({
      subscription: activeSubscription({
        planChangeId: 'plan_change_down',
        changeType: 'DOWNGRADE',
        status: 'SCHEDULED',
        quotedAmountMinor: null,
        quotedCurrency: null,
        quoteExpiresAt: null,
        effectiveAt: '2026-08-01T00:00:00.000Z',
        paymentAction: null,
        targetPlan: {
          product: { code: 'plus', level: 1 },
          offer: { code: 'plus_month', interval: 'MONTH' },
          terms: { amount: '9', currency: 'usd', creditAmount: '100' },
        },
      }),
    }));
    install(billing);
    billing.cancelPlanChange.mockResolvedValue({
      planChangeId: 'plan_change_down',
      changeType: 'DOWNGRADE',
      status: 'CANCELED',
      quotedAmountMinor: null,
      quotedCurrency: null,
      quoteExpiresAt: null,
      effectiveAt: '2026-08-01T00:00:00.000Z',
      paymentAction: null,
    });

    render(<BillingPage />);
    await screen.findByText((text) => text.startsWith('billing.planChange.pendingDowngrade'));

    fireEvent.click(screen.getByText('billing.planChange.undo'));
    await waitFor(() =>
      expect(billing.cancelPlanChange).toHaveBeenCalledWith({ planChangeId: 'plan_change_down' }),
    );
    // The canceled settle re-syncs the subscription projection for the banner.
    await waitFor(() => expect(billing.getCurrentSubscription).toHaveBeenCalledTimes(2));
  });

  it('resumes a pending alipay upgrade payment with the server-issued QR action', async () => {
    const qr = {
      type: 'QR_CODE' as const,
      value: 'https://qr.alipay.example/plan-change',
      expiresAt: '2099-01-01T00:00:00.000Z',
    };
    const billing = billingMocks();
    billing.getCurrentSubscription = vi.fn(async () => ({
      subscription: {
        ...activeSubscription({
          planChangeId: 'plan_change_up',
          changeType: 'UPGRADE',
          status: 'AWAITING_PAYMENT',
          quotedAmountMinor: 1500,
          quotedCurrency: 'cny',
          quoteExpiresAt: null,
          effectiveAt: '2026-07-24T00:00:00.000Z',
          paymentAction: qr,
          targetPlan: {
            product: { code: 'cn_max', level: 2 },
            offer: { code: 'cn_max_month', interval: 'MONTH' },
            terms: { amount: '140', currency: 'cny', creditAmount: '250' },
          },
        }),
        provider: 'alipay',
      },
    }));
    install(billing);
    billing.refreshPlanChange.mockResolvedValue({
      planChangeId: 'plan_change_up',
      changeType: 'UPGRADE',
      status: 'AWAITING_PAYMENT',
      quotedAmountMinor: 1500,
      quotedCurrency: 'cny',
      quoteExpiresAt: null,
      effectiveAt: '2026-07-24T00:00:00.000Z',
      paymentAction: qr,
    });

    render(<BillingPage />);
    await screen.findByText((text) => text.startsWith('billing.planChange.pendingPayment'));

    fireEvent.click(screen.getByText('billing.planChange.resume'));
    await screen.findByText('billing.planChange.awaitingTitle');
    expect(
      await screen.findByText((text) => text.startsWith('billing.planChange.scanToPay')),
    ).toBeTruthy();
    await screen.findByAltText('billing.checkout.qrAlt');
    // Resuming re-displays the stored server action without quoting again.
    expect(billing.quotePlanChange).not.toHaveBeenCalled();
  });
});
