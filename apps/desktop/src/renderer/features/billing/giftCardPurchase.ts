import type {
  BillingCatalog,
  BillingCatalogOffer,
  BillingGiftCardPurchasePolicy,
} from '../../../shared/billing';
import { formatBillingAmount } from './money';
import { isSupportedPurchaseOption, type SupportedPurchaseOption } from './purchaseSupport';

/** 卡面的展示顺序；与分享网页、Platform 后台同一组成品图。 */
export const GIFT_CARD_FACES = ['cindy', 'cat', 'bell', 'leap'] as const;

export type GiftCardOfferEntry = {
  offer: BillingCatalogOffer & { amount: string };
  purchaseOptions: SupportedPurchaseOption[];
};

/**
 * 目录里能买的礼品卡面额：固定面额、当前可售、且至少有一个 Desktop 接得住的支付渠道。
 * 旧服务端没有 GIFT_CARD 商品时返回空数组，「购买礼品卡」入口就不出现。
 */
export function giftCardOffersOf(catalog: BillingCatalog | null): GiftCardOfferEntry[] {
  if (!catalog) return [];
  return catalog.products
    .filter((product) => product.kind === 'GIFT_CARD')
    .flatMap((product) =>
      product.offers.map((offer) => ({
        offer,
        purchaseOptions: offer.purchaseOptions.filter((option) =>
          isSupportedPurchaseOption(option, product.kind),
        ),
      })),
    )
    .filter((entry): entry is GiftCardOfferEntry =>
      entry.offer.amount !== null &&
      entry.offer.purchasable !== false &&
      entry.purchaseOptions.length > 0,
    );
}

/** 十进制金额转成分（两位小数以内）；礼品卡面额最多两位小数。 */
function cents(amount: string): number | null {
  const match = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(amount);
  if (!match) return null;
  return Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
}

/**
 * 这个面额这一单最多能买几张：取单笔张数上限、24 小时内剩余张数、单笔总额上限三者最小。
 * 只用来限制界面上的可选张数，服务端仍会校验。
 */
export function maxGiftCardQuantity(
  policy: BillingGiftCardPurchasePolicy,
  unitAmount: string,
): number {
  let max = Math.min(policy.maxQuantityPerOrder, policy.remaining);
  if (policy.maxOrderAmount !== null) {
    const unit = cents(unitAmount);
    const cap = cents(policy.maxOrderAmount);
    if (unit === null || cap === null || unit === 0) return 0;
    max = Math.min(max, Math.floor(cap / unit));
  }
  return Math.max(0, max);
}

/** 面额 × 张数，返回十进制字符串（两位小数以内）。 */
export function giftCardOrderTotal(unitAmount: string, quantity: number): string {
  const unit = cents(unitAmount);
  if (unit === null) return unitAmount;
  const total = unit * quantity;
  const whole = Math.floor(total / 100);
  const fraction = total % 100;
  return fraction === 0 ? String(whole) : `${whole}.${String(fraction).padStart(2, '0')}`;
}

/**
 * 署名默认用账号昵称。没有昵称时界面上的名字会退成邮箱：不能把邮箱当署名发给别人，
 * 留空让用户自己填。
 */
export function defaultGiftCardSender(name: string | null | undefined, maxLength: number): string {
  const value = name?.trim() ?? '';
  if (!value || value.includes('@')) return '';
  return value.length <= maxLength ? value : '';
}

/**
 * 礼品卡金额照卡面的写法：整数面额不带小数（$20、¥100），其余与计费页同一格式。
 */
export function formatGiftCardAmount(amount: string, currency: string, locale?: string): string {
  const whole = /^(\d+)(?:\.0+)?$/.exec(amount.trim());
  if (!whole) return formatBillingAmount(amount, currency, locale);
  try {
    const normalized = currency.toUpperCase();
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: normalized,
      ...(normalized === 'USD' ? { currencyDisplay: 'narrowSymbol' as const } : {}),
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(Number(whole[1]));
  } catch {
    return formatBillingAmount(amount, currency, locale);
  }
}
