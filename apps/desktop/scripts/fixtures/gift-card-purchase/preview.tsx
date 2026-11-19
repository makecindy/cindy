import { mountPage, type UiPageContext } from '../../ui-page/harness';
import { ToastContainer } from '../../../src/renderer/components/ui/toast/ToastContainer';
import { BillingSettingsSection } from '../../../src/renderer/features/billing/BillingPage';
import type {
  BillingPaymentHistoryRecord,
  BillingPaymentOrder,
  BillingPurchasedGiftCard,
} from '../../../src/shared/billing';

// The isolated fixture origin lacks secure-context randomUUID; ids only label in-memory orders.
if (!crypto.randomUUID) {
  let sequence = 0;
  crypto.randomUUID = () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`;
}

const now = '2026-11-19T08:00:00.000Z';
const alipay = { id: 'listing_gift', provider: 'stripe', capability: 'ONE_TIME_PAYMENT' as const, paymentAction: 'REDIRECT' as const };
const giftOffer = (amount: string) => ({
  code: `gift_card_${amount}`, interval: null, currency: 'usd', amount, minAmount: null, maxAmount: null,
  creditAmount: amount, rolloverCap: null, salesState: 'AVAILABLE' as const, purchasable: true,
  unavailableReason: null, purchaseOptions: [alipay],
});
const card = (
  cardId: string,
  overrides: Partial<BillingPurchasedGiftCard> = {},
): BillingPurchasedGiftCard => ({
  cardId, orderId: 'order_new', faceCode: 'cat', amount: '20', currency: 'usd', senderName: 'Yu',
  message: 'Happy birthday! Use Cindy more, work late less.', codeTail: '7KQ2', status: 'UNCLAIMED',
  claimedAt: null, claimedByName: null, purchasedAt: now, email: null, ...overrides,
});
const inAMinute = () => new Date(Date.now() + 60_000).toISOString();
const cards: BillingPurchasedGiftCard[] = [
  card('card_1'),
  card('card_2', {
    codeTail: 'M3XD',
    email: { recipient: 'alex@example.com', status: 'SENT', updatedAt: now, nextAvailableAt: now },
  }),
  card('card_3', { orderId: 'order_bell', faceCode: 'bell', amount: '100', codeTail: 'Q8TR', status: 'CLAIMED', claimedAt: '2026-11-16T09:30:00.000Z', claimedByName: 'Alex', purchasedAt: '2026-11-15T09:30:00.000Z' }),
  card('card_4', { orderId: 'order_leap', faceCode: 'leap', codeTail: '2HNW', status: 'REDEEMED_BY_YOU', claimedAt: '2026-11-12T09:30:00.000Z', purchasedAt: '2026-11-12T09:00:00.000Z' }),
  card('card_5', { orderId: 'order_cindy', faceCode: 'cindy', amount: '200', codeTail: 'Z7PA', status: 'REFUNDED', purchasedAt: '2026-11-10T09:00:00.000Z' }),
  card('card_6', { orderId: 'order_held', faceCode: 'bell', amount: '50', codeTail: 'K4RV', status: 'ON_HOLD', purchasedAt: '2026-11-09T09:00:00.000Z' }),
];
const history: BillingPaymentHistoryRecord[] = [{
  recordId: 'GIFT_CARD:order_new', sourceType: 'GIFT_CARD', quantity: 2, sourceId: 'order_new',
  subscriptionId: null, productName: 'Cindy Gift Card', billingReason: null, amountPaidMinor: 4000, amount: '40.00',
  currency: 'usd', provider: 'stripe', providerTransactionId: 'pi_gift_fixture', paidAt: now, createdAt: now,
  periodStartAt: null, periodEndAt: null, refundSummary: { status: 'UNREFUNDED', refundedMinor: 0, refundedAmount: '0.00' },
}, {
  recordId: 'CREDIT_TOPUP:topup_fixture', sourceType: 'CREDIT_TOPUP', quantity: 1, sourceId: 'topup_fixture',
  subscriptionId: null, productName: null, billingReason: null, amountPaidMinor: 10000, amount: '100.00',
  currency: 'usd', provider: 'stripe', providerTransactionId: 'pi_topup_fixture', paidAt: '2026-11-02T09:12:00.000Z',
  createdAt: '2026-11-02T09:12:00.000Z', periodStartAt: null, periodEndAt: null,
  refundSummary: { status: 'UNREFUNDED', refundedMinor: 0, refundedAmount: '0.00' },
}];

function order(status: BillingPaymentOrder['status']): BillingPaymentOrder {
  return {
    orderId: 'order_new', productCode: 'gift_card', offerCode: 'gift_card_20', amount: '40', currency: 'usd',
    status, productKind: 'GIFT_CARD', quantity: 2, createdAt: now, updatedAt: now,
    paymentAction: status === 'PENDING'
      ? { type: 'REDIRECT', url: 'https://checkout.stripe.com/c/pay/cs_fixture', expiresAt: '2026-11-19T09:00:00.000Z' }
      : null,
  };
}

const purchasedPreview = {
  status: 'AVAILABLE' as const, amount: '20', faceCode: 'cat', senderName: 'Yu',
  message: 'Happy birthday! Use Cindy more, work late less.', destination: 'PURCHASED' as const,
  claimDeadline: null, validityDays: null, claimedAt: null,
};

void mountPage({
  route: '/settings?tab=billing',
  host: (ctx: UiPageContext) => ({
    billing: {
      getCatalog: async () => ({
        products: [
          {
            code: 'credit_topup', name: 'Cindy Balance Top-up', kind: 'CREDIT_TOPUP', level: null, sortOrder: 1,
            offers: [{ ...giftOffer('20'), code: 'credit_topup_20' }],
          },
          {
            code: 'gift_card', name: 'Cindy Gift Card', kind: 'GIFT_CARD', level: null, sortOrder: 2,
            offers: [
              giftOffer('20'), giftOffer('100'), giftOffer('200'),
              // 买家自填面额：只有范围，没有固定面额。
              { ...giftOffer('20'), code: 'gift_card_custom', amount: null, creditAmount: null, minAmount: '20', maxAmount: '500' },
            ],
          },
        ],
      }),
      getCurrentSubscription: async () => ({ subscription: null }),
      getCreditUsage: async () => ({
        available: '186.4',
        plan: { remaining: '40', used: '0', total: '40' },
        purchased: { remaining: '140', used: '0', total: '140' },
        promotional: { remaining: '6.4', used: '0', total: '6.4' },
        promotionalGrants: [], promotionalGrantsComplete: true,
        promotionalGrantConsistency: 'OBSERVED', ledgerUpdatedAt: null,
        scale: 9, observedAt: now,
      }),
      listPaymentHistory: async () => ({ records: history, nextCursor: null }),
      getGiftCardPurchasePolicy: async () => ({
        currency: 'usd', dailyLimit: 5, windowHours: 24, remaining: ctx.case === 'limit' ? 0 : 5,
        maxQuantityPerOrder: 5, maxOrderAmount: null, minFaceValue: '20', maxFaceValue: '500',
        faces: ['cindy', 'cat', 'bell', 'leap'],
        maxSenderNameLength: 40, maxMessageLength: 120, emailCooldownSeconds: 60,
      }),
      listPurchasedGiftCards: async () => ({ cards, nextCursor: null, emailSupported: true }),
      // 发到邮箱：记在内存列表里，状态刷新读回同一份。
      sendPurchasedGiftCardEmail: async ({ cardId, email }: { cardId: string; email: string }) => {
        const index = cards.findIndex((item) => item.cardId === cardId);
        cards[index] = {
          ...cards[index]!,
          email: { recipient: email, status: 'SENDING', updatedAt: new Date().toISOString(), nextAvailableAt: inAMinute() },
        };
        return { ok: true as const, card: cards[index]! };
      },
      revealPurchasedGiftCard: async () => ({
        code: 'G012-3456-789A-BCDE',
        claimUrl: 'https://share.cindy.app/gift?face=cat#G012-3456-789A-BCDE',
      }),
      createGiftCardOrder: async () => order(ctx.case === 'pay' ? 'PENDING' : 'SUCCEEDED'),
      refreshTopup: async () => order(ctx.case === 'pay' ? 'PENDING' : 'SUCCEEDED'),
      getOrder: async () => order(ctx.case === 'pay' ? 'PENDING' : 'SUCCEEDED'),
      openPaymentRedirect: async () => ({ success: true }),
      previewGiftCard: async () => ({ ok: true, card: purchasedPreview }),
      redeemGiftCard: async () => ({
        ok: true, card: { ...purchasedPreview, status: 'CLAIMED_BY_YOU', claimedAt: now },
        credit: { state: 'APPLIED', amount: '20', expiresAt: null },
      }),
    },
  }),
  render: () => (
    <main data-ui-page-subject className="h-screen overflow-auto p-6">
      <BillingSettingsSection accountId="gift-card-preview" accountName="Yu" />
      <ToastContainer />
    </main>
  ),
});
