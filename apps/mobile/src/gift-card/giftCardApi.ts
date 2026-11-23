import {
  giftCardFailureForError,
  projectGiftCardPreview,
  projectGiftCardRedemption,
  type GiftCard,
  type GiftCardCredit,
  type GiftCardFailure,
} from '@cindy/maker-shared/gift-card';

/**
 * 手机端的礼品卡接口（model-access-server `/api/gift-cards/*`，个人身份）。
 * 兑换码只放在请求体里。服务端明确给出的卡片状态、以及「当前是组织身份不能领取」
 * 作为结果返回；网络、登录失效和服务故障照常抛出，由界面按「暂时无法兑换」处理。
 */
export type GiftCardPost = (path: string, body: { code: string }, signal?: AbortSignal) => Promise<unknown>;

export type GiftCardPreviewResult =
  { ok: true; card: GiftCard } | { ok: false; reason: GiftCardFailure };
export type GiftCardRedeemResult =
  | { ok: true; card: GiftCard; credit: GiftCardCredit }
  | { ok: false; reason: GiftCardFailure };

function failureOf(error: unknown): GiftCardFailure | null {
  const { code, status } = (error ?? {}) as { code?: unknown; status?: unknown };
  if (typeof code !== 'string' || typeof status !== 'number') return null;
  return giftCardFailureForError(code, status);
}

export function createGiftCardApi(post: GiftCardPost) {
  return {
    async preview(code: string, signal?: AbortSignal): Promise<GiftCardPreviewResult> {
      let body: unknown;
      try {
        body = await post('/api/gift-cards/preview', { code }, signal);
      } catch (error) {
        const reason = failureOf(error);
        if (reason) return { ok: false, reason };
        throw error;
      }
      return { ok: true, ...projectGiftCardPreview(body) };
    },
    /** 领取是幂等的：结果未知时用同一个兑换码再调一次，不会重复入账。 */
    async redeem(code: string, signal?: AbortSignal): Promise<GiftCardRedeemResult> {
      let body: unknown;
      try {
        body = await post('/api/gift-cards/redeem', { code }, signal);
      } catch (error) {
        const reason = failureOf(error);
        if (reason) return { ok: false, reason };
        throw error;
      }
      return { ok: true, ...projectGiftCardRedemption(body) };
    },
  };
}

export type GiftCardApi = ReturnType<typeof createGiftCardApi>;
