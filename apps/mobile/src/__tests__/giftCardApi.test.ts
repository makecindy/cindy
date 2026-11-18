import { describe, expect, it, vi } from 'vitest';
import { createGiftCardApi } from '@/gift-card/giftCardApi';

const CODE = 'G0123456789ABCDE';
const card = {
  status: 'AVAILABLE', amount: '20', faceCode: 'cindy', senderName: 'Cindy Team', message: null,
  claimDeadline: '2026-12-31T16:00:00.000Z', validityDays: 90, claimedAt: null,
};
const apiError = (code: string, status: number) => Object.assign(new Error(code), { code, status });

// 契约：兑换码只在请求体里；服务端给出的卡片状态是「结果」，网络与服务故障是「异常」。
// 两者混淆会让用户在断网时看到「兑换码无效」，或在卡已被领走时被要求稍后重试。
describe('mobile gift card api', () => {
  it('sends the code in the body only and returns the projected card', async () => {
    const post = vi.fn().mockResolvedValue({ card: { ...card, internal: 'x' } });
    const signal = new AbortController().signal;
    await expect(createGiftCardApi(post).preview(CODE, signal)).resolves.toEqual({ ok: true, card });
    expect(post).toHaveBeenCalledWith('/api/gift-cards/preview', { code: CODE }, signal);
    expect(post.mock.calls[0][0]).not.toContain(CODE);
  });

  it('returns the credit state after redeeming', async () => {
    const post = vi.fn().mockResolvedValue({
      card: { ...card, status: 'CLAIMED_BY_YOU', claimedAt: '2026-11-16T12:00:00.000Z' },
      credit: { state: 'APPLIED', amount: '20', expiresAt: '2027-02-14T12:00:00.000Z' },
    });
    const result = await createGiftCardApi(post).redeem(CODE);
    expect(post).toHaveBeenCalledWith('/api/gift-cards/redeem', { code: CODE }, undefined);
    expect(result).toMatchObject({ ok: true, credit: { state: 'APPLIED', amount: '20' } });
  });

  it('reports card states the server named as results', async () => {
    for (const [code, status, reason] of [
      ['GIFT_CARD_NOT_FOUND', 404, 'NOT_FOUND'],
      ['GIFT_CARD_WRONG_REGION', 409, 'WRONG_REGION'],
      ['GIFT_CARD_ALREADY_CLAIMED', 409, 'ALREADY_CLAIMED'],
      ['GIFT_CARD_EXPIRED', 409, 'EXPIRED'],
      ['GIFT_CARD_VOIDED', 409, 'VOIDED'],
      ['RATE_LIMITED', 429, 'RATE_LIMITED'],
      // 组织身份领不了：要让界面说明「仅限个人用户领取」，不能混进「稍后重试」。
      ['PERSONAL_ACCOUNT_REQUIRED', 403, 'PERSONAL_REQUIRED'],
    ] as const) {
      const api = createGiftCardApi(vi.fn().mockRejectedValue(apiError(code, status)));
      await expect(api.preview(CODE)).resolves.toEqual({ ok: false, reason });
      await expect(api.redeem(CODE)).resolves.toEqual({ ok: false, reason });
    }
  });

  it('lets outages, auth failures and unreadable responses surface as errors', async () => {
    for (const error of [apiError('NETWORK_UNAVAILABLE', 0), apiError('INTERNAL', 500), apiError('FORBIDDEN', 403), new Error('OWNER_CHANGED')]) {
      const api = createGiftCardApi(vi.fn().mockRejectedValue(error));
      await expect(api.preview(CODE)).rejects.toBe(error);
      await expect(api.redeem(CODE)).rejects.toBe(error);
    }
    await expect(createGiftCardApi(vi.fn().mockResolvedValue({ card: { ...card, amount: 'free' } })).preview(CODE)).rejects.toThrow();
    // 领取成功但响应读不出入账结果：按结果未知处理，不能当成成功展示。
    await expect(createGiftCardApi(vi.fn().mockResolvedValue({ card })).redeem(CODE)).rejects.toThrow();
  });
});
