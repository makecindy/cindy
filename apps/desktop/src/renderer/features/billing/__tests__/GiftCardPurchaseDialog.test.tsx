// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({
    i18n: { language: 'en', resolvedLanguage: 'en' },
    t: (key: string, params?: Record<string, unknown>) =>
      key === 'billing.giftCardPurchase.termsNote'
        ? '点击「去支付」即表示你已阅读并同意<terms>《礼品卡购买与使用条款》</terms>。'
        : params ? `${key}:${JSON.stringify(params)}` : key,
  }),
}));

const api = vi.hoisted(() => ({ getGiftCardPurchasePolicy: vi.fn() }));
vi.mock('../api', () => ({ billingApi: api }));

import type { BillingGiftCardPurchasePolicy } from '../../../../shared/billing';
import { BILLING_CURRENCY } from '../money';
import { LEGAL_LINKS } from '../../../../shared/legalLinks';
import { GiftCardPurchaseDialog } from '../GiftCardPurchaseDialog';
import {
  customGiftCardRange,
  giftCardCheckoutLine,
  giftCardOffersOf,
  giftCardOrderTotal,
  maxGiftCardQuantity,
  parseCustomGiftCardAmount,
  type GiftCardOfferEntry,
} from '../giftCardPurchase';

const offer = (amount: string): GiftCardOfferEntry => ({
  kind: 'fixed',
  offer: {
    code: `gift_card_${amount}`,
    interval: null,
    currency: BILLING_CURRENCY,
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
    currency: BILLING_CURRENCY,
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
  currency: BILLING_CURRENCY,
  dailyLimit: 5,
  windowHours: 24,
  remaining: 5,
  maxQuantityPerOrder: 5,
  maxOrderAmount: '1000',
  minFaceValue: '100',
  maxFaceValue: '1000',
  emailCooldownSeconds: 60,
  faces: ['cindy', 'cat', 'bell', 'leap'],
  faceCatalog: [],
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
      offers: [
        customOffer.offer,
        offer('100').offer,
        { ...customOffer.offer, code: 'gift_card_custom_2' },
        // 卡按本区域余额币种发与入账：其它币种的方案不卖，免得按本币显示、按方案币种扣款。
        { ...offer('200').offer, code: 'gift_card_foreign', currency: BILLING_CURRENCY === 'usd' ? 'eur' : 'usd' },
      ],
    };
    const entries = giftCardOffersOf({ products: [product] } as never);
    expect(entries.map((entry) => [entry.kind, entry.offer.code])).toEqual([
      ['fixed', 'gift_card_100'],
      ['custom', 'gift_card_custom'],
    ]);
  });
});

// 服务端金额可能带多位小数（如 100.000000000）：与两位小数的写法是同一个金额，不能因此禁用方案、
// 漏掉范围或总额上限；去掉末尾 0 后仍超过两位小数的才不是合法面额。
describe('gift card amounts written at a longer scale', () => {
  it('reads them as the same amount when limiting quantity, range and total', () => {
    expect(maxGiftCardQuantity({ ...policy, maxOrderAmount: '1000.000000000' }, '200.000000000')).toBe(5);
    expect(maxGiftCardQuantity({ ...policy, maxOrderAmount: '1000.000000000' }, '300.000000000')).toBe(3);
    expect(giftCardOrderTotal('100.500000000', 3)).toBe('301.50');
    // 按分用 bigint 精确计算：12 位面额乘以张数也不丢一分（浮点会算成 …91.08）。
    expect(giftCardOrderTotal('999999999999.91', 99)).toBe('98999999999991.09');
    expect(maxGiftCardQuantity({ ...policy, maxOrderAmount: '999999999999.99' }, '333333333333.33')).toBe(3);
    const range = customGiftCardRange(
      { minAmount: '50.000000000', maxAmount: '500.000000000' },
      { minFaceValue: '100.000000000', maxFaceValue: '1000.000000000' },
    );
    expect(range).toEqual({ min: '100.000000000', max: '500.000000000' });
    if (!range) throw new Error('range expected');
    expect(parseCustomGiftCardAmount('99', range)).toEqual({ issue: 'range' });
    expect(parseCustomGiftCardAmount('250.50', range)).toEqual({ amount: '250.5' });
    expect(parseCustomGiftCardAmount('250.505', range)).toEqual({ issue: 'format' });
    expect(maxGiftCardQuantity({ ...policy, maxOrderAmount: '1000' }, '100.001')).toBe(0);
    // 范围读不出来（比分还细）时不放行，不能跳过下限去下单。
    expect(parseCustomGiftCardAmount('1.00', { min: '1.005', max: '500' })).toEqual({ issue: 'range' });
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

  // 评审发现（PR #11412）：订单创建后二维码 / 跳转属于这张订单，付款弹窗的「面额 × 张数」要以订单为准，
// 不能沿用下单前的意图（比如价格刚变了）；摊不成整分时不说面额。
describe('giftCardCheckoutLine', () => {
  const intent = { unitAmount: '100', quantity: 2 };
  it('describes the created order, not the intent it came from', () => {
    expect(giftCardCheckoutLine(intent, null)).toEqual(intent);
    expect(giftCardCheckoutLine(intent, { amount: '200.00', quantity: 2 })).toEqual(intent);
    expect(giftCardCheckoutLine(intent, { amount: '240', quantity: 2 })).toEqual({ unitAmount: '120', quantity: 2 });
    expect(giftCardCheckoutLine(intent, { amount: '300', quantity: 3 })).toEqual({ unitAmount: '100', quantity: 3 });
    expect(giftCardCheckoutLine(null, { amount: '901.00', quantity: 2 })).toEqual({ unitAmount: '450.5', quantity: 2 });
    expect(giftCardCheckoutLine(intent, { amount: '100.01', quantity: 2 })).toBeNull();
  });
});

// 评审发现（PR #11412）：方案范围与单张面额范围不重叠时没有能填的面额，「自定义」不能看起来可选、
  // 实际怎么填都不能付款。
  it('disables a buyer-entered offer whose range does not overlap the allowed face values', async () => {
    expect(customGiftCardRange({ minAmount: '20', maxAmount: '100' }, { minFaceValue: '200', maxFaceValue: '500' })).toBeNull();
    expect(customGiftCardRange({ minAmount: '20', maxAmount: '300' }, { minFaceValue: '200', maxFaceValue: '500' }))
      .toEqual({ min: '200', max: '300' });

    api.getGiftCardPurchasePolicy.mockResolvedValue({ ...policy, minFaceValue: '900', maxFaceValue: '1000' });
    open('小鱼', [customOffer]);
    await waitFor(() => expect(button('billing.amount.custom').hasAttribute('disabled')).toBe(true));
    expect(button('billing.giftCardPurchase.pay').hasAttribute('disabled')).toBe(true);
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

  // 服务端没允许默认的 cindy 卡面：改用第一张允许的卡面下单；只允许本版本不认识的卡面时不能付款，
  // 不退回全部本地卡面（否则提交的卡面会被服务端拒绝）。
  it.each([
    [['cat', 'bell'], 'cat'],
    [['snow'], null],
  ])('only submits a card face the server allows (%j)', async (faces, submitted) => {
    api.getGiftCardPurchasePolicy.mockResolvedValue({ ...policy, faces });
    const { onSubmit } = open();
    await screen.findByText(/billing\.giftCardPurchase\.quantityHint/);
    // 署名默认值在读到规则后才填上：等它到位，付款按钮的状态只取决于卡面。
    const sender = screen.getByPlaceholderText('billing.giftCardPurchase.fields.senderPlaceholder') as HTMLInputElement;
    await waitFor(() => expect(sender.value).toBe('小鱼'));
    expect(screen.queryByRole('button', { name: /billing\.giftCardPurchase\.faces\.cindy/ })).toBeNull();
    const pay = button('billing.giftCardPurchase.pay');
    if (submitted === null) {
      expect(pay.hasAttribute('disabled')).toBe(true);
      return;
    }
    fireEvent.click(pay);
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ faceCode: submitted }), '100');
  });

  // 新服务端加了本版本没有的卡面：按服务端的顺序与名称列出，选中后用服务端底图预览并以它下单，
  // 客户端不用发版。没有服务端卡面详情的卡面仍按内置卡面列出。
  it('offers a card face the server added after this build was released', async () => {
    const snow = {
      code: 'snow',
      names: { en: 'Snow · Night', 'zh-CN': '雪 · 夜色' },
      imageUrl: 'https://model-access.example.com/api/public/gift-cards/faces/snow.webp?v=0123456789ab',
      amount: { x: 80, baseline: 676, size: 228, maxWidth: 480, color: '#F3EDE2' },
    };
    api.getGiftCardPurchasePolicy.mockResolvedValue({ ...policy, faces: ['snow', 'cindy'], faceCatalog: [snow] });
    const { onSubmit } = open();
    await screen.findByText(/billing\.giftCardPurchase\.quantityHint/);
    const sender = screen.getByPlaceholderText('billing.giftCardPurchase.fields.senderPlaceholder') as HTMLInputElement;
    await waitFor(() => expect(sender.value).toBe('小鱼'));

    const choices = screen.getByRole('group', { name: 'billing.giftCardPurchase.fields.face' });
    expect([...choices.querySelectorAll('button')].map((item) => item.getAttribute('aria-label'))).toEqual([
      'Snow · Night',
      'billing.giftCardPurchase.faces.cindy:{"defaultValue":"cindy"}',
    ]);
    expect(button('Snow · Night').getAttribute('aria-pressed')).toBe('true');
    // 预览大卡与缩略图都取服务端底图。
    expect(document.querySelectorAll(`img[src="${snow.imageUrl}"]`).length).toBeGreaterThanOrEqual(2);

    fireEvent.click(button('billing.giftCardPurchase.pay'));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ faceCode: 'snow' }), '100');
  });

  it('states the refund rule before payment', async () => {
    api.getGiftCardPurchasePolicy.mockResolvedValue(policy);
    open();
    await screen.findByText(/billing\.giftCardPurchase\.quantityHint/);
    expect(screen.getByText('billing.giftCardPurchase.refundNote')).toBeTruthy();
  });

  // 依据:付款前须让买家看到并可打开《礼品卡购买与使用条款》;链接走系统浏览器,不在应用内跳转。
  it('links the gift card terms next to the pay button and opens them in the browser', async () => {
    const openExternal = vi.fn(async () => ({ success: true }));
    Object.assign(window, { electronAPI: { ...(window as { electronAPI?: object }).electronAPI, openExternal } });
    api.getGiftCardPurchasePolicy.mockResolvedValue(policy);
    open();
    await screen.findByText(/billing\.giftCardPurchase\.quantityHint/);

    fireEvent.click(screen.getByRole('link', { name: '《礼品卡购买与使用条款》' }));
    expect(openExternal).toHaveBeenCalledWith(LEGAL_LINKS.giftCardTerms);
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

  // 评审发现（PR #11412）：规则请求慢或失败后重试时署名框可以编辑，规则晚到不能把用户填的署名换回默认。
  it('keeps a sender the user typed while the limits were still loading', async () => {
    let resolvePolicy: (value: BillingGiftCardPurchasePolicy) => void = () => undefined;
    api.getGiftCardPurchasePolicy
      .mockRejectedValueOnce(new Error('offline'))
      .mockImplementationOnce(() => new Promise<BillingGiftCardPurchasePolicy>((resolve) => { resolvePolicy = resolve; }));
    open();
    await screen.findByText('billing.giftCardPurchase.loadFailed');
    const sender = screen.getByPlaceholderText('billing.giftCardPurchase.fields.senderPlaceholder') as HTMLInputElement;
    fireEvent.change(sender, { target: { value: '阿杰' } });
    fireEvent.click(button('billing.actions.retry'));
    resolvePolicy(policy);
    await waitFor(() => expect(button('billing.giftCardPurchase.pay').hasAttribute('disabled')).toBe(false));
    expect(sender.value).toBe('阿杰');
  });

  // 评审发现（PR #11412）：规则读到之前输入框按默认上限放行，读到的上限更小时已填内容不会被截断；
  // 付款前要按读到的上限校验，超长时就地说明，不能提交给服务端才被拒。
  it('checks the sender and message against the limits once they load', async () => {
    let resolvePolicy: (value: BillingGiftCardPurchasePolicy) => void = () => undefined;
    api.getGiftCardPurchasePolicy.mockImplementationOnce(
      () => new Promise<BillingGiftCardPurchasePolicy>((resolve) => { resolvePolicy = resolve; }),
    );
    const { onSubmit } = open();
    const sender = screen.getByPlaceholderText('billing.giftCardPurchase.fields.senderPlaceholder');
    const message = screen.getByPlaceholderText('billing.giftCardPurchase.fields.messagePlaceholder');
    fireEvent.change(sender, { target: { value: '一二三四五六' } });
    fireEvent.change(message, { target: { value: '生日快乐，天天开心' } });
    resolvePolicy({ ...policy, maxSenderNameLength: 4, maxMessageLength: 6 });

    await screen.findByText('billing.giftCardPurchase.fields.tooLong:{"max":4}');
    expect(screen.getByText('billing.giftCardPurchase.fields.tooLong:{"max":6}')).toBeTruthy();
    expect(sender.getAttribute('aria-invalid')).toBe('true');
    const pay = button('billing.giftCardPurchase.pay');
    expect(pay.hasAttribute('disabled')).toBe(true);
    fireEvent.click(pay);
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.change(sender, { target: { value: '一二三四' } });
    fireEvent.change(message, { target: { value: '生日快乐' } });
    await waitFor(() => expect(button('billing.giftCardPurchase.pay').hasAttribute('disabled')).toBe(false));
    expect(screen.queryByText(/billing\.giftCardPurchase\.fields\.tooLong/)).toBeNull();
  });

  // 评审发现（PR #11412）：弹窗按本区域余额币种展示与换算，规则币种对不上时不能拿来付款。
  it('does not take payment when the limits are in another currency', async () => {
    api.getGiftCardPurchasePolicy.mockResolvedValue({ ...policy, currency: BILLING_CURRENCY === 'usd' ? 'eur' : 'usd' });
    open();
    await screen.findByText('billing.giftCardPurchase.loadFailed');
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
