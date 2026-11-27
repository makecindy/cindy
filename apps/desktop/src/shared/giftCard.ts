/**
 * 礼品卡兑换码的客户端侧规则。正本在 `@cindy/maker-shared/gift-card`，与 Mobile 共用；
 * 这里保留 Desktop 内部的引用路径。
 */
export {
  formatGiftCardCode,
  giftCardCodeFromInput,
  giftCardCodeRegion,
  normalizeGiftCardCode,
  type GiftCardRegion,
} from '@cindy/maker-shared/gift-card';
