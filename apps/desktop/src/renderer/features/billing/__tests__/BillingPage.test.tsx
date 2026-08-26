// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  BillingPaymentOrder,
  BillingSubscription,
  BillingSubscriptionPortalResult,
} from '../../../../shared/billing';

const i18n = {
  language: 'en',
  resolvedLanguage: 'en' as string | undefined,
};

const uiMocks = vi.hoisted(() => ({
  clipboardWriteText: vi.fn(),
  confirm: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

const authState = vi.hoisted(() => ({ dataOwnerId: 'account-fixture' as string | null }));

/**
 * 计费页只用 useSearchParams 消费 `?intent=topup` 深链，不需要真的挂 Router：
 * 用一个可读写的 URLSearchParams 替身，既能驱动深链分支，也能断言参数被摘除。
 */
const routerState = vi.hoisted(() => ({ search: '' as string }));

const checkout = {
  state: {
    open: false,
    kind: null as 'CREDIT_TOPUP' | 'SUBSCRIPTION' | null,
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
// 只覆写 useSearchParams(深链 ?intent=topup 的读写口),其余导出保留真实实现 ——
// 全量替换会让后续用到 Link / useNavigate 等导出的用例拿到 undefined 才炸在别处。
vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router-dom')>()),
  useSearchParams: () => [
    new URLSearchParams(routerState.search),
    (next: URLSearchParams) => {
      routerState.search = next.toString();
    },
  ],
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
// 只替换 hook 本身:同模块的 phaseForOrder 是纯函数,订单记录的状态文案刻意复用它
// (支付弹窗与列表必须由同一个判据推导),整模块 mock 掉会把那条依赖一起挖空。
vi.mock('../useBillingCheckout', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../useBillingCheckout')>()),
  useBillingCheckout: () => checkout,
}));
vi.mock('qrcode', () => ({
  toDataURL: vi.fn(async () => 'data:image/png;base64,fixture'),
}));

import { BillingPage } from '../BillingPage';
import * as QRCode from 'qrcode';

beforeEach(() => {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: uiMocks.clipboardWriteText },
  });
  uiMocks.clipboardWriteText.mockReset().mockResolvedValue(undefined);
  uiMocks.confirm.mockReset().mockResolvedValue(false);
  uiMocks.toastError.mockReset();
  uiMocks.toastSuccess.mockReset();
  authState.dataOwnerId = 'account-fixture';
  routerState.search = '';
});

async function openSubscriptionManagementMenu() {
  const trigger = await screen.findByText('billing.settings.subscriptionCard.manageAction');
  fireEvent.pointerDown(trigger.closest('button')!, { button: 0, ctrlKey: false });
  await screen.findByRole('menu');
}

async function selectSubscriptionManagementAction(action: string) {
  await openSubscriptionManagementMenu();
  fireEvent.click(await screen.findByRole('menuitem', { name: action }));
}

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
          listOrders: vi.fn(async () => ({ orders: [], nextCursor: null })),
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

  it('does not describe missing plan credits as incomplete history when there is no subscription', async () => {
    window.electronAPI.billing.getCreditUsage = vi.fn(async () => ({
      available: '3',
      plan: { remaining: '0', used: null, total: null },
      purchased: { remaining: '0', used: '0', total: '0' },
      promotional: { remaining: '3', used: '0', total: '3' },
      promotionalGrants: [],
      promotionalGrantsComplete: true,
      promotionalGrantConsistency: 'OBSERVED' as const,
      ledgerUpdatedAt: null,
      scale: 9 as const,
      observedAt: '2026-07-23T12:00:00Z',
    }));

    render(<BillingPage />);

    expect(await screen.findByText('billing.usage.noPlanCredits')).toBeTruthy();
    expect(screen.queryByText('billing.usage.historyUnavailable')).toBeNull();
  });

  it('keeps nonzero plan balances truthful when there is no subscription', async () => {
    window.electronAPI.billing.getCreditUsage = vi.fn(async () => ({
      available: '3',
      plan: { remaining: '3', used: null, total: null },
      purchased: { remaining: '0', used: '0', total: '0' },
      promotional: { remaining: '0', used: '0', total: '0' },
      promotionalGrants: [],
      promotionalGrantsComplete: true,
      promotionalGrantConsistency: 'OBSERVED' as const,
      ledgerUpdatedAt: null,
      scale: 9 as const,
      observedAt: '2026-07-23T12:00:00Z',
    }));

    render(<BillingPage />);

    expect(await screen.findByText('billing.usage.historyUnavailable')).toBeTruthy();
    expect(screen.queryByText('billing.usage.noPlanCredits')).toBeNull();
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
    await openSubscriptionManagementMenu();
    expect(
      screen.getByRole('menuitem', { name: 'billing.settings.subscriptionCard.changeAction' }),
    ).toBeTruthy();
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
    expect(offerButtons[0].parentElement?.className).toContain('divide-y');
    expect(offerButtons[0].parentElement?.className).toContain('rounded-xl');
    expect(
      within(offerButtons[0]).getByText(`billing.credits:{"amount":"${twenty}"}`),
    ).toBeTruthy();
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
    const qrCode = await screen.findByAltText('billing.checkout.qrAlt');
    expect(qrCode.parentElement?.querySelectorAll('img')).toHaveLength(2);
    expect(vi.mocked(QRCode.toDataURL)).toHaveBeenCalledWith(
      order.paymentAction.value,
      expect.objectContaining({ errorCorrectionLevel: 'H', margin: 4, width: 320 }),
    );
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

  it('深链 ?intent=topup 直接打开充值弹窗，并把参数摘掉防返回/刷新重复弹', async () => {
    // 供应商设置页的账户资产模块「余额充值」走的就是这条深链：充值弹窗依赖本页的
    // 目录 / 选项 / checkout 状态，跨 feature 只投递意图。
    routerState.search = 'tab=billing&intent=topup';

    render(<BillingPage />);

    expect(await screen.findByText('Configured top-up')).toBeTruthy();
    expect(new URLSearchParams(routerState.search).get('intent')).toBeNull();
    expect(new URLSearchParams(routerState.search).get('tab')).toBe('billing');
  });

  it('没有 intent 参数时不自动弹充值弹窗', async () => {
    render(<BillingPage />);

    await screen.findByText('billing.settings.topupCard.action');
    expect(screen.queryByText('Configured top-up')).toBeNull();
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

    const configuredTopup = screen.getByText('Configured top-up').closest('button')!;
    fireEvent.click(configuredTopup);
    expect(configuredTopup.getAttribute('aria-pressed')).toBe('true');
    expect(configuredTopup.className).not.toContain('shadow-[inset');
    expect(await screen.findByText('alipay')).toBeTruthy();
    expect(screen.queryByText('unknown_provider')).toBeNull();
    expect(screen.queryByText('stripe')).toBeNull();

    const alipayOption = screen.getByText('alipay').closest('button')!;
    fireEvent.click(alipayOption);
    expect(alipayOption.getAttribute('aria-pressed')).toBe('true');
    expect(alipayOption.className).not.toContain('shadow-[inset');
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

    await openSubscriptionManagementMenu();
    expect(
      await screen.findByRole('menuitem', { name: 'billing.settings.subscriptionCard.action' }),
    ).toBeTruthy();
    expect(
      screen.queryByRole('menuitem', { name: 'billing.settings.subscriptionCard.changeAction' }),
    ).toBeNull();
    expect(checkout.startSubscription).not.toHaveBeenCalled();
  });

  it('keeps a Product enterable when its current Offer has another Offer', async () => {
    window.electronAPI.billing.getCatalog = vi.fn(async () => ({
      products: [
        {
          code: 'plus',
          name: 'Configured subscription',
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
                  id: 'plus_month_stripe',
                  provider: 'stripe',
                  capability: 'PROVIDER_MANAGED_SUBSCRIPTION' as const,
                  paymentAction: 'REDIRECT' as const,
                },
              ],
            },
            {
              code: 'plus_month_more',
              interval: 'MONTH' as const,
              currency: 'usd',
              amount: '20',
              minAmount: null,
              maxAmount: null,
              creditAmount: '250',
              rolloverCap: '0',
              purchaseOptions: [
                {
                  id: 'plus_month_more_stripe',
                  provider: 'stripe',
                  capability: 'PROVIDER_MANAGED_SUBSCRIPTION' as const,
                  paymentAction: 'REDIRECT' as const,
                },
              ],
            },
          ],
        },
      ],
    }));
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
    await selectSubscriptionManagementAction('billing.settings.subscriptionCard.action');

    const dialog = await screen.findByRole('dialog');
    const product = within(dialog).getByRole('button', { name: /Configured subscription/ });
    expect(product).toHaveProperty('disabled', false);
    const currentPlan = within(dialog).getByText('billing.catalog.currentPlan').closest('button')!;
    const alternativeOffer = within(dialog).getByText('$20.00').closest('button')!;
    const alternativeCredits = new Intl.NumberFormat('en', {
      style: 'currency',
      currency: 'USD',
    }).format(250);
    expect(
      within(alternativeOffer).getByText(
        `billing.credits:{"amount":"${alternativeCredits}"}`,
      ).className,
    ).toContain('text-12');
    expect(within(dialog).queryByText('plus_month_more')).toBeNull();
    expect(currentPlan).toHaveProperty('disabled', true);
    expect(currentPlan.getAttribute('aria-current')).toBe('true');
    expect(alternativeOffer).toHaveProperty('disabled', false);
    expect(alternativeOffer.getAttribute('aria-pressed')).toBe('true');
    expect(alternativeOffer.className).not.toContain('shadow-[inset');
    expect(within(dialog).getByText('billing.steps.channel.title')).toBeTruthy();
    expect(within(dialog).getByText('stripe')).toBeTruthy();

    expect(checkout.startSubscription).not.toHaveBeenCalled();
  });

  it('defaults within a Product and keeps unavailable state at the Offer level', async () => {
    window.electronAPI.billing.getCatalog = vi.fn(async () => ({
      products: [
        {
          code: 'pro',
          name: 'Pro',
          kind: 'SUBSCRIPTION' as const,
          level: 1,
          sortOrder: 1,
          offers: [
            {
              code: 'pro_month_current',
              interval: 'MONTH' as const,
              currency: 'usd',
              amount: '9',
              minAmount: null,
              maxAmount: null,
              creditAmount: '100',
              rolloverCap: '0',
              purchaseOptions: [
                {
                  id: 'pro_current_stripe',
                  provider: 'stripe',
                  capability: 'PROVIDER_MANAGED_SUBSCRIPTION' as const,
                  paymentAction: 'REDIRECT' as const,
                },
              ],
            },
            {
              code: 'pro_month_more',
              interval: 'MONTH' as const,
              currency: 'usd',
              amount: '20',
              minAmount: null,
              maxAmount: null,
              creditAmount: '250',
              rolloverCap: '0',
              purchaseOptions: [
                {
                  id: 'pro_more_stripe',
                  provider: 'stripe',
                  capability: 'PROVIDER_MANAGED_SUBSCRIPTION' as const,
                  paymentAction: 'REDIRECT' as const,
                },
              ],
            },
          ],
        },
        {
          code: 'future',
          name: 'Coming Soon',
          kind: 'SUBSCRIPTION' as const,
          level: 2,
          sortOrder: 2,
          offers: [
            {
              code: 'future_month',
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
    }));
    window.electronAPI.billing.getCurrentSubscription = vi.fn(async () => ({ subscription: null }));

    render(<BillingPage />);
    fireEvent.click(await screen.findByText('billing.settings.subscriptionCard.action'));

    const dialog = await screen.findByRole('dialog');
    const defaultOffer = within(dialog).getByText('$9.00').closest('button')!;
    await waitFor(() =>
      expect(document.activeElement).toBe(defaultOffer),
    );
    const proProduct = within(dialog).getByRole('button', { name: /Pro/ });
    const futureProduct = within(dialog).getByRole('button', { name: /Coming Soon/ });
    expect(proProduct).toHaveProperty('disabled', false);
    expect(proProduct.closest('section')?.parentElement?.className).toContain('rounded-xl');
    expect(proProduct.closest('section')?.className).not.toContain('border-[var(--text-primary)]');
    expect(futureProduct).toHaveProperty('disabled', true);
    expect(
      within(futureProduct).getByText('billing.catalog.unavailableReasons.OFFER_COMING_SOON'),
    ).toBeTruthy();

    const secondOffer = within(dialog).getByText('$20.00').closest('button')!;
    const defaultCredits = new Intl.NumberFormat('en', {
      style: 'currency',
      currency: 'USD',
    }).format(100);
    expect(
      within(defaultOffer).getByText(`billing.credits:{"amount":"${defaultCredits}"}`),
    ).toBeTruthy();
    expect(within(dialog).queryByText('pro_month_current')).toBeNull();
    expect(within(dialog).queryByText('pro_month_more')).toBeNull();
    expect(defaultOffer).toHaveProperty('disabled', false);
    expect(defaultOffer.getAttribute('aria-pressed')).toBe('true');
    expect(defaultOffer.firstElementChild?.querySelector('svg')).toBeNull();
    expect(defaultOffer.lastElementChild?.querySelector('svg')).toBeTruthy();
    expect(secondOffer.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(secondOffer);
    expect(secondOffer.getAttribute('aria-pressed')).toBe('true');
    expect(secondOffer.className).not.toContain('shadow-[inset');
  });

  it('shows the server-default Offer price when a Product is collapsed', async () => {
    const offer = (code: string, amount: string) => ({
      code,
      interval: 'MONTH' as const,
      currency: 'usd',
      amount,
      minAmount: null,
      maxAmount: null,
      creditAmount: amount,
      rolloverCap: '0',
      purchaseOptions: [
        {
          id: `${code}_stripe`,
          provider: 'stripe',
          capability: 'PROVIDER_MANAGED_SUBSCRIPTION' as const,
          paymentAction: 'REDIRECT' as const,
        },
      ],
    });
    window.electronAPI.billing.getCatalog = vi.fn(async () => ({
      products: [
        {
          code: 'pro',
          name: 'Pro',
          kind: 'SUBSCRIPTION' as const,
          level: 1,
          sortOrder: 1,
          offers: [offer('pro_default', '20'), offer('pro_cheaper', '9')],
        },
        {
          code: 'basic',
          name: 'Basic',
          kind: 'SUBSCRIPTION' as const,
          level: 0,
          sortOrder: 2,
          offers: [offer('basic_default', '5')],
        },
      ],
    }));
    window.electronAPI.billing.getCurrentSubscription = vi.fn(async () => ({ subscription: null }));

    render(<BillingPage />);
    fireEvent.click(await screen.findByText('billing.settings.subscriptionCard.action'));

    const dialog = await screen.findByRole('dialog');
    const defaultOffer = within(dialog).getByText('$20.00').closest('button')!;
    expect(defaultOffer.getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(within(dialog).getByRole('button', { name: /Basic/ }));
    const collapsedProduct = within(dialog).getByRole('button', { name: /Pro/ });
    expect(within(collapsedProduct).getByText('$20.00')).toBeTruthy();
    expect(within(collapsedProduct).queryByText('$9.00')).toBeNull();
    expect(within(collapsedProduct).queryByText(/billing\.amount\.startingAt/)).toBeNull();
  });

  it('reselects the first valid Offer in the same Product after a catalog refresh', async () => {
    const firstOffer = {
      code: 'pro_month',
      interval: 'MONTH' as const,
      currency: 'usd',
      amount: '9',
      minAmount: null,
      maxAmount: null,
      creditAmount: '100',
      rolloverCap: '0',
      purchaseOptions: [
        {
          id: 'pro_month_stripe',
          provider: 'stripe',
          capability: 'PROVIDER_MANAGED_SUBSCRIPTION' as const,
          paymentAction: 'REDIRECT' as const,
        },
      ],
    };
    const secondOffer = {
      ...firstOffer,
      code: 'pro_month_more',
      amount: '20',
      creditAmount: '250',
      purchaseOptions: [
        {
          ...firstOffer.purchaseOptions[0],
          id: 'pro_month_more_stripe',
        },
      ],
    };
    const product = {
      code: 'pro',
      name: 'Pro',
      kind: 'SUBSCRIPTION' as const,
      level: 1,
      sortOrder: 1,
      offers: [firstOffer, secondOffer],
    };
    const otherProduct = {
      code: 'basic',
      name: 'Basic',
      kind: 'SUBSCRIPTION' as const,
      level: 0,
      sortOrder: 2,
      offers: [
        {
          ...firstOffer,
          code: 'basic_month',
          amount: '5',
          creditAmount: '50',
          purchaseOptions: [
            {
              ...firstOffer.purchaseOptions[0],
              id: 'basic_month_stripe',
            },
          ],
        },
      ],
    };
    window.electronAPI.billing.getCatalog = vi
      .fn()
      .mockResolvedValueOnce({ products: [product, otherProduct] })
      .mockResolvedValueOnce({ products: [{ ...product, offers: [firstOffer] }, otherProduct] })
      .mockResolvedValueOnce({ products: [otherProduct] });
    window.electronAPI.billing.getCurrentSubscription = vi.fn(async () => ({ subscription: null }));

    render(<BillingPage />);
    fireEvent.click(await screen.findByText('billing.settings.subscriptionCard.action'));

    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /Pro/ }));
    const secondOfferButton = within(dialog).getByText('$20.00').closest('button')!;
    fireEvent.click(secondOfferButton);
    expect(secondOfferButton.getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(screen.getByText('billing.actions.refreshCatalog'));
    await waitFor(() =>
      expect(
        within(dialog).getByText('$9.00').closest('button')?.getAttribute('aria-pressed'),
      ).toBe('true'),
    );
    expect(within(dialog).queryByText('pro_month')).toBeNull();
    expect(within(dialog).queryByText('$20.00')).toBeNull();

    fireEvent.click(screen.getByText('billing.actions.refreshCatalog'));
    await waitFor(() => expect(within(dialog).getByRole('button', { name: /Basic/ })).toBeTruthy());
    expect(within(dialog).queryByLabelText('settings.back')).toBeNull();
    expect(within(dialog).queryByText('$9.00')).toBeNull();
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
      expect(await screen.findByText('billing.settings.subscriptionCard.emptyTitle')).toBeTruthy();
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

  it('renders single-Offer subscription Products as direct rows', async () => {
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
      'true',
      'false',
      'false',
    ]);
    expect(planButtons.map((button) => button.getAttribute('aria-expanded'))).toEqual([
      null,
      null,
      null,
    ]);
    expect(within(planButtons[0]).getByText(/1\.00/)).toBeTruthy();
    expect(within(planButtons[0]).queryByText(/billing\.amount\.startingAt/)).toBeNull();
    const firstPlanCredits = new Intl.NumberFormat('en', {
      style: 'currency',
      currency: 'CNY',
    }).format(100);
    expect(
      within(planButtons[0]).getByText(`billing.credits:{"amount":"${firstPlanCredits}"}`),
    ).toBeTruthy();
    expect(screen.queryByText('plan_1_month')).toBeNull();
    expect(screen.getByText('alipay')).toBeTruthy();
    expect(screen.queryByText('stripe')).toBeNull();

    fireEvent.click(planButtons[1]);
    expect(screen.queryByText('plan_1_month')).toBeNull();
    expect(
      (await screen.findAllByRole('button', { name: /Remote plan/ })).map((button) =>
        button.getAttribute('aria-pressed'),
      ),
    ).toEqual(['false', 'true', 'false']);
    expect(
      screen
        .getAllByRole('button', { name: /Remote plan/ })
        .map((button) => button.getAttribute('aria-expanded')),
    ).toEqual([null, null, null]);
    expect(screen.queryByText('plan_2_month')).toBeNull();
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
    listOrders: vi.fn(async () => ({ orders: [], nextCursor: null })),
    cancelCurrentSubscription: vi.fn(),
    resumeCurrentSubscription: vi.fn(),
    quotePlanChange: vi.fn(),
    confirmPlanChange: vi.fn(),
    refreshPlanChange: vi.fn(),
    cancelPlanChange: vi.fn(),
    openPaymentRedirect: vi.fn(async () => ({ success: true })),
    openSubscriptionPortal: vi.fn(),
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

  it('refreshes when Cindy regains focus before the Stripe portal launch resolves', async () => {
    const billing = install(billingMocks());
    let resolvePortal!: (result: BillingSubscriptionPortalResult) => void;
    billing.openSubscriptionPortal.mockImplementation(
      () =>
        new Promise<BillingSubscriptionPortalResult>((resolve) => {
          resolvePortal = resolve;
        }),
    );

    render(<BillingPage />);
    await openSubscriptionManagementMenu();
    expect(
      screen.getByRole('menuitem', { name: 'billing.settings.subscriptionCard.changeAction' }),
    ).toBeTruthy();
    expect(
      screen.getByRole('menuitem', { name: 'billing.settings.subscriptionCard.portalAction' }),
    ).toBeTruthy();
    expect(
      screen.getByRole('menuitem', { name: 'billing.settings.subscriptionCard.cancelAction' }),
    ).toBeTruthy();
    const portalAction = screen.getByRole('menuitem', {
      name: 'billing.settings.subscriptionCard.portalAction',
    });
    await act(async () => {
      fireEvent.click(portalAction);
      fireEvent.click(portalAction);
    });

    expect(billing.openSubscriptionPortal).toHaveBeenCalledWith();
    expect(billing.openSubscriptionPortal).toHaveBeenCalledTimes(1);

    const catalogCalls = billing.getCatalog.mock.calls.length;
    const subscriptionCalls = billing.getCurrentSubscription.mock.calls.length;
    const balanceCalls = billing.getBalance.mock.calls.length;
    await act(async () => window.dispatchEvent(new Event('focus')));
    await waitFor(() => {
      expect(billing.getCatalog).toHaveBeenCalledTimes(catalogCalls + 1);
      expect(billing.getCurrentSubscription).toHaveBeenCalledTimes(subscriptionCalls + 1);
      expect(billing.getBalance).toHaveBeenCalledTimes(balanceCalls + 1);
    });

    await act(async () => resolvePortal({ success: true }));
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(billing.getCurrentSubscription).toHaveBeenCalledTimes(subscriptionCalls + 1);
  });

  it('refreshes billing after a timed-out Stripe portal launch', async () => {
    const billing = install(billingMocks());
    billing.openSubscriptionPortal.mockResolvedValue({ success: false, timedOut: true });

    render(<BillingPage />);
    await selectSubscriptionManagementAction('billing.settings.subscriptionCard.portalAction');
    await waitFor(() => {
      expect(uiMocks.toastError).toHaveBeenCalledWith(
        'billing.settings.subscriptionCard.portalFailed',
      );
    });

    const catalogCalls = billing.getCatalog.mock.calls.length;
    const subscriptionCalls = billing.getCurrentSubscription.mock.calls.length;
    const balanceCalls = billing.getBalance.mock.calls.length;
    await act(async () => window.dispatchEvent(new Event('focus')));
    await waitFor(() => {
      expect(billing.getCatalog).toHaveBeenCalledTimes(catalogCalls + 1);
      expect(billing.getCurrentSubscription).toHaveBeenCalledTimes(subscriptionCalls + 1);
      expect(billing.getBalance).toHaveBeenCalledTimes(balanceCalls + 1);
    });
  });

  it('does not show Stripe management in the menu for an Alipay subscription', async () => {
    const billing = billingMocks();
    billing.getCurrentSubscription = vi.fn(async () => ({
      subscription: { ...activeSubscription(), provider: 'alipay' },
    }));
    install(billing);

    render(<BillingPage />);

    await screen.findByText('Plus plan');
    await openSubscriptionManagementMenu();
    expect(
      screen.queryByRole('menuitem', { name: 'billing.settings.subscriptionCard.portalAction' }),
    ).toBeNull();
    expect(billing.openSubscriptionPortal).not.toHaveBeenCalled();
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
    await selectSubscriptionManagementAction('billing.settings.subscriptionCard.cancelAction');

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
    await openSubscriptionManagementMenu();
    expect(
      screen.queryByRole('menuitem', { name: 'billing.settings.subscriptionCard.cancelAction' }),
    ).toBeNull();
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
    await selectSubscriptionManagementAction('billing.settings.subscriptionCard.changeAction');
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
    await openSubscriptionManagementMenu();
    expect(
      screen.getByRole('menuitem', { name: 'billing.settings.subscriptionCard.changeAction' }),
    ).toBeTruthy();
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
    await selectSubscriptionManagementAction('billing.settings.subscriptionCard.cancelAction');
    await selectSubscriptionManagementAction('billing.settings.subscriptionCard.cancelAction');

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
    await selectSubscriptionManagementAction('billing.settings.subscriptionCard.cancelAction');
    expect(uiMocks.confirm).toHaveBeenCalledTimes(1);

    // 弹窗还开着时账号被换掉:section 按 dataOwnerId 重挂,但弹窗挂在 AuthProvider
    // 之外仍然存活。此时确认不能落到新账号的订阅上。
    authState.dataOwnerId = 'account-switched';
    view.rerender(<BillingPage />);
    await openSubscriptionManagementMenu();
    expect(
      screen.getByRole('menuitem', { name: 'billing.settings.subscriptionCard.cancelAction' }),
    ).toBeTruthy();

    await act(async () => resolveConfirm(true));

    expect(billing.cancelCurrentSubscription).not.toHaveBeenCalled();
  });

  it('disables subscription management while cancellation is pending', async () => {
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
    await selectSubscriptionManagementAction('billing.settings.subscriptionCard.cancelAction');

    await waitFor(() => expect(billing.cancelCurrentSubscription).toHaveBeenCalledTimes(1));
    expect(
      screen
        .getByRole('button', { name: 'billing.settings.subscriptionCard.manageAction' })
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
    await selectSubscriptionManagementAction('billing.settings.subscriptionCard.cancelAction');

    await waitFor(() =>
      expect(uiMocks.toastError).toHaveBeenCalledWith(
        'billing.settings.subscriptionCard.cancelNotSupported',
      ),
    );
    expect(billing.cancelCurrentSubscription).toHaveBeenCalledWith();
    expect(billing.getBalance).toHaveBeenCalledTimes(1);
    await openSubscriptionManagementMenu();
    expect(
      screen.getByRole('menuitem', { name: 'billing.settings.subscriptionCard.cancelAction' }),
    ).toBeTruthy();
  });

  it('offers same-provider monthly Products in Catalog order', async () => {
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
    await selectSubscriptionManagementAction('billing.settings.subscriptionCard.changeAction');

    await screen.findByText('billing.planChange.targetTitle');
    const dialog = screen.getByRole('dialog');
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
    expect(within(dialog).getByText('billing.catalog.currentPlan')).toBeTruthy();
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

  it('quotes the selected same-Product monthly Offer', async () => {
    const billing = billingMocks();
    billing.getCatalog = vi.fn(async () => ({
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
              code: 'plus_month_more',
              interval: 'MONTH' as const,
              currency: 'usd',
              amount: '20',
              minAmount: null,
              maxAmount: null,
              creditAmount: '250',
              rolloverCap: '0',
              purchaseOptions: [
                {
                  id: 'listing_plus_more_stripe',
                  provider: 'stripe',
                  capability: 'PROVIDER_MANAGED_SUBSCRIPTION' as const,
                  paymentAction: 'REDIRECT' as const,
                },
              ],
            },
          ],
        },
      ],
    }));
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
    install(billing);

    render(<BillingPage />);
    await selectSubscriptionManagementAction('billing.settings.subscriptionCard.changeAction');

    const productButton = screen
      .getAllByText('Plus plan')
      .map((element) => element.closest('button'))
      .find((button): button is HTMLButtonElement => button !== null)!;
    expect(productButton).toHaveProperty('disabled', false);
    fireEvent.click(productButton);

    await waitFor(() =>
      expect(billing.quotePlanChange).toHaveBeenCalledWith({
        targetOfferCode: 'plus_month_more',
        idempotencyKey: 'desktop:plan-change:00000000-0000-4000-8000-000000000042',
      }),
    );
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
    await selectSubscriptionManagementAction('billing.settings.subscriptionCard.changeAction');
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
    await selectSubscriptionManagementAction('billing.settings.subscriptionCard.changeAction');

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('billing.catalog.currentPlan')).toBeTruthy();
    expect(within(dialog).getByText('$7.00')).toBeTruthy();
    expect(within(dialog).getByText('billing.credits:{"amount":"$80.00"}')).toBeTruthy();
  });

  it('does not expose plan change for yearly subscriptions while server v1 is monthly-only', async () => {
    const billing = billingMocks();
    billing.getCurrentSubscription = vi.fn(async () => ({
      subscription: activeSubscription(null, 'YEAR'),
    }));
    install(billing);

    render(<BillingPage />);

    await screen.findByText('Plus plan');
    await openSubscriptionManagementMenu();
    expect(
      screen.queryByRole('menuitem', { name: 'billing.settings.subscriptionCard.changeAction' }),
    ).toBeNull();
    expect(
      screen.getByRole('menuitem', { name: 'billing.settings.subscriptionCard.action' }),
    ).toBeTruthy();
    expect(billing.quotePlanChange).not.toHaveBeenCalled();
  });

  it('does not offer cross-provider targets when the current provider is unavailable', async () => {
    const subscription = activeSubscription();
    delete subscription.provider;
    const billing = billingMocks();
    billing.getCurrentSubscription = vi.fn(async () => ({ subscription }));
    install(billing);

    render(<BillingPage />);

    await selectSubscriptionManagementAction('billing.settings.subscriptionCard.changeAction');
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
      await openSubscriptionManagementMenu();
      expect(
        screen.queryByRole('menuitem', { name: 'billing.settings.subscriptionCard.changeAction' }),
      ).toBeNull();
      expect(
        screen.getByRole('menuitem', { name: 'billing.settings.subscriptionCard.action' }),
      ).toBeTruthy();
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
    await openSubscriptionManagementMenu();
    expect(
      screen.queryByRole('menuitem', { name: 'billing.settings.subscriptionCard.changeAction' }),
    ).toBeNull();
    expect(
      screen.getByRole('menuitem', { name: 'billing.settings.subscriptionCard.action' }),
    ).toBeTruthy();
  });

  it('keeps new selection enabled when no current subscription exists (no INCOMPLETE task)', async () => {
    // 服务端不再把未支付的首购作为“当前订阅”下发；页面必须允许正常重新选择。
    const billing = billingMocks();
    billing.getCurrentSubscription = vi.fn(async () => ({
      subscription: null,
    })) as unknown as typeof billing.getCurrentSubscription;
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
    billing.getCurrentSubscription = vi.fn(async () => ({
      subscription: null,
    })) as unknown as typeof billing.getCurrentSubscription;
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
    await waitFor(() =>
      expect(billing.getCurrentSubscription.mock.calls.length).toBeGreaterThan(1),
    );
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

    await selectSubscriptionManagementAction('billing.settings.subscriptionCard.action');
    fireEvent.click((await screen.findAllByText('Plus plan'))[0].closest('button')!);
    fireEvent.click(screen.getByText('stripe').closest('button')!);
    expect(screen.getByText('billing.actions.pay').closest('button')).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByText('billing.currentSubscription.purchaseBlocked')).toBeTruthy();
  });

  it('shows the period-end copy in the purchase dialog when the live subscription is scheduled to cancel', async () => {
    const billing = billingMocks();
    billing.getCurrentSubscription = vi.fn(async () => ({
      subscription: { ...activeSubscription(null, 'MONTH', 'ACTIVE', true), effectivePlan: null },
    }));
    install(billing);

    render(<BillingPage />);

    await selectSubscriptionManagementAction('billing.settings.subscriptionCard.action');
    fireEvent.click((await screen.findAllByText('Plus plan'))[0].closest('button')!);
    fireEvent.click(screen.getByText('stripe').closest('button')!);
    expect(screen.getByText('billing.actions.pay').closest('button')).toHaveProperty(
      'disabled',
      true,
    );
    expect(
      screen.getByText(/billing\.currentSubscription\.purchaseBlockedUntilPeriodEnd/),
    ).toBeTruthy();
    expect(screen.queryByText('billing.currentSubscription.purchaseBlocked')).toBeNull();
  });

  it('falls back to the generic copy when the scheduled-cancel subscription has an unparseable period end', async () => {
    const billing = billingMocks();
    billing.getCurrentSubscription = vi.fn(async () => ({
      subscription: {
        ...activeSubscription(null, 'MONTH', 'ACTIVE', true),
        effectivePlan: null,
        currentPeriodEndAt: 'not-a-valid-date',
      },
    }));
    install(billing);

    render(<BillingPage />);

    await selectSubscriptionManagementAction('billing.settings.subscriptionCard.action');
    fireEvent.click((await screen.findAllByText('Plus plan'))[0].closest('button')!);
    fireEvent.click(screen.getByText('stripe').closest('button')!);
    expect(screen.getByText('billing.currentSubscription.purchaseBlocked')).toBeTruthy();
    expect(screen.queryByText(/purchaseBlockedUntilPeriodEnd/)).toBeNull();
  });

  it('shows the resume action only for resumable canceled subscriptions', async () => {
    const billing = billingMocks();
    billing.getCurrentSubscription = vi.fn(async () => ({
      subscription: { ...activeSubscription(null, 'MONTH', 'ACTIVE', true), resumable: true },
    }));
    install(billing);

    render(<BillingPage />);

    await openSubscriptionManagementMenu();
    expect(screen.getByText('billing.settings.subscriptionCard.resumeAction')).toBeTruthy();
    expect(screen.queryByText('billing.settings.subscriptionCard.cancelAction')).toBeNull();
  });

  it('confirms a provider-neutral resume and replaces the canceled subscription projection', async () => {
    const billing = billingMocks();
    const canceled = {
      ...activeSubscription(null, 'MONTH', 'ACTIVE', true),
      resumable: true,
    };
    billing.getCurrentSubscription = vi.fn(async () => ({ subscription: canceled }));
    billing.resumeCurrentSubscription.mockResolvedValue({
      ...canceled,
      cancelAtPeriodEnd: false,
      resumable: false,
    });
    install(billing);
    uiMocks.confirm.mockResolvedValueOnce(true);

    render(<BillingPage />);
    await selectSubscriptionManagementAction('billing.settings.subscriptionCard.resumeAction');

    await waitFor(() => expect(billing.resumeCurrentSubscription).toHaveBeenCalledWith());
    expect(uiMocks.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'billing.settings.subscriptionCard.resumeConfirmTitle',
        confirmText: 'billing.settings.subscriptionCard.resumeConfirmAction',
      }),
    );
    expect(uiMocks.toastSuccess).toHaveBeenCalledWith(
      'billing.settings.subscriptionCard.resumeSuccess',
    );
    await openSubscriptionManagementMenu();
    expect(
      screen.queryByRole('menuitem', { name: 'billing.settings.subscriptionCard.resumeAction' }),
    ).toBeNull();
    expect(
      screen.getByRole('menuitem', { name: 'billing.settings.subscriptionCard.cancelAction' }),
    ).toBeTruthy();
  });

  it('explains when the server no longer allows subscription resume', async () => {
    const billing = billingMocks();
    billing.getCurrentSubscription = vi.fn(async () => ({
      subscription: { ...activeSubscription(null, 'MONTH', 'ACTIVE', true), resumable: true },
    }));
    billing.resumeCurrentSubscription.mockRejectedValue(
      new Error('[RESUME_NOT_AVAILABLE] subscription is not resumable'),
    );
    install(billing);
    uiMocks.confirm.mockResolvedValueOnce(true);

    render(<BillingPage />);
    await selectSubscriptionManagementAction('billing.settings.subscriptionCard.resumeAction');

    await waitFor(() =>
      expect(uiMocks.toastError).toHaveBeenCalledWith(
        'billing.settings.subscriptionCard.resumeNotAvailable',
      ),
    );
    await waitFor(() => expect(billing.getCurrentSubscription).toHaveBeenCalledTimes(2));
  });

  it('hides the resume action when the server marks the subscription not resumable', async () => {
    const billing = billingMocks();
    billing.getCurrentSubscription = vi.fn(async () => ({
      subscription: { ...activeSubscription(null, 'MONTH', 'ACTIVE', true), resumable: false },
    }));
    install(billing);

    render(<BillingPage />);

    await openSubscriptionManagementMenu();
    expect(screen.queryByText('billing.settings.subscriptionCard.resumeAction')).toBeNull();
    expect(screen.queryByText('billing.settings.subscriptionCard.cancelAction')).toBeNull();
  });

  it('explains a rejected quote and returns to the candidate list', async () => {
    const billing = install(billingMocks());
    billing.quotePlanChange.mockRejectedValue(
      new Error('[PLAN_CHANGE_NOT_AVAILABLE] target offer is not allowed'),
    );

    render(<BillingPage />);
    await selectSubscriptionManagementAction('billing.settings.subscriptionCard.changeAction');
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

    await selectSubscriptionManagementAction('billing.settings.subscriptionCard.changeAction');
    expect(await screen.findByText('billing.planChange.targetTitle')).toBeTruthy();
    expect(billing.refreshPlanChange).not.toHaveBeenCalled();
  });
});

/**
 * 订单记录组。回归的是「页面只讲现在还有多少，不讲钱是怎么来的」——用户查不到上次充了多少、
 * 那笔没付成的还在不在。三条判据在这里各有用例:空态整组不渲染(不加空壳)、状态文案与支付
 * 弹窗同一判据(phaseForOrder)、服务端还有下一页时只出提示条不出分页器。
 */
describe('BillingPage order history', () => {
  const order = (over: Partial<BillingPaymentOrder> = {}): BillingPaymentOrder => ({
    orderId: 'ord_8f21c4de9a',
    productCode: 'credit_topup',
    offerCode: 'credit_topup_custom',
    // 刻意与余额 / 赠送池的数字不同:同一页里重复的金额会让断言抓错节点。
    amount: '33',
    currency: 'cny',
    status: 'SUCCEEDED',
    paymentAction: null,
    createdAt: '2026-08-01T13:07:00.000Z',
    updatedAt: '2026-08-01T13:09:00.000Z',
    ...over,
  });

  const install = (
    orders: BillingPaymentOrder[],
    nextCursor: string | null = null,
  ): ReturnType<typeof vi.fn> => {
    const listOrders = vi.fn(async () => ({ orders, nextCursor }));
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        billing: {
          getCreditUsage: vi.fn(async () => ({
            available: '20',
            plan: { remaining: '0', used: '0', total: '0' },
            purchased: { remaining: '0', used: '0', total: '0' },
            promotional: { remaining: '20', used: '0', total: '20' },
            promotionalGrants: [],
            promotionalGrantsComplete: true,
            promotionalGrantConsistency: 'OBSERVED' as const,
            ledgerUpdatedAt: null,
            scale: 9 as const,
            observedAt: '2026-08-01T00:00:00.000Z',
          })),
          getBalance: vi.fn(),
          getCatalog: vi.fn(async () => ({ products: [] })),
          getCurrentSubscription: vi.fn(async () => ({ subscription: null })),
          listOrders,
          openPaymentRedirect: vi.fn(async () => ({ success: true })),
        },
        openExternal: vi.fn(),
      },
    });
    return listOrders;
  };

  it('lists the most recent orders with amount, masked id and status', async () => {
    const fullOrderId = 'c2309a98-d776-4ad9-99b3-418951f13c7f';
    install([order({ orderId: fullOrderId })]);

    render(<BillingPage />);

    expect(await screen.findByText('billing.orders.title')).toBeTruthy();
    expect(screen.getByText('billing.orders.count:{"count":1}')).toBeTruthy();
    expect(screen.getByText('billing.orders.description')).toBeTruthy();
    // 展示首尾并固定脱敏中段，不把完整订单号写进可见文本或原生 title。
    const orderIdButton = screen.getByRole('button', {
      name: 'billing.orders.copy.action:{"id":"c2309a98****51f13c7f"}',
    });
    expect(
      within(orderIdButton).getByText('billing.orders.orderId:{"id":"c2309a98****51f13c7f"}'),
    ).toBeTruthy();
    expect(orderIdButton.getAttribute('title')).toBeNull();
    expect(screen.queryByText(`billing.orders.orderId:{"id":"${fullOrderId}"}`)).toBeNull();
    expect(orderIdButton.querySelector('svg')).toBeTruthy();
    expect(
      screen.getByText(
        new Intl.NumberFormat('en', { style: 'currency', currency: 'CNY' }).format(33),
      ),
    ).toBeTruthy();
    expect(screen.getByText('billing.orders.states.completed')).toBeTruthy();
  });

  it('copies the complete order id from both the id text and copy icon', async () => {
    const fullOrderId = 'c2309a98-d776-4ad9-99b3-418951f13c7f';
    install([order({ orderId: fullOrderId })]);

    render(<BillingPage />);

    const orderIdButton = await screen.findByRole('button', {
      name: 'billing.orders.copy.action:{"id":"c2309a98****51f13c7f"}',
    });
    const maskedText = within(orderIdButton).getByText(
      'billing.orders.orderId:{"id":"c2309a98****51f13c7f"}',
    );
    const copyIcon = orderIdButton.querySelector('svg');
    expect(copyIcon).toBeTruthy();

    fireEvent.click(maskedText);
    await waitFor(() => expect(uiMocks.clipboardWriteText).toHaveBeenCalledWith(fullOrderId));
    expect(uiMocks.toastSuccess).toHaveBeenCalledWith('billing.orders.copy.success');

    uiMocks.clipboardWriteText.mockClear();
    fireEvent.click(copyIcon!);
    await waitFor(() => expect(uiMocks.clipboardWriteText).toHaveBeenCalledWith(fullOrderId));
  });

  it('masks short ids, distinguishes copy targets and keeps the control shrinkable', async () => {
    const shortOrderId = 'ord_8f21c4de9a';
    const otherOrderId = '1234567890abcdefghi';
    install([order({ orderId: shortOrderId }), order({ orderId: otherOrderId })]);

    render(<BillingPage />);

    const shortOrderButton = await screen.findByRole('button', {
      name: 'billing.orders.copy.action:{"id":"ord_8f****c4de9a"}',
    });
    expect(
      within(shortOrderButton).getByText('billing.orders.orderId:{"id":"ord_8f****c4de9a"}'),
    ).toBeTruthy();
    expect(
      screen.getByRole('button', {
        name: 'billing.orders.copy.action:{"id":"12345678****bcdefghi"}',
      }),
    ).toBeTruthy();
    expect(shortOrderButton.className).toContain('max-w-full');
    expect(shortOrderButton.querySelector('span')?.className).toContain('break-all');
  });

  it('explains how to recover when copying an order id fails', async () => {
    uiMocks.clipboardWriteText.mockRejectedValueOnce(new Error('clipboard denied'));
    install([order()]);

    render(<BillingPage />);
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'billing.orders.copy.action:{"id":"ord_8f****c4de9a"}',
      }),
    );

    await waitFor(() =>
      expect(uiMocks.toastError).toHaveBeenCalledWith('billing.orders.copy.failed'),
    );
  });

  it('asks the server for exactly the ten most recent orders', async () => {
    const listOrders = install([order()]);

    render(<BillingPage />);
    await screen.findByText('billing.orders.title');
    expect(listOrders).toHaveBeenCalledWith({ limit: 10 });
  });

  it('renders no group at all when there are no orders — the page keeps its current shape', async () => {
    install([]);

    render(<BillingPage />);
    // 等页面其余部分落地,再断言这一组确实没渲染(不是还没到)。
    await screen.findByText('billing.usage.promotionalDetails.title');
    expect(screen.queryByText('billing.orders.title')).toBeNull();
  });

  it('renders no group when the order list cannot be fetched', async () => {
    install([]);
    window.electronAPI.billing.listOrders = vi.fn(async () => {
      throw new Error('UNAVAILABLE');
    });

    render(<BillingPage />);
    await screen.findByText('billing.usage.promotionalDetails.title');
    expect(screen.queryByText('billing.orders.title')).toBeNull();
  });

  it('reloads the order history on every checkout phase landing, not only COMPLETED', async () => {
    const listOrders = install([order()]);
    const initialState = { ...checkout.state };

    const { rerender } = render(<BillingPage />);
    await screen.findByText('billing.orders.title');
    const baseline = listOrders.mock.calls.length;

    // 订单一创建(AWAITING_PAYMENT)就已经是一条「待支付」记录,列表必须立刻能看到。
    checkout.state = {
      ...initialState,
      open: true,
      kind: 'CREDIT_TOPUP',
      phase: 'AWAITING_PAYMENT',
    };
    rerender(<BillingPage />);
    await waitFor(() => expect(listOrders.mock.calls.length).toBe(baseline + 1));

    // 轮询落到失败终态时,那一行的状态 chip 也变了 —— 不能等用户手动刷新。
    checkout.state = { ...checkout.state, phase: 'FAILED' };
    rerender(<BillingPage />);
    await waitFor(() => expect(listOrders.mock.calls.length).toBe(baseline + 2));

    // 同一相位重复渲染不重拉:effect 只认「相位变化」,不是每次 render 都打接口。
    rerender(<BillingPage />);
    await screen.findByText('billing.orders.title');
    expect(listOrders.mock.calls.length).toBe(baseline + 2);

    checkout.state = initialState;
  });

  it('maps every payment status onto the checkout wording, not a second vocabulary', async () => {
    install([
      order({ orderId: 'o-succeeded', status: 'SUCCEEDED' }),
      order({ orderId: 'o-created', status: 'CREATED' }),
      order({ orderId: 'o-pending', status: 'PENDING' }),
      order({ orderId: 'o-canceled', status: 'CANCELED' }),
      order({ orderId: 'o-expired', status: 'EXPIRED' }),
      order({ orderId: 'o-failed', status: 'FAILED' }),
    ]);

    render(<BillingPage />);
    await screen.findByText('billing.orders.title');

    expect(screen.getByText('billing.orders.states.completed')).toBeTruthy();
    // CREATED 与 PENDING 都是「还没付成」,与 checkout 的 phaseForOrder 同一判据。
    expect(screen.getAllByText('billing.orders.states.awaitingPayment')).toHaveLength(2);
    expect(screen.getByText('billing.orders.states.canceled')).toBeTruthy();
    expect(screen.getByText('billing.orders.states.expired')).toBeTruthy();
    expect(screen.getByText('billing.orders.states.failed')).toBeTruthy();
  });

  it('drops the payment-method column when no order still carries a payment action', async () => {
    // 终态订单通常不再带 paymentAction;整批都没有时留一列破折号比不留更糟。
    install([order({ paymentAction: null })]);

    render(<BillingPage />);
    await screen.findByText('billing.orders.title');
    expect(screen.queryByText('billing.paymentActions.QR_CODE')).toBeNull();
    expect(screen.queryByText('—')).toBeNull();
  });

  it('keeps the payment-method column when at least one order carries a payment action', async () => {
    install([
      order({
        orderId: 'o-open',
        status: 'CREATED',
        paymentAction: {
          type: 'QR_CODE',
          value: 'https://example.invalid/qr',
          expiresAt: '2026-08-01T14:07:00.000Z',
        },
      }),
      order({ orderId: 'o-done' }),
    ]);

    render(<BillingPage />);
    await screen.findByText('billing.orders.title');
    expect(screen.getByText('billing.paymentActions.QR_CODE')).toBeTruthy();
    // 缺支付方式的那一单占位,不把列整掉。
    expect(screen.getByText('—')).toBeTruthy();
  });

  it('explains truncation instead of offering a pager when the server has older records', async () => {
    install([order()], 'cursor-2');

    render(<BillingPage />);
    expect(await screen.findByText('billing.orders.incomplete:{"count":1}')).toBeTruthy();
  });

  it('does not explain truncation when the server has nothing older', async () => {
    install([order()]);

    render(<BillingPage />);
    await screen.findByText('billing.orders.title');
    expect(screen.queryByText('billing.orders.incomplete:{"count":1}')).toBeNull();
  });
});
