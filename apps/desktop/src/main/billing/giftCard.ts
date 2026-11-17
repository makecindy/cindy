import {
  GIFT_CARD_ERROR_CODES,
  giftCardFailureForError,
  projectGiftCardPreview,
  projectGiftCardRedemption,
} from '@cindy/maker-shared/gift-card';

import type { BillingGiftCardFailure } from '../../shared/billing.js';
import { ServerApiError } from '../serverApiClient.desktop.js';

/**
 * 礼品卡响应的投影与业务码在 `@cindy/maker-shared/gift-card`，与 Mobile 共用。
 * 这些业务码只表达卡片状态，不含上游消息、兑换码或账号信息，可以越过脱敏边界
 * 交给 Renderer 分支呈现。
 */
export { GIFT_CARD_ERROR_CODES };
export const projectBillingGiftCardPreview = projectGiftCardPreview;
export const projectBillingGiftCardRedemption = projectGiftCardRedemption;

/** 服务端明确给出的卡片状态返回对应原因；其它失败（网络、5xx、鉴权）返回 null。 */
export function giftCardFailureOf(error: unknown): BillingGiftCardFailure | null {
  if (!(error instanceof ServerApiError)) return null;
  return giftCardFailureForError(error.code, error.statusCode);
}
