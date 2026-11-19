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

const api = vi.hoisted(() => ({ previewGiftCard: vi.fn(), redeemGiftCard: vi.fn() }));
vi.mock('../api', () => ({ billingApi: api }));

import type { BillingGiftCard } from '../../../../shared/billing';
import { GiftCardRedeemDialog } from '../GiftCardRedeemDialog';

const CODE = 'G0123456789ABCDE';
const card: BillingGiftCard = {
  status: 'AVAILABLE',
  amount: '20',
  faceCode: 'cindy',
  senderName: 'Cindy Team',
  message: 'Enjoy',
  destination: 'PROMOTIONAL',
  claimDeadline: '2026-12-31T16:00:00.000Z',
  validityDays: 90,
  claimedAt: null,
};

function open(initialCode: string | null = null) {
  const onClose = vi.fn();
  const onRedeemed = vi.fn();
  const onCodeUnusable = vi.fn();
  render(
    <GiftCardRedeemDialog
      open
      initialCode={initialCode}
      onClose={onClose}
      onRedeemed={onRedeemed}
      onCodeUnusable={onCodeUnusable}
    />,
  );
  return { onClose, onRedeemed, onCodeUnusable };
}

const click = (name: string) => fireEvent.click(screen.getByRole('button', { name }));

beforeEach(() => {
  api.previewGiftCard.mockReset();
  api.redeemGiftCard.mockReset();
});

describe('GiftCardRedeemDialog', () => {
  it('previews a pasted gift link, redeems after confirmation and reports the credit', async () => {
    api.previewGiftCard.mockResolvedValue({ ok: true, card });
    api.redeemGiftCard.mockResolvedValue({
      ok: true,
      card: { ...card, status: 'CLAIMED_BY_YOU', claimedAt: '2026-11-16T12:00:00.000Z' },
      credit: { state: 'APPLIED', amount: '20', expiresAt: '2027-02-14T12:00:00.000Z' },
    });
    const { onClose, onRedeemed } = open();

    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'https://share.cindy.app/gift#G012-3456-789A-BCDE' },
    });
    click('billing.giftCard.continue');

    // 确认步骤展示来源与条款；此时还没有领取。
    await screen.findByText('billing.giftCard.confirmTitle');
    expect(api.previewGiftCard).toHaveBeenCalledWith(CODE);
    expect(screen.getByText('billing.giftCard.from:{"sender":"Cindy Team"}')).toBeTruthy();
    expect(screen.getByText('Enjoy')).toBeTruthy();
    expect(screen.getByText('billing.giftCard.fields.validityValue:{"count":90}')).toBeTruthy();
    expect(api.redeemGiftCard).not.toHaveBeenCalled();

    click('billing.giftCard.confirmAction');

    await screen.findByText(/^billing\.giftCard\.doneTitle/);
    expect(api.redeemGiftCard).toHaveBeenCalledWith(CODE);
    // 带上领取的码（规范写法），计费页据此清掉「我买的礼品卡」里缓存的这张卡的码。
    expect(onRedeemed).toHaveBeenCalledExactlyOnceWith(CODE);
    expect(onClose).not.toHaveBeenCalled();
    click('billing.giftCard.done');
    expect(onClose).toHaveBeenCalledOnce();
  });

  // 用户自己买的卡进充值余额、永久有效：不能照搬后台卡「有效 N 天 / 领取截止 / 赠送余额」的条款。
  it('states top-up balance and no expiry for a card someone bought', async () => {
    const purchased: BillingGiftCard = {
      ...card, destination: 'PURCHASED', claimDeadline: null, validityDays: null,
    };
    api.previewGiftCard.mockResolvedValue({ ok: true, card: purchased });
    api.redeemGiftCard.mockResolvedValue({
      ok: true,
      card: { ...purchased, status: 'CLAIMED_BY_YOU', claimedAt: '2026-11-19T12:00:00.000Z' },
      credit: { state: 'APPLIED', amount: '20', expiresAt: null },
    });
    open(CODE);

    await screen.findByText('billing.giftCard.confirmTitle');
    expect(screen.getByText('billing.balance.purchased')).toBeTruthy();
    expect(screen.getByText('billing.giftCard.fields.validityPermanent')).toBeTruthy();
    expect(screen.queryByText('billing.giftCard.fields.claimBy')).toBeNull();
    expect(screen.queryByText('billing.balance.promotional')).toBeNull();

    click('billing.giftCard.confirmAction');
    await screen.findByText('billing.giftCard.doneDescriptionPurchased');
  });

  // 买来的卡作废可能只是退款或拒付还在处理，之后还会恢复：只说目前不能领取，不说已作废。
  it('tells the recipient a voided bought card cannot be redeemed right now', async () => {
    const purchased: BillingGiftCard = {
      ...card, destination: 'PURCHASED', claimDeadline: null, validityDays: null,
    };
    api.previewGiftCard.mockResolvedValue({ ok: true, card: { ...purchased, status: 'VOIDED' } });
    open(CODE);
    await screen.findByText('billing.giftCard.errors.voidedPurchased');
    expect(screen.queryByText('billing.giftCard.errors.voided')).toBeNull();
  });

  it('says so when a bought card is voided while the recipient confirms', async () => {
    api.previewGiftCard.mockResolvedValue({
      ok: true, card: { ...card, destination: 'PURCHASED', claimDeadline: null, validityDays: null },
    });
    api.redeemGiftCard.mockResolvedValue({ ok: false, reason: 'VOIDED' });
    open(CODE);
    await screen.findByText('billing.giftCard.confirmTitle');
    click('billing.giftCard.confirmAction');
    await screen.findByText('billing.giftCard.errors.voidedPurchased');
  });

  // 评审发现（PR #11412）：买家缓存过码的卡在别处兑换后，查询结果「已是你的」也要让计费页清掉缓存的码
  // 并重读列表；被别人领走、作废、过期（查询或领取时）同样。
  it.each([
    ['already yours', { ok: true, card: { ...card, status: 'CLAIMED_BY_YOU', claimedAt: '2026-11-19T08:00:00.000Z' } }],
    ['claimed by someone else', { ok: true, card: { ...card, status: 'CLAIMED' } }],
    ['voided', { ok: true, card: { ...card, status: 'VOIDED' } }],
    ['reported as already claimed', { ok: false, reason: 'ALREADY_CLAIMED' }],
  ])('reports a code that can no longer be used when the preview says it is %s', async (_label, preview) => {
    api.previewGiftCard.mockResolvedValue(preview);
    const { onCodeUnusable, onRedeemed } = open(CODE);
    await waitFor(() => expect(onCodeUnusable).toHaveBeenCalledExactlyOnceWith(CODE));
    expect(onRedeemed).not.toHaveBeenCalled();
  });

  it.each([
    ['ALREADY_CLAIMED', 'billing.giftCard.errors.alreadyClaimed', true],
    ['RATE_LIMITED', 'billing.giftCard.errors.rateLimited', false],
  ] as const)('reports a code that fails to redeem with %s only when it can no longer be used', async (reason, text, unusable) => {
    api.previewGiftCard.mockResolvedValue({ ok: true, card });
    api.redeemGiftCard.mockResolvedValue({ ok: false, reason });
    const { onCodeUnusable } = open(CODE);
    await screen.findByText('billing.giftCard.confirmTitle');
    click('billing.giftCard.confirmAction');
    await screen.findByText(text);
    if (unusable) expect(onCodeUnusable).toHaveBeenCalledExactlyOnceWith(CODE);
    else expect(onCodeUnusable).not.toHaveBeenCalled();
  });

  it('goes straight to confirmation for a code handed over by an app link', async () => {
    api.previewGiftCard.mockResolvedValue({ ok: true, card });
    open(CODE);

    await screen.findByText('billing.giftCard.confirmTitle');
    expect(api.previewGiftCard).toHaveBeenCalledWith(CODE);
  });

  it('prints the amount on the card face instead of repeating it below', async () => {
    api.previewGiftCard.mockResolvedValue({ ok: true, card: { ...card, amount: '19.90' } });
    open(CODE);

    // 整张卡对读屏是一张带金额的图；卡面上印的是去掉末尾 0 的写法。
    const face = await screen.findByRole('img', { name: /^billing\.giftCard\.cardLabel/ });
    const printed = face.querySelector('[data-gift-card-amount]');
    expect(printed?.getAttribute('data-gift-card-amount')).toMatch(/^.19\.9$/);
    expect(printed?.querySelectorAll('path')).toHaveLength(5);
    expect(document.querySelector('.text-28')).toBeNull();
  });

  it('lays the amount out on a face this build does not know as the default face', async () => {
    api.previewGiftCard.mockResolvedValue({ ok: true, card: { ...card, faceCode: 'future-face' } });
    open(CODE);

    const face = await screen.findByRole('img', { name: /^billing\.giftCard\.cardLabel/ });
    expect(face.querySelectorAll('[data-gift-card-amount] path')).toHaveLength(3);
  });

  it('explains which edition a card belongs to and keeps the input for another try', async () => {
    api.previewGiftCard.mockResolvedValue({ ok: false, reason: 'WRONG_REGION' });
    open();

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'C012-3456-789A-BCDE' } });
    click('billing.giftCard.continue');

    await screen.findByText('billing.giftCard.errors.wrongRegionCn');
    expect(screen.getByRole('textbox')).toBeTruthy();
    expect(api.redeemGiftCard).not.toHaveBeenCalled();
  });

  // 规则：礼品卡仅限个人用户领取。服务端拒绝组织身份时要如实说明，
  // 不能显示成「暂时无法兑换，请稍后重试」。
  it('tells an organization identity that gift cards are for personal accounts', async () => {
    api.previewGiftCard.mockResolvedValue({ ok: false, reason: 'PERSONAL_REQUIRED' });
    open(CODE);
    await screen.findByText('billing.giftCard.errors.personalRequired');
    expect(api.redeemGiftCard).not.toHaveBeenCalled();
  });

  it('rejects text that is not a redeem code without asking the server', async () => {
    open();

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'not a code' } });
    click('billing.giftCard.continue');

    await screen.findByText('billing.giftCard.errors.notFound');
    expect(api.previewGiftCard).not.toHaveBeenCalled();
  });

  it('stays on confirmation when the redeem outcome is unknown so the user can retry safely', async () => {
    api.previewGiftCard.mockResolvedValue({ ok: true, card });
    api.redeemGiftCard.mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce({
      ok: true,
      card: { ...card, status: 'CLAIMED_BY_YOU' },
      credit: { state: 'PENDING', amount: '20', expiresAt: null },
    });
    const { onRedeemed } = open(CODE);

    await screen.findByText('billing.giftCard.confirmTitle');
    click('billing.giftCard.confirmAction');
    await screen.findByText('billing.giftCard.errors.failed');
    expect(onRedeemed).not.toHaveBeenCalled();

    click('billing.giftCard.confirmAction');
    // 入账仍在途中：说明已领取、无需重复领取，而不是报失败。
    await screen.findByText('billing.giftCard.pendingTitle');
    await waitFor(() => expect(onRedeemed).toHaveBeenCalledOnce());
  });

  // 评审发现（PR #10964）：领取请求在途时打开另一张礼品卡链接会重置弹窗，第一张卡的成功
  // 回包被忽略，到账提示和余额刷新都不出现。
  it('keeps the card being redeemed when another gift link arrives mid-request', async () => {
    api.previewGiftCard.mockResolvedValue({ ok: true, card });
    let finish!: (value: unknown) => void;
    api.redeemGiftCard.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const onRedeemed = vi.fn();
    const dialog = (code: string) => (
      <GiftCardRedeemDialog open initialCode={code} onClose={vi.fn()} onRedeemed={onRedeemed} />
    );
    const view = render(dialog(CODE));

    await screen.findByText('billing.giftCard.confirmTitle');
    click('billing.giftCard.confirmAction');
    await waitFor(() => expect(api.redeemGiftCard).toHaveBeenCalledWith(CODE));
    view.rerender(dialog('G0123456789ABCDF'));
    finish({
      ok: true,
      card: { ...card, status: 'CLAIMED_BY_YOU' },
      credit: { state: 'APPLIED', amount: '20', expiresAt: '2027-02-14T16:00:00.000Z' },
    });

    await waitFor(() => expect(onRedeemed).toHaveBeenCalledOnce());
    // 新链接没有接手弹窗：只查询过正在领取的那张卡。
    expect(api.previewGiftCard).toHaveBeenCalledTimes(1);
    expect(api.previewGiftCard).toHaveBeenCalledWith(CODE);
  });
});
