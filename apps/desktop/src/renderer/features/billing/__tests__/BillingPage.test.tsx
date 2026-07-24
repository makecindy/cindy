// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  recoverables: { topups: [], subscription: null },
  recovering: false,
  startTopup: vi.fn(),
  startSubscription: vi.fn(),
  refreshActive: vi.fn(),
  retry: vi.fn(),
  cancel: vi.fn(),
  close: vi.fn(),
  resumeTopup: vi.fn(),
  resumeSubscription: vi.fn(),
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
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
                code: 'hidden',
                name: 'Unconfigured offer',
                kind: 'CREDIT_TOPUP',
                level: null,
                sortOrder: 4,
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
                sortOrder: 5,
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
                sortOrder: 6,
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
                sortOrder: 7,
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
        new Intl.NumberFormat(undefined, { style: 'currency', currency: 'CNY' }).format(
          12.345678901,
        ),
      ),
    ).toBeTruthy();
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
        new Intl.NumberFormat(undefined, { style: 'currency', currency: 'CNY' }).format(0),
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

  it('shows only configured offers and only the selected offer channels', async () => {
    render(<BillingPage />);

    expect(screen.getByText('billing.settings.subscriptionCard.action')).toBeTruthy();
    expect(screen.getByText('billing.settings.topupCard.action')).toBeTruthy();
    expect(screen.queryByText('Configured top-up')).toBeNull();
    expect(screen.queryByText('Configured subscription')).toBeNull();

    fireEvent.click(screen.getByText('billing.settings.topupCard.action'));
    await screen.findByText('Configured top-up');
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
    const viewPlans = screen
      .getByText('billing.settings.subscriptionCard.action')
      .closest('button')!;
    await waitFor(() => expect(viewPlans).toHaveProperty('disabled', false));
    fireEvent.click(viewPlans);
    fireEvent.click((await screen.findByText('Configured subscription')).closest('button')!);
    fireEvent.click((await screen.findByText('stripe')).closest('button')!);

    expect(screen.getByText('billing.actions.pay').closest('button')).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByText('billing.currentSubscription.purchaseBlocked')).toBeTruthy();
  });

  it('fails closed for subscription purchases when subscription status is unavailable', async () => {
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

  it('shows a generic payment success message without fulfillment details', async () => {
    Object.assign(checkout.state, {
      open: true,
      kind: 'TOPUP',
      phase: 'COMPLETED',
      order: {
        orderId: 'order_paid',
        productCode: 'credit_topup',
        offerCode: 'credit_topup_custom',
        amount: '10',
        currency: 'cny',
        status: 'SUCCEEDED',
        fulfillmentStatus: 'FAILED',
        paymentAction: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:01:00.000Z',
      },
    });

    render(<BillingPage />);
    await screen.findByText('billing.settings.subscriptionCard.empty');

    expect(screen.getByText('billing.checkout.completedTitle')).toBeTruthy();
    expect(screen.getByText('billing.checkout.paymentCompleted')).toBeTruthy();
    expect(screen.queryByText('billing.checkout.fulfillingTitle')).toBeNull();
    expect(screen.queryByText('billing.checkout.creditingBody')).toBeNull();
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
