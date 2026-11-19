// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({
    i18n: { language: 'en', resolvedLanguage: 'en' },
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key}:${JSON.stringify(params)}` : key,
  }),
}));

const api = vi.hoisted(() => ({ getGiftCardPurchasePolicy: vi.fn() }));
vi.mock('../api', () => ({ billingApi: api }));

import type { BillingGiftCardPurchasePolicy } from '../../../../shared/billing';
import { GiftCardPurchaseDialog } from '../GiftCardPurchaseDialog';
import { giftCardOffersOf, type GiftCardOfferEntry } from '../giftCardPurchase';

const offer = (amount: string): GiftCardOfferEntry => ({
  kind: 'fixed',
  offer: {
    code: `gift_card_${amount}`,
    interval: null,
    currency: 'cny',
    amount,
    minAmount: null,
    maxAmount: null,
    creditAmount: amount,
    rolloverCap: null,
    salesState: 'AVAILABLE',
    purchasable: true,
    unavailableReason: null,
    purchaseOptions: [{ id: 'listing_alipay', provider: 'alipay', capability: 'ONE_TIME_PAYMENT', paymentAction: 'QR_CODE' }],
  },
  purchaseOptions: [{ id: 'listing_alipay', provider: 'alipay', capability: 'ONE_TIME_PAYMENT', paymentAction: 'QR_CODE' }],
});

// 买家自填面额的方案：后台范围 ¥50–¥800，与单张面额范围 ¥100–¥1000 取交集后可填 ¥100–¥800。
const customOffer: GiftCardOfferEntry = {
  kind: 'custom',
  offer: {
    code: 'gift_card_custom',
    interval: null,
    currency: 'cny',
    amount: null,
    minAmount: '50',
    maxAmount: '800',
    creditAmount: null,
    rolloverCap: null,
    salesState: 'AVAILABLE',
    purchasable: true,
    unavailableReason: null,
    purchaseOptions: [{ id: 'listing_alipay', provider: 'alipay', capability: 'ONE_TIME_PAYMENT', paymentAction: 'QR_CODE' }],
  },
  purchaseOptions: [{ id: 'listing_alipay', provider: 'alipay', capability: 'ONE_TIME_PAYMENT', paymentAction: 'QR_CODE' }],
};

// 国内支付宝单笔订单总额上限 ¥1000：¥500 面额一单最多 2 张，¥1000 面额只能 1 张。
const policy: BillingGiftCardPurchasePolicy = {
  currency: 'cny',
  dailyLimit: 5,
  windowHours: 24,
  remaining: 5,
  maxQuantityPerOrder: 5,
  maxOrderAmount: '1000',
  minFaceValue: '100',
  maxFaceValue: '1000',
  emailCooldownSeconds: 60,
  faces: ['cindy', 'cat', 'bell', 'leap'],
  maxSenderNameLength: 40,
  maxMessageLength: 120,
};

function open(accountName: string | null = '小鱼', offers = [offer('100'), offer('500'), offer('1000')]) {
  const onSubmit = vi.fn();
  render(
    <GiftCardPurchaseDialog
      open
      offers={offers}
      accountName={accountName}
      onClose={vi.fn()}
      onSubmit={onSubmit}
    />,
  );
  return { onSubmit };
}

const button = (name: string | RegExp) => screen.getByRole('button', { name });

beforeEach(() => {
  api.getGiftCardPurchasePolicy.mockReset();
});

// 生产入口：计费页用 giftCardOffersOf 从目录取出弹窗里的面额选项。界面只放一个「自定义」，排在固定面额后面。
describe('giftCardOffersOf', () => {
  it('lists fixed face values first and only one buyer-entered option', () => {
    const product = {
      code: 'gift_card', name: 'Cindy 礼品卡', kind: 'GIFT_CARD' as const, level: null, sortOrder: 3,
      offers: [customOffer.offer, offer('100').offer, { ...customOffer.offer, code: 'gift_card_custom_2' }],
    };
    const entries = giftCardOffersOf({ products: [product] } as never);
    expect(entries.map((entry) => [entry.kind, entry.offer.code])).toEqual([
      ['fixed', 'gift_card_100'],
      ['custom', 'gift_card_custom'],
    ]);
  });
});

describe('GiftCardPurchaseDialog', () => {
  it('submits the chosen design, amount, quantity, sender and message', async () => {
    api.getGiftCardPurchasePolicy.mockResolvedValue(policy);
    const { onSubmit } = open();
    await screen.findByText(/billing\.giftCardPurchase\.quantityHint/);

    fireEvent.click(button(/billing\.giftCardPurchase\.faces\.cat/));
    fireEvent.click(button('billing.giftCardPurchase.increase'));
    fireEvent.change(screen.getByPlaceholderText('billing.giftCardPurchase.fields.messagePlaceholder'), {
      target: { value: '  生日快乐  ' },
    });
    fireEvent.click(button('billing.giftCardPurchase.pay'));

    expect(onSubmit).toHaveBeenCalledWith(
      {
        offerCode: 'gift_card_100',
        quantity: 2,
        faceCode: 'cat',
        senderName: '小鱼',
        message: '生日快乐',
        purchaseOptionId: 'listing_alipay',
      },
      '100',
    );
  });

  it('caps the quantity by the per-order total and explains why', async () => {
    api.getGiftCardPurchasePolicy.mockResolvedValue(policy);
    open();
    await screen.findByText(/billing\.giftCardPurchase\.quantityHint/);

    fireEvent.click(button(/^\D*500(\.00)?$/));
    fireEvent.click(button('billing.giftCardPurchase.increase'));
    expect(button('billing.giftCardPurchase.increase').hasAttribute('disabled')).toBe(true);
    expect(screen.getByText(/billing\.giftCardPurchase\.orderAmountCap/)).toBeTruthy();
  });

  it('submits a buyer-entered face value inside the allowed range', async () => {
    api.getGiftCardPurchasePolicy.mockResolvedValue(policy);
    const { onSubmit } = open('小鱼', [offer('100'), customOffer]);
    await screen.findByText(/billing\.giftCardPurchase\.quantityHint/);

    fireEvent.click(button('billing.amount.custom'));
    const input = screen.getByRole('textbox', { name: 'billing.amount.custom' }) as HTMLInputElement;
    expect(document.activeElement).toBe(input);
    // 还没填：不能付款，提示可填范围（后台范围与单张面额范围的交集）。
    expect(button('billing.giftCardPurchase.pay').hasAttribute('disabled')).toBe(true);
    expect(screen.getByText(/billing\.amount\.rangeHint/).textContent).toMatch(/100.*800/);

    fireEvent.change(input, { target: { value: '80' } });
    expect(screen.getByText(/billing\.amount\.rangeError/)).toBeTruthy();
    expect(button('billing.giftCardPurchase.pay').hasAttribute('disabled')).toBe(true);
    fireEvent.change(input, { target: { value: '120.555' } });
    expect(screen.getByText(/billing\.amount\.formatError/)).toBeTruthy();

    // ¥450 一单最多 2 张（单笔总额 ¥1000）。
    fireEvent.change(input, { target: { value: '450.50' } });
    fireEvent.click(button('billing.giftCardPurchase.increase'));
    expect(button('billing.giftCardPurchase.increase').hasAttribute('disabled')).toBe(true);
    fireEvent.click(button('billing.giftCardPurchase.pay'));

    expect(onSubmit).toHaveBeenCalledWith(
      {
        offerCode: 'gift_card_custom',
        amount: '450.5',
        quantity: 2,
        faceCode: 'cindy',
        senderName: '小鱼',
        message: null,
        purchaseOptionId: 'listing_alipay',
      },
      '450.5',
    );
  });

  it('states the refund rule before payment', async () => {
    api.getGiftCardPurchasePolicy.mockResolvedValue(policy);
    open();
    await screen.findByText(/billing\.giftCardPurchase\.quantityHint/);
    expect(screen.getByText('billing.giftCardPurchase.refundNote')).toBeTruthy();
  });

  it('blocks payment once the 24-hour limit is used up', async () => {
    api.getGiftCardPurchasePolicy.mockResolvedValue({ ...policy, remaining: 0 });
    open();

    await screen.findByText(/billing\.giftCardPurchase\.quantityLimitReached/);
    expect(button('billing.giftCardPurchase.pay').hasAttribute('disabled')).toBe(true);
  });

  // 没有昵称时界面上的名字会退成邮箱：不能把邮箱默认当署名发给别人。
  it('does not prefill an email address as the sender', async () => {
    api.getGiftCardPurchasePolicy.mockResolvedValue(policy);
    open('someone@example.com');

    await screen.findByText(/billing\.giftCardPurchase\.quantityHint/);
    const sender = screen.getByPlaceholderText('billing.giftCardPurchase.fields.senderPlaceholder') as HTMLInputElement;
    expect(sender.value).toBe('');
    expect(button('billing.giftCardPurchase.pay').hasAttribute('disabled')).toBe(true);
  });

  it('keeps payment unavailable and offers a retry when the limits cannot be read', async () => {
    api.getGiftCardPurchasePolicy.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(policy);
    open();

    await screen.findByText('billing.giftCardPurchase.loadFailed');
    expect(button('billing.giftCardPurchase.pay').hasAttribute('disabled')).toBe(true);
    fireEvent.click(button('billing.actions.retry'));
    await waitFor(() => expect(button('billing.giftCardPurchase.pay').hasAttribute('disabled')).toBe(false));
  });
});
