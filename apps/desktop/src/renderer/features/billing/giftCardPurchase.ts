import type {
  BillingCatalog,
  BillingCatalogOffer,
  BillingGiftCardPurchasePolicy,
} from '../../../shared/billing';
import { BILLING_CURRENCY, formatBillingAmount } from './money';
import { isSupportedPurchaseOption, type SupportedPurchaseOption } from './purchaseSupport';

/** 卡面的展示顺序；与分享网页、Platform 后台同一组成品图。 */
export const GIFT_CARD_FACES = ['cindy', 'cat', 'bell', 'leap'] as const;

/** 一个可买的礼品卡价格方案：固定面额，或买家在 minAmount..maxAmount 内自填单张面额。 */
export type GiftCardOfferEntry =
  | {
      kind: 'fixed';
      offer: BillingCatalogOffer & { amount: string };
      purchaseOptions: SupportedPurchaseOption[];
    }
  | {
      kind: 'custom';
      offer: BillingCatalogOffer & { amount: null; minAmount: string; maxAmount: string };
      purchaseOptions: SupportedPurchaseOption[];
    };

/**
 * 目录里能买的礼品卡面额：当前可售、且至少有一个 Desktop 接得住的支付渠道。固定面额按目录
 * 顺序在前；自填面额只取第一个，排在最后（界面上是一个「自定义」选项）。
 * 旧服务端没有 GIFT_CARD 商品时返回空数组，「购买礼品卡」入口就不出现。
 */
export function giftCardOffersOf(catalog: BillingCatalog | null): GiftCardOfferEntry[] {
  if (!catalog) return [];
  const entries = catalog.products
    .filter((product) => product.kind === 'GIFT_CARD')
    .flatMap((product) =>
      product.offers.map((offer) => ({
        offer,
        purchaseOptions: offer.purchaseOptions.filter((option) =>
          isSupportedPurchaseOption(option, product.kind),
        ),
      })),
    )
    // 卡按本区域余额币种发、按它入账，弹窗也按它展示；其它币种的方案（服务端本不允许）不卖，
    // 免得按本币显示、却按方案币种扣款。
    .filter((entry) =>
      entry.offer.purchasable !== false &&
      entry.purchaseOptions.length > 0 &&
      entry.offer.currency.toLowerCase() === BILLING_CURRENCY);
  const fixed: GiftCardOfferEntry[] = [];
  let custom: GiftCardOfferEntry | null = null;
  for (const { offer, purchaseOptions } of entries) {
    if (offer.amount !== null) {
      fixed.push({ kind: 'fixed', offer: { ...offer, amount: offer.amount }, purchaseOptions });
    } else if (!custom && offer.minAmount !== null && offer.maxAmount !== null) {
      custom = {
        kind: 'custom',
        offer: { ...offer, amount: null, minAmount: offer.minAmount, maxAmount: offer.maxAmount },
        purchaseOptions,
      };
    }
  }
  return custom ? [...fixed, custom] : fixed;
}

/**
 * 自填面额实际可填的范围：价格方案范围与服务端给的单张面额范围取交集（存量方案比当前限额宽时
 * 以限额为准）。服务端下单时同样按交集校验。
 */
export function customGiftCardRange(
  offer: { minAmount: string; maxAmount: string },
  policy: Pick<BillingGiftCardPurchasePolicy, 'minFaceValue' | 'maxFaceValue'> | null,
): { min: string; max: string } {
  const pick = (a: string, b: string | null | undefined, larger: boolean) => {
    const left = cents(a);
    const right = b ? cents(b) : null;
    if (left === null || right === null) return a;
    return (larger ? right > left : right < left) ? b! : a;
  };
  return {
    min: pick(offer.minAmount, policy?.minFaceValue, true),
    max: pick(offer.maxAmount, policy?.maxFaceValue, false),
  };
}

/**
 * 买家填的面额：合法时返回规范写法（去掉多余的 0，如 0100 → 100、100.50 → 100.5），否则返回问题。
 * 面额最多两位小数，与卡面和兑换入账的精度一致。
 */
export function parseCustomGiftCardAmount(
  input: string,
  range: { min: string; max: string },
): { amount: string } | { issue: 'empty' | 'format' | 'range' } {
  const value = input.trim();
  if (!value) return { issue: 'empty' };
  const unit = cents(value);
  if (unit === null || unit === 0) return { issue: unit === 0 ? 'range' : 'format' };
  const min = cents(range.min);
  const max = cents(range.max);
  // 范围读不出来时不放行：宁可这次填不了，也不让低于下限或高于上限的面额去下单。
  if (min === null || max === null || unit < min || unit > max) return { issue: 'range' };
  const whole = Math.floor(unit / 100);
  const fraction = String(unit % 100).padStart(2, '0').replace(/0+$/, '');
  return { amount: fraction ? `${whole}.${fraction}` : String(whole) };
}

/**
 * 十进制金额转成分。服务端的金额可能带多位小数（计费投影接受最多 9 位，如 100.000000000），
 * 先去掉小数末尾的 0 再看；去掉后仍超过两位小数的不是合法面额（礼品卡面额最多两位小数）。
 */
function cents(amount: string): number | null {
  const match = /^(\d{1,12})(?:\.(\d{1,9}))?$/.exec(amount);
  if (!match) return null;
  const fraction = (match[2] ?? '').replace(/0+$/, '');
  if (fraction.length > 2) return null;
  return Number(match[1]) * 100 + Number(fraction.padEnd(2, '0'));
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
