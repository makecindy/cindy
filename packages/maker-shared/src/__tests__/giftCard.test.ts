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
    expect(projectGiftCardPreview({ card: { ...card, claimedByMembershipId: 'member-1' } })).toEqual({ card });
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
    ]) {
      expect(() => projectGiftCardPreview(broken)).toThrow();
    }
    expect(() => projectGiftCardRedemption({ card, credit: { state: 'DONE', amount: '20', expiresAt: null } })).toThrow();
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
