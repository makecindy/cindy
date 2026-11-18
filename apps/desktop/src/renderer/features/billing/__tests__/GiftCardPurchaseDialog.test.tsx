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
import type { GiftCardOfferEntry } from '../giftCardPurchase';

const offer = (amount: string): GiftCardOfferEntry => ({
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

// 国内支付宝单笔订单总额上限 ¥1000：¥500 面额一单最多 2 张，¥1000 面额只能 1 张。
const policy: BillingGiftCardPurchasePolicy = {
  currency: 'cny',
  dailyLimit: 5,
  windowHours: 24,
  remaining: 5,
  maxQuantityPerOrder: 5,
  maxOrderAmount: '1000',
  faces: ['cindy', 'cat', 'bell', 'leap'],
  maxSenderNameLength: 40,
  maxMessageLength: 120,
};

function open(accountName: string | null = '小鱼') {
  const onSubmit = vi.fn();
  render(
    <GiftCardPurchaseDialog
      open
      offers={[offer('100'), offer('500'), offer('1000')]}
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
