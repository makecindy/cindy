import { describe, expect, it } from 'vitest';

import {
  formatGiftCardCode,
  giftCardCodeFromInput,
  giftCardCodeRegion,
  giftCardFailureForError,
  normalizeGiftCardCode,
  projectGiftCardPreview,
  projectGiftCardRedemption,
} from '../giftCard';

const CODE = 'G0123456789ABCDE';

// 与 model-access-server 的归一规则保持一致：同一张卡的各种录入形式必须得到
// 同一个规范兑换码，否则客户端判定有效、服务端却查不到。
describe('gift card redeem code', () => {
  it('resolves typed variants of one code to the same canonical form', () => {
    for (const typed of ['g012-3456-789a-bcde', ' GO12 3456 789A BCDE ', 'G0I2-3456-789A-BCDE', 'G0l23456789ABCDE']) {
      expect(normalizeGiftCardCode(typed)).toBe(CODE);
    }
    expect(formatGiftCardCode(CODE)).toBe('G012-3456-789A-BCDE');
    expect(giftCardCodeRegion(CODE)).toBe('global');
    expect(giftCardCodeRegion('C0123456789ABCDE')).toBe('cn');
    expect(giftCardCodeRegion('X0123456789ABCDE')).toBeNull();
  });

  it('takes the code from a gift page link or an app link the user pasted', () => {
    expect(giftCardCodeFromInput('https://share.cindy.app/gift#G012-3456-789A-BCDE')).toBe(CODE);
    expect(giftCardCodeFromInput('https://share.cindy.app/gift?lang=zh-CN#G012-3456-789A-BCDE ')).toBe(CODE);
    expect(giftCardCodeFromInput('cindy://gift/G0123456789ABCDE')).toBe(CODE);
    expect(giftCardCodeFromInput('cindycn://gift/C012-3456-789A-BCDE')).toBe('C0123456789ABCDE');
  });

  it('does not guess a code out of unrelated text', () => {
    for (const input of ['', 'G012-3456-789A-BCD', 'G012-3456-789A-BCDU', 'https://share.cindy.app/gift', 'https://example.com/#not-a-code', 'cindy://session/G0123456789ABCDE']) {
      expect(giftCardCodeFromInput(input)).toBeNull();
    }
  });
});

const card = {
  status: 'AVAILABLE',
  amount: '20.000000000',
  faceCode: 'cindy',
  senderName: 'Cindy Team',
  message: null,
  claimDeadline: '2026-12-31T16:00:00.000Z',
  validityDays: 90,
  claimedAt: null,
};

describe('gift card server responses', () => {
  it('keeps only the fields the redeem surfaces render', () => {
    // 旧服务端不下发 destination：它发出的卡都是后台发放，进赠送余额。
    expect(projectGiftCardPreview({ card: { ...card, claimedByMembershipId: 'member-1' } }))
      .toEqual({ card: { ...card, destination: 'PROMOTIONAL' } });
    const redeemed = projectGiftCardRedemption({
      card: { ...card, status: 'CLAIMED_BY_YOU', claimedAt: '2026-11-16T12:00:00.000Z' },
      credit: { state: 'PENDING', amount: '20.000000000', expiresAt: null, grantId: 'grant-1' },
    });
    expect(redeemed.credit).toEqual({ state: 'PENDING', amount: '20.000000000', expiresAt: null });
    expect(redeemed.card.status).toBe('CLAIMED_BY_YOU');
  });

  it('rejects a response it cannot render safely instead of showing a wrong amount', () => {
    for (const broken of [
      null,
      {},
      { card: { ...card, amount: '1e3' } },
      { card: { ...card, amount: 20 } },
      { card: { ...card, status: 'SOLD' } },
      { card: { ...card, faceCode: '../x' } },
      { card: { ...card, senderName: '' } },
      { card: { ...card, validityDays: 0 } },
      { card: { ...card, claimDeadline: 'tomorrow' } },
      // 后台发放的卡必须带齐领取截止与有效天数，否则说不清条款。
      { card: { ...card, destination: 'PROMOTIONAL', claimDeadline: null } },
      { card: { ...card, destination: 'PROMOTIONAL', validityDays: null } },
      // 声称是用户买的卡却没有说明到账去向：不能按赠送余额的条款展示。
      { card: { ...card, source: 'PURCHASE' } },
      { card: { ...card, destination: 'GIFT' } },
    ]) {
      expect(() => projectGiftCardPreview(broken)).toThrow();
    }
    expect(() => projectGiftCardRedemption({ card, credit: { state: 'DONE', amount: '20', expiresAt: null } })).toThrow();
  });

  // 用户买的卡进充值余额、永久有效：两端都直接这样告诉用户，所以带了领取截止、有效天数或到账
  // 过期时间的「买来的卡」是自相矛盾的响应，拒绝，不悄悄隐去条款。
  it.each([
    ['a claim deadline', { claimDeadline: '2026-12-31T16:00:00.000Z' }, null],
    ['validity days', { validityDays: 90 }, null],
    ['a missing claim deadline', { claimDeadline: undefined }, null],
    ['an expiring credit', {}, '2027-01-01T00:00:00.000Z'],
  ])('rejects a purchased card that comes with %s', (_label, terms, creditExpiresAt) => {
    const purchased = {
      ...card, source: 'PURCHASE', destination: 'PURCHASED', claimDeadline: null, validityDays: null, ...terms,
    };
    const claimed = { ...purchased, status: 'CLAIMED_BY_YOU', claimedAt: '2026-11-19T08:00:00.000Z' };
    const credit = { state: 'APPLIED', amount: '20', expiresAt: creditExpiresAt };
    expect(() => projectGiftCardRedemption({ card: claimed, credit })).toThrow();
    if (creditExpiresAt === null) expect(() => projectGiftCardPreview({ card: purchased })).toThrow();
  });

  // 来源与去向对不上（买来的卡却进赠送余额，或后台发的卡却进充值余额）时，两端会承诺错误的到账条款：拒绝。
  it.each([
    ['PURCHASE', 'PROMOTIONAL', false],
    ['PLATFORM', 'PURCHASED', false],
    ['GIFT', 'PROMOTIONAL', false],
    ['PLATFORM', 'PROMOTIONAL', true],
    ['PURCHASE', 'PURCHASED', true],
  ])('checks that source %s goes with destination %s', (source, destination, accepted) => {
    const terms = destination === 'PURCHASED' ? { claimDeadline: null, validityDays: null } : {};
    const project = () => projectGiftCardPreview({ card: { ...card, source, destination, ...terms } });
    if (accepted) expect(project().card.destination).toBe(destination);
    else expect(project).toThrow();
  });

  // 买来的卡到账额度就是卡面金额：金额对不上的兑换结果拒绝，写法不同但数值相等的照常接受。
  it.each([
    ['20', true],
    ['20.000000000', true],
    ['1', false],
  ])('accepts a purchased redemption crediting %s only when it equals the face value', (creditAmount, accepted) => {
    const redeemed = {
      ...card, source: 'PURCHASE', destination: 'PURCHASED', claimDeadline: null, validityDays: null,
      status: 'CLAIMED_BY_YOU', claimedAt: '2026-11-19T08:00:00.000Z',
    };
    const project = () => projectGiftCardRedemption({ card: redeemed, credit: { state: 'APPLIED', amount: creditAmount, expiresAt: null } });
    if (accepted) expect(project().credit.amount).toBe(creditAmount);
    else expect(project).toThrow();
  });

  // 卡面按分印：比分更细的卡面或到账金额（即使两者相等）按坏响应处理，免得卡面印 1.005、文字显示 1.01。
  it('rejects gift card amounts finer than a cent, however they are written', () => {
    const redeemed = {
      ...card, source: 'PURCHASE', destination: 'PURCHASED', claimDeadline: null, validityDays: null,
      status: 'CLAIMED_BY_YOU', claimedAt: '2026-11-19T08:00:00.000Z',
    };
    const redeem = (amount: string) => projectGiftCardRedemption({
      card: { ...redeemed, amount }, credit: { state: 'APPLIED', amount, expiresAt: null },
    });
    expect(() => redeem('1.005')).toThrow();
    // 0 元的卡或「成功兑换 0 元」同样自相矛盾。
    expect(() => redeem('0')).toThrow();
    expect(() => projectGiftCardPreview({ card: { ...card, amount: '0.00' } })).toThrow();
    expect(() => projectGiftCardPreview({ card: { ...card, amount: '1.005' } })).toThrow();
    expect(redeem('1.500000000').card.amount).toBe('1.500000000');
  });

  // 买来的卡永久有效：预览或兑换结果里出现「已过期」同样自相矛盾，拒绝而不是告诉用户卡过期了。
  it('rejects a purchased card reported as expired', () => {
    const expired = {
      ...card, source: 'PURCHASE', destination: 'PURCHASED', claimDeadline: null, validityDays: null, status: 'EXPIRED',
    };
    expect(() => projectGiftCardPreview({ card: expired })).toThrow();
    expect(() => projectGiftCardRedemption({ card: expired, credit: { state: 'APPLIED', amount: '20', expiresAt: null } })).toThrow();
    // 后台发的卡过了领取截止照常是「已过期」。
    expect(projectGiftCardPreview({ card: { ...card, status: 'EXPIRED' } }).card.status).toBe('EXPIRED');
  });

  // 用户买的卡进充值余额、永久有效：没有领取截止，也没有有效天数。
  it('accepts a purchased card without a claim deadline or validity days', () => {
    const purchased = {
      ...card, source: 'PURCHASE', destination: 'PURCHASED', claimDeadline: null, validityDays: null,
    };
    expect(projectGiftCardPreview({ card: purchased }).card).toMatchObject({
      destination: 'PURCHASED', claimDeadline: null, validityDays: null,
    });
    expect(projectGiftCardRedemption({
      card: { ...purchased, status: 'CLAIMED_BY_YOU', claimedAt: '2026-11-19T08:00:00.000Z' },
      credit: { state: 'APPLIED', amount: '20', expiresAt: null },
    }).credit).toEqual({ state: 'APPLIED', amount: '20', expiresAt: null });
  });

  it('tells a card state the server reported apart from an outage', () => {
    expect(giftCardFailureForError('GIFT_CARD_ALREADY_CLAIMED', 409)).toBe('ALREADY_CLAIMED');
    expect(giftCardFailureForError('GIFT_CARD_WRONG_REGION', 409)).toBe('WRONG_REGION');
    expect(giftCardFailureForError('GIFT_CARD_NOT_FOUND', 404)).toBe('NOT_FOUND');
    expect(giftCardFailureForError('ANYTHING', 429)).toBe('RATE_LIMITED');
    // 组织身份领不了礼品卡：这是明确的结果，要告诉用户「仅限个人用户领取」，而不是让他「稍后重试」。
    expect(giftCardFailureForError('PERSONAL_ACCOUNT_REQUIRED', 403)).toBe('PERSONAL_REQUIRED');
    // 登录失效、服务故障和不认识的业务码都不是卡片状态。
    for (const [code, status] of [['INTERNAL', 500], ['TOKEN_EXPIRED', 401], ['FORBIDDEN', 403], ['toString', 400]] as const) {
      expect(giftCardFailureForError(code, status)).toBeNull();
    }
  });
});
