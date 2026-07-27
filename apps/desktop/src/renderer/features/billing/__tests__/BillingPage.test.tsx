// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BillingSubscription } from '../../../../shared/billing';

const i18n = {
  language: 'en',
  resolvedLanguage: 'en' as string | undefined,
};

const uiMocks = vi.hoisted(() => ({
  confirm: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

const authState = vi.hoisted(() => ({ dataOwnerId: 'account-fixture' as string | null }));

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
  startTopup: vi.fn(),
  startSubscription: vi.fn(),
  refreshActive: vi.fn(),
  retry: vi.fn(),
  cancel: vi.fn(),
  close: vi.fn(),
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
vi.mock('../../../../shared/brandRegion', () => ({
  CURRENT_CINDY_REGION: 'cn',
  CURRENT_APP_ID: 'com.xd.cindycn',
}));
vi.mock('@/features/feature-context', () => ({
  useRegisterSidebarUpper: vi.fn(),
  useRegisterContentHeader: vi.fn(),
}));
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ dataOwnerId: authState.dataOwnerId }),
}));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: uiMocks.confirm }),
}));
vi.mock('@/lib/toast', () => ({
  toast: {
    error: uiMocks.toastError,
    success: uiMocks.toastSuccess,
  },
}));
vi.mock('../useBillingCheckout', () => ({
  useBillingCheckout: () => checkout,
}));
vi.mock('qrcode', () => ({
  toDataURL: vi.fn(async () => 'data:image/png;base64,fixture'),
}));

import { BillingPage } from '../BillingPage';

beforeEach(() => {
  uiMocks.confirm.mockReset().mockResolvedValue(false);
  uiMocks.toastError.mockReset();
  uiMocks.toastSuccess.mockReset();
  authState.dataOwnerId = 'account-fixture';
});

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
          openPaymentRedirect: vi.fn(async () => ({ success: true })),
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

  it('never renders a payment recovery banner on the settings page', async () => {
    render(<BillingPage />);

    await screen.findByText('billing.balance.title');
    expect(screen.queryByText((text) => text.startsWith('billing.recovery'))).toBeNull();
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

  it('switches to the expired hint once the server stops issuing the payment action', async () => {
    const order = {
      orderId: 'order_expiring_action',
      productCode: 'credit_topup',
      offerCode: 'credit_topup_custom',
      amount: '10',
      currency: 'cny',
      status: 'PENDING' as const,
      paymentAction: {
        type: 'QR_CODE' as const,
        value: 'https://qr.alipay.example/live',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:01:00.000Z',
    };
    Object.assign(checkout.state, {
      open: true,
      kind: 'TOPUP',
      phase: 'AWAITING_PAYMENT',
      order,
    });

    const view = render(<BillingPage />);
    // 服务端仍下发的动作以服务端为准展示，不用本地时钟提前藏码。
    expect(await screen.findByAltText('billing.checkout.qrAlt')).toBeTruthy();
    expect(screen.queryByText('billing.checkout.actionExpiredBody')).toBeNull();

    // 服务端判定过期后轮询响应把动作置空：切换为过期提示，不再显示二维码。
    Object.assign(checkout.state, { order: { ...order, paymentAction: null } });
    view.rerender(<BillingPage />);
    expect(await screen.findByText('billing.checkout.actionExpiredBody')).toBeTruthy();
    expect(screen.queryByAltText('billing.checkout.qrAlt')).toBeNull();
  });

  it('opens a Stripe Checkout redirect automatically once and keeps the manual fallback', async () => {
    const url = 'https://checkout.stripe.com/c/pay/session_fixture';
    const subscription = {
      subscriptionId: 'subscription_incomplete',
      status: 'INCOMPLETE' as const,
      currentPeriodStartAt: null,
      currentPeriodEndAt: null,
      entitlementValidUntil: null,
      cancelAtPeriodEnd: false,
      effectivePlan: null,
      purchaseAttemptId: 'attempt_redirect',
      paymentAction: {
        type: 'REDIRECT' as const,
        url,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    };
    Object.assign(checkout.state, {
      open: true,
      kind: 'SUBSCRIPTION',
      phase: 'AWAITING_PAYMENT',
      subscription,
    });
    const openPaymentRedirect = vi.mocked(window.electronAPI.billing.openPaymentRedirect);

    const view = render(<BillingPage />);
    await waitFor(() => expect(openPaymentRedirect).toHaveBeenCalledWith({ url }));

    Object.assign(checkout.state, { subscription: { ...subscription } });
    view.rerender(<BillingPage />);
    expect(openPaymentRedirect).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText('billing.checkout.openPayment'));
    expect(openPaymentRedirect).toHaveBeenCalledTimes(2);
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

  it('does not expose plan change when an active subscription has no effective plan', async () => {
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

    expect(await screen.findByText('billing.settings.subscriptionCard.action')).toBeTruthy();
    expect(screen.queryByText('billing.settings.subscriptionCard.changeAction')).toBeNull();
    expect(checkout.startSubscription).not.toHaveBeenCalled();
  });

  it('marks the current subscription offer and prevents selecting it again', async () => {
    window.electronAPI.billing.getCurrentSubscription = vi.fn(async () => ({
      subscription: {
        subscriptionId: 'subscription_fixture',
        status: 'ACTIVE' as const,
        currentPeriodStartAt: '2026-07-01T00:00:00.000Z',
        currentPeriodEndAt: '2026-08-01T00:00:00.000Z',
        entitlementValidUntil: '2026-08-02T00:00:00.000Z',
        cancelAtPeriodEnd: true,
        effectivePlan: {
          version: 1 as const,
          product: { code: 'plus', kind: 'SUBSCRIPTION' as const, level: 1 },
          offer: { code: 'plus_month', interval: 'MONTH' as const },
          terms: {
            amount: '9',
            currency: 'usd',
            creditAmount: '100',
            rolloverCap: '0',
          },
          capturedAt: '2026-07-01T00:00:00.000Z',
        },
        purchaseAttemptId: null,
        paymentAction: null,
      },
    }));

    render(<BillingPage />);
    fireEvent.click(await screen.findByText('billing.settings.subscriptionCard.action'));

    const dialog = await screen.findByRole('dialog');
    const currentPlan = within(dialog).getByRole('button', { name: /Configured subscription/ });
    expect(currentPlan).toHaveProperty('disabled', true);
    expect(currentPlan.getAttribute('aria-current')).toBe('true');
    expect(within(dialog).getByText('billing.catalog.currentPlan')).toBeTruthy();
    expect(within(dialog).queryByText('billing.steps.channel.title')).toBeNull();
    expect(within(dialog).queryByText('stripe')).toBeNull();

    fireEvent.click(currentPlan);
    expect(checkout.startSubscription).not.toHaveBeenCalled();
  });

  it.each(['INCOMPLETE', 'CANCELED', 'INCOMPLETE_EXPIRED'] as const)(
    'does not treat a %s response as the current subscription',
    async (status) => {
      window.electronAPI.billing.getCurrentSubscription = vi.fn(async () => ({
        subscription: {
          subscriptionId: 'subscription_terminal',
          status,
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
      expect(
        await screen.findByText('billing.settings.subscriptionCard.emptyTitle'),
      ).toBeTruthy();
      expect(screen.queryByText(`billing.subscriptionStatus.${status}`)).toBeNull();
      fireEvent.click(await screen.findByText('billing.settings.subscriptionCard.action'));

      fireEvent.click((await screen.findByText('Configured subscription')).closest('button')!);
      fireEvent.click(screen.getByText('stripe').closest('button')!);
      fireEvent.click(screen.getByText('billing.actions.pay'));

      expect(screen.queryByText('billing.settings.subscriptionCard.changeAction')).toBeNull();
      expect(checkout.startSubscription).toHaveBeenCalledWith({
        offerCode: 'plus_month',
        purchaseOptionId: 'listing_stripe',
      });
    },
  );

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
          {
            code: 'plus_year',
            interval: 'YEAR' as const,
            currency: 'usd',
            amount: '90',
            minAmount: null,
            maxAmount: null,
            creditAmount: '1200',
            rolloverCap: '0',
            purchaseOptions: [
              {
                id: 'listing_plus_year_stripe',
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
          {
            code: 'max_year',
            interval: 'YEAR' as const,
            currency: 'usd',
            amount: '200',
            minAmount: null,
            maxAmount: null,
            creditAmount: '3000',
            rolloverCap: '0',
            purchaseOptions: [
              {
                id: 'listing_max_year_stripe',
                provider: 'stripe',
                capability: 'PROVIDER_MANAGED_SUBSCRIPTION' as const,
                paymentAction: 'REDIRECT' as const,
              },
            ],
          },
        ],
      },
      {
        code: 'same_level',
        name: 'Same-level plan',
        kind: 'SUBSCRIPTION' as const,
        level: 1,
        sortOrder: 0,
        offers: [
          {
            code: 'same_level_month',
            interval: 'MONTH' as const,
            currency: 'usd',
            amount: '12',
            minAmount: null,
            maxAmount: null,
            creditAmount: '120',
            rolloverCap: '0',
            purchaseOptions: [
              {
                id: 'listing_same_level_stripe',
                provider: 'stripe',
                capability: 'PROVIDER_MANAGED_SUBSCRIPTION' as const,
                paymentAction: 'REDIRECT' as const,
              },
            ],
          },
        ],
      },
      {
        code: 'starter',
        name: 'Starter plan',
        kind: 'SUBSCRIPTION' as const,
        level: 0,
        sortOrder: 0,
        offers: [
          {
            code: 'starter_month',
            interval: 'MONTH' as const,
            currency: 'usd',
            amount: '5',
            minAmount: null,
            maxAmount: null,
            creditAmount: '50',
            rolloverCap: '0',
            purchaseOptions: [
              {
                id: 'listing_starter_stripe',
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
    pendingPlanChange: BillingSubscription['pendingPlanChange'] = null,
    interval: 'MONTH' | 'YEAR' = 'MONTH',
    status: BillingSubscription['status'] = 'ACTIVE',
    cancelAtPeriodEnd = false,
  ): BillingSubscription => ({
    subscriptionId: 'subscription_active',
    status,
    provider: 'stripe',
    currentPeriodStartAt: '2026-07-01T00:00:00.000Z',
    currentPeriodEndAt: '2026-08-01T00:00:00.000Z',
    entitlementValidUntil: '2026-08-02T00:00:00.000Z',
    cancelAtPeriodEnd,
    effectivePlan: {
      version: 1 as const,
      product: { code: 'plus', kind: 'SUBSCRIPTION' as const, level: 1 },
      offer: { code: interval === 'YEAR' ? 'plus_year' : 'plus_month', interval },
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
    getCurrentSubscription: vi.fn(
      async (): Promise<{ subscription: BillingSubscription | null }> => ({
        subscription: activeSubscription(),
      }),
    ),
    cancelCurrentSubscription: vi.fn(),
    quotePlanChange: vi.fn(),
    confirmPlanChange: vi.fn(),
    refreshPlanChange: vi.fn(),
    cancelPlanChange: vi.fn(),
    openPaymentRedirect: vi.fn(async () => ({ success: true })),
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

  it('confirms provider-neutral cancellation and keeps credits unchanged until period end', async () => {
    const billing = install(billingMocks());
    billing.cancelCurrentSubscription.mockResolvedValue({
      ...activeSubscription(),
      currentPeriodEndAt: '2026-09-01T00:00:00.000Z',
      cancelAtPeriodEnd: true,
    });
    uiMocks.confirm.mockResolvedValueOnce(true);

    render(<BillingPage />);
    fireEvent.click(await screen.findByText('billing.settings.subscriptionCard.cancelAction'));

    await waitFor(() => expect(billing.cancelCurrentSubscription).toHaveBeenCalledWith());
    expect(uiMocks.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'billing.settings.subscriptionCard.cancelConfirmTitle',
        confirmText: 'billing.settings.subscriptionCard.cancelConfirmAction',
      }),
    );
    expect(billing.getBalance).toHaveBeenCalledTimes(1);
    expect(uiMocks.toastSuccess).toHaveBeenCalledWith(
      expect.stringContaining('"date":"Sep 1, 2026"'),
    );
    expect(
      screen.getByText((text) => text.startsWith('billing.settings.subscriptionCard.endsAt')),
    ).toBeTruthy();
    expect(screen.queryByText('billing.settings.subscriptionCard.cancelAction')).toBeNull();
  });

  it.each(['INCOMPLETE', 'CANCELED', 'INCOMPLETE_EXPIRED'] as const)(
    'ignores a non-current %s subscription response',
    async (status) => {
      const billing = billingMocks();
      billing.getCurrentSubscription = vi.fn(async () => ({
        subscription: { ...activeSubscription(), status },
      }));
      install(billing);

      render(<BillingPage />);

      await screen.findByText('billing.settings.subscriptionCard.emptyTitle');
      expect(screen.queryByText(`billing.subscriptionStatus.${status}`)).toBeNull();
      expect(screen.queryByText('billing.settings.subscriptionCard.cancelAction')).toBeNull();
      expect(billing.cancelCurrentSubscription).not.toHaveBeenCalled();
    },
  );

  it('reloads the canonical subscription after checkout instead of keeping a provider-less response', async () => {
    const billing = billingMocks();
    const canonical = { ...activeSubscription(), provider: 'alipay' };
    billing.getCurrentSubscription
      .mockResolvedValueOnce({ subscription: null })
      .mockResolvedValueOnce({ subscription: canonical });
    install(billing);
    const checkoutSubscription: BillingSubscription = { ...canonical };
    delete checkoutSubscription.provider;
    Object.assign(checkout.state, {
      open: true,
      kind: 'SUBSCRIPTION',
      phase: 'AWAITING_PAYMENT',
      subscription: checkoutSubscription,
    });

    const view = render(<BillingPage />);
    await waitFor(() => expect(billing.getCurrentSubscription).toHaveBeenCalledTimes(1));

    Object.assign(checkout.state, { phase: 'COMPLETED' });
    view.rerender(<BillingPage />);

    await waitFor(() => expect(billing.getCurrentSubscription).toHaveBeenCalledTimes(2));
    fireEvent.click(await screen.findByText('billing.settings.subscriptionCard.changeAction'));
    expect(await screen.findByText('Alipay-only Max')).toBeTruthy();
    expect(screen.queryByText('Max plan')).toBeNull();
  });

  it('keeps the completed checkout subscription when the canonical reload temporarily fails', async () => {
    const billing = billingMocks();
    billing.getCurrentSubscription
      .mockResolvedValueOnce({ subscription: null })
      .mockRejectedValueOnce(new Error('temporarily unavailable'));
    install(billing);
    const completed = { ...activeSubscription(), provider: 'alipay' };
    Object.assign(checkout.state, {
      open: true,
      kind: 'SUBSCRIPTION',
      phase: 'AWAITING_PAYMENT',
      subscription: { ...completed, status: 'INCOMPLETE' },
    });

    const view = render(<BillingPage />);
    await waitFor(() => expect(billing.getCurrentSubscription).toHaveBeenCalledTimes(1));

    Object.assign(checkout.state, {
      phase: 'COMPLETED',
      subscription: completed,
    });
    view.rerender(<BillingPage />);

    await waitFor(() => expect(billing.getCurrentSubscription).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('billing.subscriptionStatus.ACTIVE')).toBeTruthy();
    expect(screen.queryByText('billing.settings.subscriptionCard.unavailable')).toBeNull();
    expect(screen.getByText('billing.settings.subscriptionCard.changeAction')).toBeTruthy();
  });

  it('locks cancellation before confirmation resolves', async () => {
    const billing = install(billingMocks());
    let resolveConfirm!: (confirmed: boolean) => void;
    uiMocks.confirm.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        resolveConfirm = resolve;
      }),
    );

    render(<BillingPage />);
    const cancelButton = await screen.findByText('billing.settings.subscriptionCard.cancelAction');
    fireEvent.click(cancelButton);
    fireEvent.click(cancelButton);

    expect(uiMocks.confirm).toHaveBeenCalledTimes(1);
    expect(billing.cancelCurrentSubscription).not.toHaveBeenCalled();

    await act(async () => resolveConfirm(false));
  });

  it('drops a confirmed cancellation when the account changed while confirming', async () => {
    const billing = install(billingMocks());
    let resolveConfirm!: (confirmed: boolean) => void;
    uiMocks.confirm.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        resolveConfirm = resolve;
      }),
    );

    const view = render(<BillingPage />);
    fireEvent.click(await screen.findByText('billing.settings.subscriptionCard.cancelAction'));
    expect(uiMocks.confirm).toHaveBeenCalledTimes(1);

    // 弹窗还开着时账号被换掉:section 按 dataOwnerId 重挂,但弹窗挂在 AuthProvider
    // 之外仍然存活。此时确认不能落到新账号的订阅上。
    authState.dataOwnerId = 'account-switched';
    view.rerender(<BillingPage />);
    await screen.findByText('billing.settings.subscriptionCard.cancelAction');

    await act(async () => resolveConfirm(true));

    expect(billing.cancelCurrentSubscription).not.toHaveBeenCalled();
  });

  it('keeps the loading cancellation accessible and disables competing actions', async () => {
    const billing = billingMocks();
    billing.getCurrentSubscription = vi.fn(async () => ({
      subscription: activeSubscription({
        planChangeId: 'plan_change_pending',
        changeType: 'DOWNGRADE',
        status: 'SCHEDULED',
        quotedAmountMinor: null,
        quotedCurrency: null,
        quoteExpiresAt: null,
        effectiveAt: '2026-08-01T00:00:00.000Z',
        paymentAction: null,
        targetPlan: null,
      }),
    }));
    install(billing);
    const canceled = { ...activeSubscription(), cancelAtPeriodEnd: true };
    let resolveCancellation!: (subscription: BillingSubscription) => void;
    billing.cancelCurrentSubscription.mockReturnValueOnce(
      new Promise<BillingSubscription>((resolve) => {
        resolveCancellation = resolve;
      }),
    );
    uiMocks.confirm.mockResolvedValueOnce(true);

    render(<BillingPage />);
    fireEvent.click(await screen.findByText('billing.settings.subscriptionCard.cancelAction'));

    await waitFor(() => expect(billing.cancelCurrentSubscription).toHaveBeenCalledTimes(1));
    expect(
      screen
        .getByRole('button', { name: 'billing.settings.subscriptionCard.cancelAction' })
        .hasAttribute('disabled'),
    ).toBe(true);
    const refreshButton = screen.getByRole('button', { name: 'billing.actions.refreshCatalog' });
    expect(refreshButton.hasAttribute('disabled')).toBe(true);
    fireEvent.click(refreshButton);
    expect(billing.getCurrentSubscription).toHaveBeenCalledTimes(1);
    const undoButton = screen.getByText('billing.planChange.undo').closest('button')!;
    expect(undoButton.hasAttribute('disabled')).toBe(true);
    fireEvent.click(undoButton);
    expect(billing.cancelPlanChange).not.toHaveBeenCalled();

    await act(async () => resolveCancellation(canceled));
  });

  it('shows the server-state rejection without inferring a payment provider', async () => {
    const billing = install(billingMocks());
    billing.cancelCurrentSubscription.mockRejectedValue(
      new Error('[PRECONDITION_FAILED] billing request conflicts with the current state'),
    );
    uiMocks.confirm.mockResolvedValueOnce(true);

    render(<BillingPage />);
    fireEvent.click(await screen.findByText('billing.settings.subscriptionCard.cancelAction'));

    await waitFor(() =>
      expect(uiMocks.toastError).toHaveBeenCalledWith(
        'billing.settings.subscriptionCard.cancelNotSupported',
      ),
    );
    expect(billing.cancelCurrentSubscription).toHaveBeenCalledWith();
    expect(billing.getBalance).toHaveBeenCalledTimes(1);
    expect(screen.getByText('billing.settings.subscriptionCard.cancelAction')).toBeTruthy();
  });

  it('offers same-provider monthly plans in upgrade, same-tier, downgrade order', async () => {
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
    const dialog = screen.getByRole('dialog');
    const currentPlanButton = within(dialog).getByText('Plus plan').closest('button')!;
    const maxButton = screen.getByText('Max plan').closest('button')!;
    const sameLevelButton = screen.getByText('Same-level plan').closest('button')!;
    const starterButton = screen.getByText('Starter plan').closest('button')!;
    expect(
      maxButton.compareDocumentPosition(sameLevelButton) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(
      sameLevelButton.compareDocumentPosition(starterButton) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(within(maxButton).getByText('billing.planChange.upgradeBadge')).toBeTruthy();
    expect(currentPlanButton.hasAttribute('disabled')).toBe(true);
    expect(currentPlanButton.getAttribute('aria-current')).toBe('true');
    expect(within(currentPlanButton).getByText('billing.catalog.currentPlan')).toBeTruthy();
    expect(within(maxButton).getByText('stripe')).toBeTruthy();
    expect(within(sameLevelButton).getByText('billing.planChange.sameLevelBadge')).toBeTruthy();
    expect(within(starterButton).getByText('billing.planChange.downgradeBadge')).toBeTruthy();
    expect(screen.queryByText('Alipay-only Max')).toBeNull();
    expect(screen.queryByText('Coming soon Max')).toBeNull();

    fireEvent.click(maxButton);
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

  it('opens a Stripe plan-change redirect automatically once and keeps the manual fallback', async () => {
    const billing = install(billingMocks());
    const url = 'https://checkout.stripe.com/c/pay/plan_change_fixture';
    billing.quotePlanChange.mockResolvedValue({
      planChangeId: 'plan_change_redirect',
      changeType: 'UPGRADE',
      status: 'QUOTED',
      quotedAmountMinor: 1100,
      quotedCurrency: 'usd',
      quoteExpiresAt: '2099-01-01T00:00:00.000Z',
      effectiveAt: '2026-07-24T00:00:00.000Z',
      paymentAction: null,
    });
    billing.confirmPlanChange.mockResolvedValue({
      planChangeId: 'plan_change_redirect',
      changeType: 'UPGRADE',
      status: 'AWAITING_PAYMENT',
      quotedAmountMinor: 1100,
      quotedCurrency: 'usd',
      quoteExpiresAt: null,
      effectiveAt: '2026-07-24T00:00:00.000Z',
      paymentAction: {
        type: 'REDIRECT',
        url,
        expiresAt: '2099-01-01T00:00:00.000Z',
      },
    });

    render(<BillingPage />);
    fireEvent.click(await screen.findByText('billing.settings.subscriptionCard.changeAction'));
    fireEvent.click((await screen.findByText('Max plan')).closest('button')!);
    fireEvent.click(await screen.findByText('billing.planChange.confirm'));

    await waitFor(() => expect(billing.openPaymentRedirect).toHaveBeenCalledWith({ url }));
    expect(billing.openPaymentRedirect).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText('billing.checkout.openPayment'));
    expect(billing.openPaymentRedirect).toHaveBeenCalledTimes(2);
  });

  it('renders a grandfathered current plan from the captured subscription terms', async () => {
    const billing = billingMocks();
    const grandfathered = activeSubscription();
    grandfathered.effectivePlan = {
      ...grandfathered.effectivePlan!,
      offer: { code: 'plus_legacy', interval: 'MONTH' },
      terms: {
        amount: '7',
        currency: 'usd',
        creditAmount: '80',
        rolloverCap: '0',
      },
    };
    billing.getCurrentSubscription = vi.fn(async () => ({ subscription: grandfathered }));
    install(billing);

    render(<BillingPage />);
    fireEvent.click(await screen.findByText('billing.settings.subscriptionCard.changeAction'));

    const dialog = await screen.findByRole('dialog');
    const currentButton = within(dialog)
      .getByText('billing.catalog.currentPlan')
      .closest('button')!;
    expect(within(currentButton).getByText('Plus plan')).toBeTruthy();
    expect(within(currentButton).getByText('$7.00')).toBeTruthy();
    expect(
      within(currentButton).getByText('billing.credits:{"amount":"80"}'),
    ).toBeTruthy();
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

  it('does not offer cross-provider targets when the current provider is unavailable', async () => {
    const subscription = activeSubscription();
    delete subscription.provider;
    const billing = billingMocks();
    billing.getCurrentSubscription = vi.fn(async () => ({ subscription }));
    install(billing);

    render(<BillingPage />);

    fireEvent.click(await screen.findByText('billing.settings.subscriptionCard.changeAction'));
    expect(await screen.findByText('billing.planChange.emptyTitle')).toBeTruthy();
    expect(screen.queryByText('Max plan')).toBeNull();
    expect(billing.quotePlanChange).not.toHaveBeenCalled();
  });

  it.each(['TRIALING', 'PAST_DUE', 'UNPAID', 'PAUSED'] as const)(
    'does not expose plan change for server-ineligible %s subscriptions',
    async (status) => {
      const billing = billingMocks();
      billing.getCurrentSubscription = vi.fn(async () => ({
        subscription: activeSubscription(null, 'MONTH', status),
      }));
      install(billing);

      render(<BillingPage />);

      await screen.findByText('Plus plan');
      expect(screen.queryByText('billing.settings.subscriptionCard.changeAction')).toBeNull();
      expect(screen.getByText('billing.settings.subscriptionCard.action')).toBeTruthy();
    },
  );

  it('does not expose plan change when cancellation is scheduled for period end', async () => {
    const billing = billingMocks();
    billing.getCurrentSubscription = vi.fn(async () => ({
      subscription: activeSubscription(null, 'MONTH', 'ACTIVE', true),
    }));
    install(billing);

    render(<BillingPage />);

    await screen.findByText('Plus plan');
    expect(screen.queryByText('billing.settings.subscriptionCard.changeAction')).toBeNull();
    expect(screen.getByText('billing.settings.subscriptionCard.action')).toBeTruthy();
  });

  it('keeps new selection enabled when no current subscription exists (no INCOMPLETE task)', async () => {
    // 服务端不再把未支付的首购作为“当前订阅”下发；页面必须允许正常重新选择。
    const billing = billingMocks();
    billing.getCurrentSubscription = vi.fn(
      async () => ({ subscription: null }),
    ) as unknown as typeof billing.getCurrentSubscription;
    install(billing);

    render(<BillingPage />);

    fireEvent.click(await screen.findByText('billing.settings.subscriptionCard.action'));
    fireEvent.click((await screen.findAllByText('Plus plan'))[0].closest('button')!);
    fireEvent.click(screen.getByText('stripe').closest('button')!);
    const pay = screen.getByText('billing.actions.pay').closest('button')!;
    expect(pay).toHaveProperty('disabled', false);
    fireEvent.click(pay);
    expect(checkout.startSubscription).toHaveBeenCalledWith({
      offerCode: 'plus_month',
      purchaseOptionId: 'listing_plus_stripe',
    });
  });

  it('stops treating the abandoned checkout subscription as current when the dialog closes', async () => {
    const billing = billingMocks();
    billing.getCurrentSubscription = vi.fn(
      async () => ({ subscription: null }),
    ) as unknown as typeof billing.getCurrentSubscription;
    install(billing);
    Object.assign(checkout.state, {
      open: true,
      kind: 'SUBSCRIPTION',
      phase: 'AWAITING_PAYMENT',
      subscription: {
        subscriptionId: 'subscription_incomplete',
        status: 'INCOMPLETE',
        currentPeriodStartAt: null,
        currentPeriodEndAt: null,
        entitlementValidUntil: null,
        cancelAtPeriodEnd: false,
        effectivePlan: null,
        purchaseAttemptId: 'attempt_incomplete',
        paymentAction: null,
      },
    });

    render(<BillingPage />);
    await waitFor(() => {
      expect(screen.getByText('billing.settings.subscriptionCard.emptyTitle')).toBeTruthy();
      expect(screen.queryByText('billing.subscriptionStatus.INCOMPLETE')).toBeNull();
    });
    fireEvent.click(await screen.findByLabelText('billing.actions.close'));

    expect(checkout.close).toHaveBeenCalled();
    await waitFor(() => expect(billing.getCurrentSubscription.mock.calls.length).toBeGreaterThan(1));
    fireEvent.click(await screen.findByText('billing.settings.subscriptionCard.action'));
    fireEvent.click((await screen.findAllByText('Plus plan'))[0].closest('button')!);
    fireEvent.click(screen.getByText('stripe').closest('button')!);
    expect(screen.getByText('billing.actions.pay').closest('button')).toHaveProperty(
      'disabled',
      false,
    );
  });

  it('still blocks a duplicate purchase while a real subscription is live', async () => {
    const billing = billingMocks();
    billing.getCurrentSubscription = vi.fn(async () => ({
      subscription: { ...activeSubscription(), effectivePlan: null },
    }));
    install(billing);

    render(<BillingPage />);

    fireEvent.click(await screen.findByText('billing.settings.subscriptionCard.action'));
    fireEvent.click((await screen.findAllByText('Plus plan'))[0].closest('button')!);
    fireEvent.click(screen.getByText('stripe').closest('button')!);
    expect(screen.getByText('billing.actions.pay').closest('button')).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByText('billing.currentSubscription.purchaseBlocked')).toBeTruthy();
  });

  it('explains a rejected quote and returns to the candidate list', async () => {
    const billing = install(billingMocks());
    billing.quotePlanChange.mockRejectedValue(
      new Error('[PLAN_CHANGE_NOT_AVAILABLE] target offer is not allowed'),
    );

    render(<BillingPage />);
    fireEvent.click(await screen.findByText('billing.settings.subscriptionCard.changeAction'));
    fireEvent.click(await screen.findByText('Max plan'));

    expect(await screen.findByText('billing.planChange.quoteRejected')).toBeTruthy();
    fireEvent.click(screen.getByText('billing.planChange.chooseAnotherPlan'));
    expect(await screen.findByText('billing.planChange.targetTitle')).toBeTruthy();
    expect(screen.getByText('Max plan')).toBeTruthy();
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

  it('ignores non-SCHEDULED pending changes and reopens target selection instead', async () => {
    // 兼容旧服务端：即使投影里出现 AWAITING_PAYMENT，也不再提供“继续支付”入口；
    // 变更套餐总是回到目标选择，由服务端在新报价时自动替换旧动作。
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

    render(<BillingPage />);
    await screen.findByText('Plus plan');
    expect(
      screen.queryByText((text) => text.startsWith('billing.planChange.pendingDowngrade')),
    ).toBeNull();
    expect(screen.queryByText('billing.planChange.undo')).toBeNull();

    fireEvent.click(screen.getByText('billing.settings.subscriptionCard.changeAction'));
    expect(await screen.findByText('billing.planChange.targetTitle')).toBeTruthy();
    expect(billing.refreshPlanChange).not.toHaveBeenCalled();
  });
});
