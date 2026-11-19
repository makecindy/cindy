import type {
  BillingCatalog,
  BillingCatalogOffer,
  BillingCatalogProduct,
  BillingCurrentSubscription,
  BillingFulfillmentStatus,
  BillingGiftCardPurchasePolicy,
  BillingOrderList,
  BillingPaymentHistory,
  BillingPaymentHistoryRecord,
  BillingPaymentAction,
  BillingPaymentOrder,
  BillingPaymentOrderStatus,
  BillingPendingPlanChange,
  BillingPlanChange,
  BillingPlanChangeStatus,
  BillingPlanChangeTargetPlan,
  BillingPurchaseOption,
  BillingPurchasedGiftCard,
  BillingPurchasedGiftCardEmail,
  BillingPurchasedGiftCardList,
  BillingPurchasedGiftCardStatus,
  BillingSubscription,
  BillingSubscriptionStatus,
} from '../../shared/billing.js';
import type {
  ModelAccessBalance,
  ModelAccessCreditPoolUsage,
  ModelAccessCreditUsage,
  ModelAccessPromotionalGrantState,
  ModelAccessPromotionalGrantSource,
  ModelAccessPromotionalGrantUsage,
} from '../../shared/modelAccess.js';
import { formatGiftCardCode, normalizeGiftCardCode } from '@cindy/maker-shared/gift-card';
import { BILLING_CURRENCY } from '../../shared/billingCurrency.js';

import { isAllowedBillingRedirectUrl, isAllowedStripeBillingPortalUrl } from './paymentRedirect.js';

const MAX_ID_LENGTH = 128;
const MAX_NAME_LENGTH = 128;
const MAX_GIFT_SENDER_LENGTH = 80;
const MAX_CURSOR_LENGTH = 512;
const MAX_QR_VALUE_LENGTH = 4_096;
const MAX_PROMOTIONAL_GRANTS = 1_000;
const CODE_PATTERN = /^[a-z][a-z0-9_]{1,63}$/;
const CURRENCY_PATTERN = /^[a-z]{3}$/;
const DECIMAL_PATTERN = /^(0|[1-9]\d{0,14})(?:\.\d{1,9})?$/;
const LEDGER_DECIMAL_PATTERN = /^-?(?:0|[1-9]\d{0,9})(?:\.\d{1,9})?$/;
const ISO_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const RFC3339_UTC_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/;
const MAX_LEDGER_SCALED_AMOUNT = 9_000_000_000_000_000_000n;
const PROMOTIONAL_GRANT_STATES = new Set<ModelAccessPromotionalGrantState>([
  'active',
  'depleted',
  'expired',
  'voided',
]);

const PAYMENT_ORDER_STATUSES = new Set<BillingPaymentOrderStatus>([
  'CREATED',
  'PENDING',
  'SUCCEEDED',
  'FAILED',
  'CANCELED',
  'EXPIRED',
]);
const SUBSCRIPTION_STATUSES = new Set<BillingSubscriptionStatus>([
  'INCOMPLETE',
  'INCOMPLETE_EXPIRED',
  'TRIALING',
  'ACTIVE',
  'PAST_DUE',
  'UNPAID',
  'CANCELED',
  'PAUSED',
]);
const FULFILLMENT_STATUSES = new Set<BillingFulfillmentStatus>([
  'NOT_STARTED',
  'PENDING',
  'SUCCEEDED',
  'FAILED',
]);
const SUPPORTED_PROVIDERS = new Set(['alipay', 'stripe']);
const SUBSCRIPTION_CAPABILITIES = new Set([
  'MERCHANT_INITIATED_MANDATE',
  'PROVIDER_MANAGED_SUBSCRIPTION',
]);
const PLAN_CHANGE_STATUSES = new Set<BillingPlanChangeStatus>([
  'QUOTED',
  'PENDING_PROVIDER',
  'AWAITING_PAYMENT',
  'SCHEDULED',
  'APPLIED',
  'CANCELED',
  'FAILED',
  'EXPIRED',
]);
const MAX_QUOTED_AMOUNT_MINOR = 9_007_199_254_740_991;

function invalidResponse(): never {
  throw new Error('invalid billing response');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function boundedString(value: unknown, maxLength = MAX_ID_LENGTH): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength ? value : null;
}

function code(value: unknown): string | null {
  return typeof value === 'string' && CODE_PATTERN.test(value) ? value : null;
}

function decimal(value: unknown): string | null {
  return typeof value === 'string' && DECIMAL_PATTERN.test(value) ? value : null;
}

/**
 * 去掉字符串末尾的 0。用循环而不是 /0+$/：后者遇到一长串 0 时匹配耗时随长度平方增长
 * （CodeQL「对不受控数据使用多项式正则」）。
 */
function trimTrailingZeros(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 48) end -= 1;
  return value.slice(0, end);
}

/**
 * 两个 decimal() 金额是否相等：去掉小数末尾的 0 再比（如 20 与 20.000000000）。
 * DECIMAL_PATTERN 不允许整数部分前导 0，所以只需处理小数部分。
 */
function sameDecimal(left: string, right: string): boolean {
  const normalize = (value: string) => {
    if (!value.includes('.')) return value;
    const trimmed = trimTrailingZeros(value);
    return trimmed.endsWith('.') ? trimmed.slice(0, -1) : trimmed;
  };
  return normalize(left) === normalize(right);
}

/**
 * 礼品卡金额（面额、自填范围、单张面额范围）：去掉小数末尾的 0 后最多两位小数，与卡面和兑换入账
 * 精度一致。更细的值购买弹窗无法按分比较，必须在读响应时挡掉，不能让界面跳过范围校验。
 */
function isGiftCardMoney(value: string): boolean {
  const [whole = '', fraction = ''] = value.split('.');
  // 整数部分最多 12 位：与购买弹窗按分换算（cents）、下单请求的面额校验同一范围。礼品卡金额必须
  // 大于 0：0 元的方案、上限或卡不能拿来卖或展示。
  return whole.length <= 12 && trimTrailingZeros(fraction).length <= 2 && /[1-9]/.test(value);
}

/** 读礼品卡金额字段：合法十进制且满足 isGiftCardMoney，否则为 null。 */
function giftCardMoney(input: unknown): string | null {
  const parsed = decimal(input);
  return parsed !== null && isGiftCardMoney(parsed) ? parsed : null;
}

function ledgerDecimal(value: unknown): { source: string; scaled: bigint } | null {
  if (typeof value !== 'string' || !LEDGER_DECIMAL_PATTERN.test(value)) return null;
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [whole, fraction = ''] = unsigned.split('.');
  const scaled = BigInt(whole) * 1_000_000_000n + BigInt(fraction.padEnd(9, '0') || '0');
  if (scaled > MAX_LEDGER_SCALED_AMOUNT) return null;
  return { source: value, scaled: negative ? -scaled : scaled };
}

function currency(value: unknown): string | null {
  return typeof value === 'string' && CURRENCY_PATTERN.test(value) ? value : null;
}

function nullable<T>(value: unknown, parse: (input: unknown) => T | null): T | null | undefined {
  return value === null ? null : (parse(value) ?? undefined);
}

/**
 * 新增的可选字段：旧服务端没有（undefined）当 null；新服务端给了就必须合法，不合法返回
 * undefined，由调用方按坏响应处理，不能悄悄当成旧服务端。
 */
function optional<T>(value: unknown, parse: (input: unknown) => T | null): T | null | undefined {
  return value === undefined ? null : nullable(value, parse);
}

function isoTime(value: unknown): string | null {
  if (typeof value !== 'string' || !ISO_TIME_PATTERN.test(value)) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value ? value : null;
}

function observedAt(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = RFC3339_UTC_PATTERN.exec(value);
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth[month - 1] ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return null;
  }
  return value;
}

function compareObservedAt(left: string, right: string): number {
  const [leftWhole, leftFraction = ''] = left.slice(0, -1).split('.');
  const [rightWhole, rightFraction = ''] = right.slice(0, -1).split('.');
  if (leftWhole !== rightWhole) return leftWhole < rightWhole ? -1 : 1;
  const normalizedLeft = leftFraction.padEnd(9, '0');
  const normalizedRight = rightFraction.padEnd(9, '0');
  if (normalizedLeft === normalizedRight) return 0;
  return normalizedLeft < normalizedRight ? -1 : 1;
}

export function projectModelAccessBalance(value: unknown): ModelAccessBalance {
  if (!isRecord(value) || value.scale !== 9) invalidResponse();
  const planCredits = ledgerDecimal(value.planCredits);
  const purchasedCredits = ledgerDecimal(value.purchasedCredits);
  const promotionalCredits = ledgerDecimal(value.promotionalCredits);
  const available = ledgerDecimal(value.available);
  const snapshotTime = observedAt(value.observedAt);
  if (
    !planCredits ||
    !purchasedCredits ||
    !promotionalCredits ||
    !available ||
    planCredits.scaled < 0n ||
    promotionalCredits.scaled < 0n ||
    planCredits.scaled + purchasedCredits.scaled + promotionalCredits.scaled !== available.scaled ||
    !snapshotTime
  ) {
    invalidResponse();
  }
  return {
    planCredits: planCredits.source,
    purchasedCredits: purchasedCredits.source,
    promotionalCredits: promotionalCredits.source,
    available: available.source,
    scale: 9,
    observedAt: snapshotTime,
  };
}

function projectCreditPool(
  value: unknown,
  allowNegativeRemaining: boolean,
): {
  value: ModelAccessCreditPoolUsage;
  remaining: bigint;
  used: bigint | null;
  total: bigint | null;
} {
  if (!isRecord(value)) invalidResponse();
  const remaining = ledgerDecimal(value.remaining);
  const used = value.used === null ? null : ledgerDecimal(value.used);
  const total = value.total === null ? null : ledgerDecimal(value.total);
  if (
    !remaining ||
    (!allowNegativeRemaining && remaining.scaled < 0n) ||
    (value.used !== null && !used) ||
    (value.total !== null && !total) ||
    (used === null) !== (total === null) ||
    (used !== null &&
      total !== null &&
      (used.scaled < 0n || total.scaled < 0n || used.scaled + remaining.scaled !== total.scaled))
  ) {
    invalidResponse();
  }
  return {
    value: {
      remaining: remaining.source,
      used: used?.source ?? null,
      total: total?.source ?? null,
    },
    remaining: remaining.scaled,
    used: used?.scaled ?? null,
    total: total?.scaled ?? null,
  };
}

/**
 * 赠送的来源只是展示信息：认不出的类型或不合规的内容按「没有来源」处理，
 * 不因此丢掉整份余额。
 */
function projectPromotionalGrantSource(value: unknown): ModelAccessPromotionalGrantSource | null {
  if (!isRecord(value)) return null;
  if (value.type === 'subscription_rollover') return { type: 'subscription_rollover' };
  if (value.type !== 'gift_card') return null;
  const senderName = boundedString(value.senderName, MAX_GIFT_SENDER_LENGTH);
  return senderName ? { type: 'gift_card', senderName } : null;
}

function projectPromotionalGrant(value: unknown): ModelAccessPromotionalGrantUsage {
  if (!isRecord(value)) invalidResponse();
  const grantId = boundedString(value.grantId);
  const displayName =
    value.displayName === null
      ? null
      : (boundedString(value.displayName, MAX_NAME_LENGTH) ?? undefined);
  const originalAmount = ledgerDecimal(value.originalAmount);
  const usedAmount = ledgerDecimal(value.usedAmount);
  const remainingAmount = ledgerDecimal(value.remainingAmount);
  const expiresAt = observedAt(value.expiresAt);
  const state =
    typeof value.state === 'string' &&
    PROMOTIONAL_GRANT_STATES.has(value.state as ModelAccessPromotionalGrantState)
      ? (value.state as ModelAccessPromotionalGrantState)
      : null;
  if (
    !grantId ||
    displayName === undefined ||
    !originalAmount ||
    !usedAmount ||
    !remainingAmount ||
    originalAmount.scaled <= 0n ||
    usedAmount.scaled < 0n ||
    remainingAmount.scaled < 0n ||
    !expiresAt ||
    !state ||
    (state === 'active' &&
      (remainingAmount.scaled === 0n ||
        usedAmount.scaled + remainingAmount.scaled !== originalAmount.scaled)) ||
    (state === 'depleted' &&
      (remainingAmount.scaled !== 0n || usedAmount.scaled !== originalAmount.scaled)) ||
    ((state === 'expired' || state === 'voided') &&
      (remainingAmount.scaled !== 0n || usedAmount.scaled > originalAmount.scaled))
  ) {
    invalidResponse();
  }
  const source = projectPromotionalGrantSource(value.source);
  return {
    grantId,
    displayName,
    ...(source ? { source } : value.source === null ? { source: null } : {}),
    originalAmount: originalAmount.source,
    usedAmount: usedAmount.source,
    remainingAmount: remainingAmount.source,
    expiresAt,
    state,
  };
}

export function projectModelAccessCreditUsage(value: unknown): ModelAccessCreditUsage {
  if (
    !isRecord(value) ||
    value.scale !== 9 ||
    !Array.isArray(value.promotionalGrants) ||
    value.promotionalGrants.length > MAX_PROMOTIONAL_GRANTS ||
    typeof value.promotionalGrantsComplete !== 'boolean' ||
    value.promotionalGrantConsistency !== 'OBSERVED'
  ) {
    invalidResponse();
  }
  const available = ledgerDecimal(value.available);
  const plan = projectCreditPool(value.plan, false);
  const purchased = projectCreditPool(value.purchased, true);
  const promotional = projectCreditPool(value.promotional, false);
  const snapshotTime = observedAt(value.observedAt);
  const ledgerUpdatedAt = value.ledgerUpdatedAt === null ? null : observedAt(value.ledgerUpdatedAt);
  if (
    !available ||
    plan.remaining + purchased.remaining + promotional.remaining !== available.scaled ||
    !snapshotTime ||
    (value.ledgerUpdatedAt !== null && !ledgerUpdatedAt)
  ) {
    invalidResponse();
  }

  const grantIds = new Set<string>();
  let currentOriginalTotal = 0n;
  let currentUsedTotal = 0n;
  let currentRemainingTotal = 0n;
  const promotionalGrants = value.promotionalGrants.map((grant) => {
    const projected = projectPromotionalGrant(grant);
    if (grantIds.has(projected.grantId)) invalidResponse();
    grantIds.add(projected.grantId);
    if (
      (projected.state === 'active' || projected.state === 'depleted') &&
      compareObservedAt(projected.expiresAt, snapshotTime) > 0
    ) {
      currentOriginalTotal += ledgerDecimal(projected.originalAmount)!.scaled;
      currentUsedTotal += ledgerDecimal(projected.usedAmount)!.scaled;
      currentRemainingTotal += ledgerDecimal(projected.remainingAmount)!.scaled;
    }
    return projected;
  });
  if (
    (value.promotionalGrantsComplete &&
      (promotional.total === null ||
        promotional.used === null ||
        promotional.total !== currentOriginalTotal ||
        promotional.used !== currentUsedTotal ||
        promotional.remaining !== currentRemainingTotal)) ||
    (!value.promotionalGrantsComplete && (promotional.used !== null || promotional.total !== null))
  ) {
    invalidResponse();
  }

  return {
    available: available.source,
    plan: plan.value,
    purchased: purchased.value,
    promotional: promotional.value,
    promotionalGrants,
    promotionalGrantsComplete: value.promotionalGrantsComplete,
    promotionalGrantConsistency: 'OBSERVED',
    ledgerUpdatedAt,
    scale: 9,
    observedAt: snapshotTime,
  };
}

function projectPaymentAction(value: unknown): BillingPaymentAction | null {
  if (!isRecord(value)) return null;
  const expiresAt = isoTime(value.expiresAt);
  if (!expiresAt) return null;
  if (value.type === 'QR_CODE') {
    const qrValue = boundedString(value.value, MAX_QR_VALUE_LENGTH);
    return qrValue ? { type: 'QR_CODE', value: qrValue, expiresAt } : null;
  }
  if (value.type === 'REDIRECT' && isAllowedBillingRedirectUrl(value.url)) {
    return { type: 'REDIRECT', url: value.url, expiresAt };
  }
  return null;
}

export function projectBillingPortalSession(value: unknown): { url: string } {
  if (!isRecord(value)) invalidResponse();
  const url = value.url;
  if (!isAllowedStripeBillingPortalUrl(url)) invalidResponse();
  return { url };
}

function projectPurchaseOption(
  value: unknown,
  productKind: BillingCatalogProduct['kind'],
): BillingPurchaseOption | null {
  if (!isRecord(value)) return null;
  const id = boundedString(value.id);
  const provider = boundedString(value.provider, 32);
  if (
    !id ||
    !provider ||
    !SUPPORTED_PROVIDERS.has(provider) ||
    (value.paymentAction !== 'QR_CODE' && value.paymentAction !== 'REDIRECT')
  ) {
    return null;
  }
  const capability =
    productKind === 'CREDIT_TOPUP' || productKind === 'GIFT_CARD'
      ? value.capability === 'ONE_TIME_PAYMENT'
        ? value.capability
        : null
      : typeof value.capability === 'string' && SUBSCRIPTION_CAPABILITIES.has(value.capability)
        ? (value.capability as BillingPurchaseOption['capability'])
        : null;
  return capability ? { id, provider, capability, paymentAction: value.paymentAction } : null;
}

function projectOffer(
  value: unknown,
  productKind: BillingCatalogProduct['kind'],
): BillingCatalogOffer | null {
  if (!isRecord(value) || !Array.isArray(value.purchaseOptions)) return null;
  const offerCode = code(value.code);
  const offerName = boundedString(value.name, 128) ?? undefined;
  const offerCurrency = currency(value.currency);
  const amount = nullable(value.amount, decimal);
  const minAmount = nullable(value.minAmount, decimal);
  const maxAmount = nullable(value.maxAmount, decimal);
  const creditAmount = nullable(value.creditAmount, decimal);
  const rolloverCap = nullable(value.rolloverCap, decimal);
  const interval =
    value.interval === 'MONTH' || value.interval === 'YEAR' || value.interval === null
      ? value.interval
      : undefined;
  if (
    !offerCode ||
    !offerCurrency ||
    interval === undefined ||
    amount === undefined ||
    minAmount === undefined ||
    maxAmount === undefined ||
    creditAmount === undefined ||
    rolloverCap === undefined
  ) {
    return null;
  }

  const isSubscription =
    productKind === 'SUBSCRIPTION' &&
    interval !== null &&
    amount !== null &&
    minAmount === null &&
    maxAmount === null &&
    creditAmount !== null &&
    rolloverCap !== null;
  const isFixedTopup =
    productKind === 'CREDIT_TOPUP' &&
    interval === null &&
    amount !== null &&
    creditAmount !== null &&
    minAmount === null &&
    maxAmount === null &&
    rolloverCap === null;
  const isCustomTopup =
    productKind === 'CREDIT_TOPUP' &&
    interval === null &&
    amount === null &&
    creditAmount === null &&
    minAmount !== null &&
    maxAmount !== null &&
    rolloverCap === null;
  // 礼品卡的固定面额印在卡面上，到账金额必须与它一致；自填面额由买家在范围内填，到账等于所填面额。
  const isFixedGiftCard =
    productKind === 'GIFT_CARD' &&
    interval === null &&
    amount !== null &&
    isGiftCardMoney(amount) &&
    creditAmount !== null &&
    sameDecimal(creditAmount, amount) &&
    minAmount === null &&
    maxAmount === null &&
    rolloverCap === null;
  const isCustomGiftCard =
    productKind === 'GIFT_CARD' &&
    interval === null &&
    amount === null &&
    creditAmount === null &&
    minAmount !== null &&
    isGiftCardMoney(minAmount) &&
    maxAmount !== null &&
    isGiftCardMoney(maxAmount) &&
    rolloverCap === null;
  if (
    !isSubscription &&
    !isFixedTopup &&
    !isCustomTopup &&
    !isFixedGiftCard &&
    !isCustomGiftCard
  ) {
    return null;
  }

  const optionIds = new Set<string>();
  const purchaseOptions = value.purchaseOptions
    .map((option) => projectPurchaseOption(option, productKind))
    .filter((option): option is BillingPurchaseOption => {
      if (!option || optionIds.has(option.id)) return false;
      optionIds.add(option.id);
      return true;
    });
  const hasAvailabilityProjection =
    value.salesState !== undefined ||
    value.purchasable !== undefined ||
    value.unavailableReason !== undefined;
  let availability: Pick<BillingCatalogOffer, 'salesState' | 'purchasable' | 'unavailableReason'> =
    {};
  if (hasAvailabilityProjection) {
    const salesState =
      value.salesState === 'COMING_SOON' || value.salesState === 'AVAILABLE'
        ? value.salesState
        : null;
    const purchasable = typeof value.purchasable === 'boolean' ? value.purchasable : null;
    const unavailableReason =
      value.unavailableReason === null ||
      value.unavailableReason === 'OFFER_COMING_SOON' ||
      value.unavailableReason === 'NO_AVAILABLE_PAYMENT_CHANNEL'
        ? value.unavailableReason
        : undefined;
    if (salesState === 'COMING_SOON') {
      if (
        purchasable !== false ||
        unavailableReason !== 'OFFER_COMING_SOON' ||
        value.purchaseOptions.length !== 0
      ) {
        return null;
      }
      availability = {
        salesState,
        purchasable: false,
        unavailableReason: 'OFFER_COMING_SOON',
      };
    } else if (salesState === 'AVAILABLE') {
      if (purchasable === true && unavailableReason === null && value.purchaseOptions.length > 0) {
        availability = { salesState, purchasable: true, unavailableReason: null };
      } else if (
        purchasable === false &&
        unavailableReason === 'NO_AVAILABLE_PAYMENT_CHANNEL' &&
        value.purchaseOptions.length === 0
      ) {
        availability = {
          salesState,
          purchasable: false,
          unavailableReason: 'NO_AVAILABLE_PAYMENT_CHANNEL',
        };
      } else {
        return null;
      }
    } else {
      return null;
    }
  } else if (purchaseOptions.length === 0) {
    // Older servers only returned purchasable offers and had no availability projection.
    return null;
  }
  return {
    code: offerCode,
    ...(offerName ? { name: offerName } : {}),
    ...availability,
    interval: isSubscription ? interval : null,
    currency: offerCurrency,
    amount,
    minAmount,
    maxAmount,
    creditAmount,
    rolloverCap,
    purchaseOptions,
  };
}

function projectProduct(value: unknown): BillingCatalogProduct | null {
  if (
    !isRecord(value) ||
    !Array.isArray(value.offers) ||
    (value.kind !== 'CREDIT_TOPUP' && value.kind !== 'SUBSCRIPTION' && value.kind !== 'GIFT_CARD')
  ) {
    return null;
  }
  const productCode = code(value.code);
  const name = boundedString(value.name, MAX_NAME_LENGTH);
  const kind = value.kind;
  const level =
    kind !== 'SUBSCRIPTION'
      ? value.level === null
        ? null
        : undefined
      : typeof value.level === 'number' && Number.isSafeInteger(value.level) && value.level >= 0
        ? value.level
        : undefined;
  if (
    !productCode ||
    !name ||
    level === undefined ||
    typeof value.sortOrder !== 'number' ||
    !Number.isSafeInteger(value.sortOrder)
  ) {
    return null;
  }

  const offerCodes = new Set<string>();
  const offers = value.offers
    .map((offer) => projectOffer(offer, kind))
    .filter((offer): offer is BillingCatalogOffer => {
      if (!offer || offerCodes.has(offer.code)) return false;
      offerCodes.add(offer.code);
      return true;
    });
  if (offers.length === 0) return null;
  return {
    code: productCode,
    name,
    kind,
    level,
    sortOrder: value.sortOrder,
    offers,
  };
}

export function projectBillingCatalog(value: unknown): BillingCatalog {
  if (!isRecord(value) || !Array.isArray(value.products)) invalidResponse();
  const productCodes = new Set<string>();
  const offerCodes = new Set<string>();
  const products: BillingCatalogProduct[] = [];
  for (const valueProduct of value.products) {
    const product = projectProduct(valueProduct);
    if (!product || productCodes.has(product.code)) continue;
    const offers = product.offers.filter((offer) => !offerCodes.has(offer.code));
    if (offers.length === 0) continue;
    productCodes.add(product.code);
    for (const offer of offers) offerCodes.add(offer.code);
    products.push({ ...product, offers });
  }
  return { products };
}

const MAX_ORDER_QUANTITY = 100;

function orderQuantity(value: unknown): number | null {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_ORDER_QUANTITY
    ? value
    : null;
}

function projectPaymentOrder(value: unknown): BillingPaymentOrder {
  if (!isRecord(value)) invalidResponse();
  const orderId = boundedString(value.orderId);
  const productCode = code(value.productCode);
  const offerCode = code(value.offerCode);
  const amount = decimal(value.amount);
  const orderCurrency = currency(value.currency);
  const status =
    typeof value.status === 'string' &&
    PAYMENT_ORDER_STATUSES.has(value.status as BillingPaymentOrderStatus)
      ? (value.status as BillingPaymentOrderStatus)
      : null;
  const createdAt = isoTime(value.createdAt);
  const updatedAt = isoTime(value.updatedAt);
  if (
    !orderId ||
    !productCode ||
    !offerCode ||
    !amount ||
    !orderCurrency ||
    !status ||
    !createdAt ||
    !updatedAt
  ) {
    invalidResponse();
  }
  const fulfillmentStatus =
    typeof value.fulfillmentStatus === 'string' &&
    FULFILLMENT_STATUSES.has(value.fulfillmentStatus as BillingFulfillmentStatus)
      ? (value.fulfillmentStatus as BillingFulfillmentStatus)
      : undefined;
  // 旧服务端不下发这两项：订单都是充值。新服务端下发了却不认识，就不能当充值展示。
  const productKind =
    value.productKind === undefined
      ? undefined
      : value.productKind === 'CREDIT_TOPUP' || value.productKind === 'GIFT_CARD'
        ? value.productKind
        : null;
  const quantity = value.quantity === undefined ? undefined : orderQuantity(value.quantity);
  if (productKind === null || quantity === null) invalidResponse();
  // 礼品卡订单：张数必填（付款弹窗与订单记录按「面额 × 张数」说），币种必须是本区域余额币种（卡按它
  // 发与入账，弹窗也按它展示）；缺张数或币种不对按坏响应处理，不当成一张、也不按本币说外币的价。
  if (productKind === 'GIFT_CARD' && (quantity === undefined || orderCurrency !== BILLING_CURRENCY)) invalidResponse();
  return {
    orderId,
    productCode,
    offerCode,
    amount,
    currency: orderCurrency,
    status,
    paymentAction: projectPaymentAction(value.paymentAction),
    ...(productKind ? { productKind } : {}),
    ...(quantity !== undefined ? { quantity } : {}),
    ...(fulfillmentStatus ? { fulfillmentStatus } : {}),
    createdAt,
    updatedAt,
  };
}

export function projectBillingPaymentOrder(value: unknown): BillingPaymentOrder {
  return projectPaymentOrder(value);
}

export function projectBillingOrderList(value: unknown): BillingOrderList {
  if (!isRecord(value) || !Array.isArray(value.orders) || value.orders.length > 100) {
    invalidResponse();
  }
  const nextCursor =
    value.nextCursor === null ? null : boundedString(value.nextCursor, MAX_CURSOR_LENGTH);
  if (nextCursor === null && value.nextCursor !== null) invalidResponse();
  const orders: BillingPaymentOrder[] = [];
  for (const order of value.orders) {
    try {
      orders.push(projectPaymentOrder(order));
    } catch {
      // Unknown or malformed rows must not block recovery of the remaining orders.
    }
  }
  return { orders, nextCursor };
}

export function projectBillingPaymentHistory(value: unknown): BillingPaymentHistory {
  if (!isRecord(value) || !Array.isArray(value.records) || value.records.length > 100) invalidResponse();
  const nextCursor = value.nextCursor === null ? null : boundedString(value.nextCursor, 1024);
  if (value.nextCursor !== null && (!nextCursor || !/^[A-Za-z0-9_-]+$/.test(nextCursor))) invalidResponse();
  const records = value.records.map((raw): BillingPaymentHistoryRecord => {
    if (!isRecord(raw) || !isRecord(raw.refundSummary)) invalidResponse();
    const sourceType = raw.sourceType === 'CREDIT_TOPUP' || raw.sourceType === 'SUBSCRIPTION_INVOICE'
      || raw.sourceType === 'GIFT_CARD'
      ? raw.sourceType : null;
    // 旧服务端不下发张数：那时只有充值和订阅账单，各算一笔。
    const quantity = raw.quantity === undefined && sourceType !== 'GIFT_CARD' ? 1 : orderQuantity(raw.quantity);
    const sourceId = boundedString(raw.sourceId, 191);
    const subscriptionId = nullable(raw.subscriptionId, (input) => boundedString(input, 191));
    const productName = nullable(raw.productName, (input) => boundedString(input, 256));
    const billingReason = nullable(raw.billingReason, (input) => boundedString(input, 64));
    const provider = nullable(raw.provider, (input) => boundedString(input, 32));
    const providerTransactionId = raw.providerTransactionId === undefined ? null
      : nullable(raw.providerTransactionId, (input) => boundedString(input, 255));
    const amount = nullable(raw.amount, decimal);
    const recordCurrency = currency(raw.currency);
    const paidAt = nullable(raw.paidAt, isoTime);
    const createdAt = isoTime(raw.createdAt);
    const periodStartAt = nullable(raw.periodStartAt, isoTime);
    const periodEndAt = nullable(raw.periodEndAt, isoTime);
    const refund = raw.refundSummary;
    const refundStatus = nullable(refund.status, (input) => input === 'UNREFUNDED' || input === 'PARTIALLY_REFUNDED' || input === 'REFUNDED'
      ? input : null);
    const refundedAmount = decimal(refund.refundedAmount);
    if (!sourceType || !sourceId || raw.recordId !== `${sourceType}:${sourceId}` || quantity === null
      || subscriptionId === undefined || productName === undefined || billingReason === undefined || provider === undefined
      || providerTransactionId === undefined
      || amount === undefined || !recordCurrency || paidAt === undefined || !createdAt
      || periodStartAt === undefined || periodEndAt === undefined || refundStatus === undefined || !refundedAmount
      || typeof refund.refundedMinor !== 'number' || !Number.isSafeInteger(refund.refundedMinor) || refund.refundedMinor < 0
      || (raw.amountPaidMinor !== null && (typeof raw.amountPaidMinor !== 'number'
        || !Number.isSafeInteger(raw.amountPaidMinor) || raw.amountPaidMinor < 0))
      || (amount === null) !== (raw.amountPaidMinor === null)) invalidResponse();
    return {
      recordId: raw.recordId, sourceType, quantity, sourceId, subscriptionId, productName, billingReason, provider,
      providerTransactionId,
      amount, amountPaidMinor: raw.amountPaidMinor, currency: recordCurrency,
      paidAt, createdAt, periodStartAt, periodEndAt,
      refundSummary: { status: refundStatus, refundedMinor: refund.refundedMinor, refundedAmount },
    };
  });
  // A malformed paid record is a failed page, never a silently incomplete history.
  return { records, nextCursor };
}

const FACE_CODE_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
const CODE_TAIL_PATTERN = /^[0-9A-HJKMNP-TV-Z]{4}$/;
const MAX_GIFT_MESSAGE_LENGTH = 240;
const MAX_PURCHASED_GIFT_CARDS = 100;
const PURCHASED_GIFT_CARD_STATUSES = new Set<BillingPurchasedGiftCardStatus>([
  'UNCLAIMED',
  'CLAIMED',
  'REDEEMED_BY_YOU',
  'REFUNDED',
  'ON_HOLD',
]);

/** 礼品卡接口与 Preview DTO 一致用大写币种（CNY / USD），计费接口用小写；客户端统一成小写。 */
function giftCardCurrency(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z]{3}$/.test(value) ? value.toLowerCase() : null;
}

function boundedCount(value: unknown, max: number): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max
    ? value
    : null;
}

export function projectGiftCardPurchasePolicy(value: unknown): BillingGiftCardPurchasePolicy {
  if (!isRecord(value) || !Array.isArray(value.faces)) invalidResponse();
  const policyCurrency = giftCardCurrency(value.currency);
  const dailyLimit = boundedCount(value.dailyLimit, MAX_ORDER_QUANTITY);
  const windowHours = boundedCount(value.windowHours, 24 * 31);
  const remaining = boundedCount(value.remaining, MAX_ORDER_QUANTITY);
  const maxQuantityPerOrder = orderQuantity(value.maxQuantityPerOrder);
  // 一单总额上限与单张面额同样按分：比分更细的上限界面无法按分比较，会把所有面额的可选张数算成 0。
  const maxOrderAmount = nullable(value.maxOrderAmount, giftCardMoney);
  const maxSenderNameLength = boundedCount(value.maxSenderNameLength, MAX_GIFT_SENDER_LENGTH);
  const maxMessageLength = boundedCount(value.maxMessageLength, MAX_GIFT_MESSAGE_LENGTH);
  const faces = value.faces.filter(
    (face): face is string => typeof face === 'string' && FACE_CODE_PATTERN.test(face),
  );
  const minFaceValue = optional(value.minFaceValue, giftCardMoney);
  const maxFaceValue = optional(value.maxFaceValue, giftCardMoney);
  // 0 是合法的「不冷却」；null 或缺省才表示服务端不支持发到邮箱。
  const emailCooldownSeconds = optional(value.emailCooldownSeconds, (input) =>
    boundedCount(input, 24 * 3_600),
  );
  if (
    !policyCurrency ||
    minFaceValue === undefined ||
    maxFaceValue === undefined ||
    emailCooldownSeconds === undefined ||
    dailyLimit === null ||
    !windowHours ||
    remaining === null ||
    maxQuantityPerOrder === null ||
    maxOrderAmount === undefined ||
    !maxSenderNameLength ||
    maxMessageLength === null ||
    faces.length === 0
  ) {
    invalidResponse();
  }
  return {
    currency: policyCurrency,
    dailyLimit,
    windowHours,
    remaining: Math.min(remaining, dailyLimit),
    maxQuantityPerOrder,
    maxOrderAmount,
    // 旧服务端没有单张面额范围：当作没有，自填面额只按价格方案范围限制；给了但不合法按坏响应处理。
    minFaceValue,
    maxFaceValue,
    faces: [...new Set(faces)],
    maxSenderNameLength,
    maxMessageLength,
    // 旧服务端没有发信接口：null 表示不提供「发送到邮箱」。
    emailCooldownSeconds,
  };
}

function projectPurchasedGiftCard(value: unknown): BillingPurchasedGiftCard {
  if (!isRecord(value)) invalidResponse();
  const cardId = isPurchasedGiftCardId(value.cardId) ? value.cardId : null;
  const orderId = boundedString(value.orderId);
  const faceCode =
    typeof value.faceCode === 'string' && FACE_CODE_PATTERN.test(value.faceCode)
      ? value.faceCode
      : null;
  // 面额印在卡面上：比分更细的金额卡面与文字会对不上，按坏响应处理。
  const amount = giftCardMoney(value.amount);
  // 卡按本区域余额币种发与入账；兑换、取码等界面也按本区域币种展示。其它币种按坏响应处理，
  // 免得同一张卡在列表与兑换之间换了币种。
  const listedCurrency = giftCardCurrency(value.currency);
  const cardCurrency = listedCurrency === BILLING_CURRENCY ? listedCurrency : null;
  const senderName = boundedString(value.senderName, MAX_GIFT_SENDER_LENGTH);
  const message = nullable(value.message, (input) =>
    typeof input === 'string' && input.length <= MAX_GIFT_MESSAGE_LENGTH ? input : null,
  );
  const codeTail =
    typeof value.codeTail === 'string' && CODE_TAIL_PATTERN.test(value.codeTail)
      ? value.codeTail
      : null;
  const status =
    typeof value.status === 'string' &&
    PURCHASED_GIFT_CARD_STATUSES.has(value.status as BillingPurchasedGiftCardStatus)
      ? (value.status as BillingPurchasedGiftCardStatus)
      : null;
  const claimedAt = nullable(value.claimedAt, isoTime);
  const claimedByName = nullable(value.claimedByName, (input) =>
    boundedString(input, MAX_GIFT_SENDER_LENGTH),
  );
  const purchasedAt = isoTime(value.purchasedAt);
  const email = optional(value.email, projectPurchasedGiftCardEmail);
  if (
    email === undefined ||
    !cardId ||
    !orderId ||
    !faceCode ||
    !amount ||
    !cardCurrency ||
    !senderName ||
    message === undefined ||
    !codeTail ||
    !status ||
    claimedAt === undefined ||
    claimedByName === undefined ||
    !purchasedAt
  ) {
    invalidResponse();
  }
  return {
    cardId,
    orderId,
    faceCode,
    amount,
    currency: cardCurrency,
    senderName,
    message,
    codeTail,
    status,
    claimedAt,
    // 领取人昵称只属于「被别人领走」这一种状态，其它状态即使带了也不展示。
    claimedByName: status === 'CLAIMED' ? claimedByName : null,
    purchasedAt,
    email,
  };
}

/**
 * 「我买的礼品卡」的翻页游标：服务端发的是 base64url，最长 512。读响应与「加载更多」请求（IPC 参数
 * 校验）共用这一条规则，读进来的游标一定能原样发回去；不合规则的游标在读响应时就按坏响应处理。
 */
/**
 * 「我买的礼品卡」的卡号：读列表与取码、发到邮箱两个 IPC 请求共用这一条规则，读进来的卡号一定能用来
 * 取码和发信（服务端发的是 UUID，也满足）。不合规则的卡号在读响应时就按坏响应处理。
 */
export function isPurchasedGiftCardId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

export function isPurchasedGiftCardCursor(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_.~-]{1,512}$/.test(value);
}

const GIFT_CARD_EMAIL_STATUSES = new Set<BillingPurchasedGiftCardEmail['status']>([
  'PENDING',
  'SENDING',
  'SENT',
  'FAILED',
]);
const MAX_EMAIL_LENGTH = 254;

/**
 * 最近一次发到邮箱的情况。旧服务端没有这个字段时当作没发过（见 optional）；给了但不合法时
 * 返回 null，由调用方按坏响应处理，不悄悄当成没发过。
 */
function projectPurchasedGiftCardEmail(value: unknown): BillingPurchasedGiftCardEmail | null {
  if (!isRecord(value)) return null;
  const recipient = boundedString(value.recipient, MAX_EMAIL_LENGTH);
  const status =
    typeof value.status === 'string' &&
    GIFT_CARD_EMAIL_STATUSES.has(value.status as BillingPurchasedGiftCardEmail['status'])
      ? (value.status as BillingPurchasedGiftCardEmail['status'])
      : null;
  const updatedAt = isoTime(value.updatedAt);
  const nextAvailableAt = isoTime(value.nextAvailableAt);
  if (!recipient || !recipient.includes('@') || !status || !updatedAt || !nextAvailableAt) return null;
  return { recipient, status, updatedAt, nextAvailableAt };
}

/** 发到邮箱成功后服务端返回这张卡的最新样子。 */
export function projectSentPurchasedGiftCard(value: unknown): BillingPurchasedGiftCard {
  if (!isRecord(value)) invalidResponse();
  return projectPurchasedGiftCard(value.card);
}

export function projectPurchasedGiftCardList(value: unknown): BillingPurchasedGiftCardList {
  if (
    !isRecord(value) ||
    !Array.isArray(value.cards) ||
    value.cards.length > MAX_PURCHASED_GIFT_CARDS
  ) {
    invalidResponse();
  }
  if (value.nextCursor !== null && !isPurchasedGiftCardCursor(value.nextCursor)) invalidResponse();
  const nextCursor = value.nextCursor as string | null;
  const cardIds = new Set<string>();
  const cards: BillingPurchasedGiftCard[] = [];
  for (const raw of value.cards) {
    const card = projectPurchasedGiftCard(raw);
    if (cardIds.has(card.cardId)) continue;
    cardIds.add(card.cardId);
    cards.push(card);
  }
  const emailSupported =
    value.cards.length > 0 && value.cards.every((raw) => isRecord(raw) && 'email' in raw);
  return { cards, nextCursor, emailSupported };
}

/**
 * 服务端只回兑换码（规范形式，按 16 位 Crockford Base32 校验后统一成
 * XXXX-XXXX-XXXX-XXXX）；领取链接在主进程按分享站拼出。
 */
export function projectPurchasedGiftCardCode(value: unknown): { code: string } {
  if (!isRecord(value) || typeof value.code !== 'string' || value.code.length > 32) invalidResponse();
  const code = normalizeGiftCardCode(value.code);
  if (!code) invalidResponse();
  return { code: formatGiftCardCode(code) };
}

function projectEffectivePlan(value: unknown): BillingSubscription['effectivePlan'] {
  if (
    !isRecord(value) ||
    !isRecord(value.product) ||
    !isRecord(value.offer) ||
    !isRecord(value.terms)
  ) {
    invalidResponse();
  }
  const productCode = code(value.product.code);
  const offerCode = code(value.offer.code);
  const level =
    typeof value.product.level === 'number' &&
    Number.isSafeInteger(value.product.level) &&
    value.product.level >= 0
      ? value.product.level
      : null;
  const amount = decimal(value.terms.amount);
  const planCurrency = currency(value.terms.currency);
  const creditAmount = decimal(value.terms.creditAmount);
  const rolloverCap = decimal(value.terms.rolloverCap);
  const capturedAt = isoTime(value.capturedAt);
  if (
    value.version !== 1 ||
    value.product.kind !== 'SUBSCRIPTION' ||
    !productCode ||
    level === null ||
    !offerCode ||
    (value.offer.interval !== 'MONTH' && value.offer.interval !== 'YEAR') ||
    !amount ||
    !planCurrency ||
    !creditAmount ||
    !rolloverCap ||
    !capturedAt
  ) {
    invalidResponse();
  }
  return {
    version: 1,
    product: { code: productCode, kind: 'SUBSCRIPTION', level },
    offer: { code: offerCode, interval: value.offer.interval },
    terms: { amount, currency: planCurrency, creditAmount, rolloverCap },
    capturedAt,
  };
}

function planChangeBase(value: unknown): BillingPlanChange | null {
  if (!isRecord(value)) return null;
  const planChangeId = boundedString(value.planChangeId);
  const changeType =
    value.changeType === 'UPGRADE' || value.changeType === 'DOWNGRADE' ? value.changeType : null;
  const status =
    typeof value.status === 'string' &&
    PLAN_CHANGE_STATUSES.has(value.status as BillingPlanChangeStatus)
      ? (value.status as BillingPlanChangeStatus)
      : null;
  const quotedAmountMinor =
    value.quotedAmountMinor === null
      ? null
      : typeof value.quotedAmountMinor === 'number' &&
          Number.isSafeInteger(value.quotedAmountMinor) &&
          value.quotedAmountMinor >= 0 &&
          value.quotedAmountMinor <= MAX_QUOTED_AMOUNT_MINOR
        ? value.quotedAmountMinor
        : undefined;
  const quotedCurrency = nullable(value.quotedCurrency, currency);
  const quoteExpiresAt = nullable(value.quoteExpiresAt, isoTime);
  const effectiveAt = isoTime(value.effectiveAt);
  if (
    !planChangeId ||
    !changeType ||
    !status ||
    quotedAmountMinor === undefined ||
    quotedCurrency === undefined ||
    quoteExpiresAt === undefined ||
    !effectiveAt
  ) {
    return null;
  }
  return {
    planChangeId,
    changeType,
    status,
    quotedAmountMinor,
    quotedCurrency,
    quoteExpiresAt,
    effectiveAt,
    paymentAction: projectPaymentAction(value.paymentAction),
  };
}

/**
 * Direct plan-change endpoint responses must parse; an unknown enum here means
 * the client cannot reason about the operation it just performed, so fail
 * closed by rejecting the response instead of guessing.
 */
export function projectBillingPlanChange(value: unknown): BillingPlanChange {
  const change = planChangeBase(value);
  if (!change) invalidResponse();
  return change;
}

function projectPlanChangeTargetPlan(value: unknown): BillingPlanChangeTargetPlan | null {
  if (
    !isRecord(value) ||
    !isRecord(value.product) ||
    !isRecord(value.offer) ||
    !isRecord(value.terms)
  ) {
    return null;
  }
  const productCode = code(value.product.code);
  const offerCode = code(value.offer.code);
  const amount = decimal(value.terms.amount);
  const planCurrency = currency(value.terms.currency);
  const creditAmount = decimal(value.terms.creditAmount);
  if (
    !productCode ||
    typeof value.product.level !== 'number' ||
    !Number.isSafeInteger(value.product.level) ||
    value.product.level < 0 ||
    !offerCode ||
    (value.offer.interval !== 'MONTH' && value.offer.interval !== 'YEAR') ||
    !amount ||
    !planCurrency ||
    !creditAmount
  ) {
    return null;
  }
  return {
    product: { code: productCode, level: value.product.level },
    offer: { code: offerCode, interval: value.offer.interval },
    terms: { amount, currency: planCurrency, creditAmount },
  };
}

/**
 * Recovery projection embedded in the subscription. A malformed or unknown
 * entry is dropped (undefined) rather than failing the whole subscription:
 * the client then behaves like an older server and relies on server-side
 * rejection of conflicting writes.
 */
function projectPendingPlanChange(value: unknown): BillingPendingPlanChange | null | undefined {
  if (value === null) return null;
  const change = planChangeBase(value);
  if (!change) return undefined;
  return {
    ...change,
    targetPlan: projectPlanChangeTargetPlan((value as Record<string, unknown>).targetPlan),
  };
}

export function projectBillingSubscription(value: unknown): BillingSubscription {
  if (!isRecord(value)) invalidResponse();
  const subscriptionId = boundedString(value.subscriptionId);
  const status =
    typeof value.status === 'string' &&
    SUBSCRIPTION_STATUSES.has(value.status as BillingSubscriptionStatus)
      ? (value.status as BillingSubscriptionStatus)
      : null;
  const currentPeriodStartAt = nullable(value.currentPeriodStartAt, isoTime);
  const currentPeriodEndAt = nullable(value.currentPeriodEndAt, isoTime);
  const entitlementValidUntil = nullable(value.entitlementValidUntil, isoTime);
  const purchaseAttemptId = nullable(value.purchaseAttemptId, boundedString);
  if (
    !subscriptionId ||
    !status ||
    currentPeriodStartAt === undefined ||
    currentPeriodEndAt === undefined ||
    entitlementValidUntil === undefined ||
    typeof value.cancelAtPeriodEnd !== 'boolean' ||
    purchaseAttemptId === undefined ||
    (value.effectivePlan !== null && !isRecord(value.effectivePlan))
  ) {
    invalidResponse();
  }
  const provider =
    typeof value.provider === 'string' && SUPPORTED_PROVIDERS.has(value.provider)
      ? value.provider
      : undefined;
  const entitlementStatus =
    typeof value.entitlementStatus === 'string' &&
    FULFILLMENT_STATUSES.has(value.entitlementStatus as BillingFulfillmentStatus)
      ? (value.entitlementStatus as BillingFulfillmentStatus)
      : undefined;
  const pendingPlanChange =
    'pendingPlanChange' in value ? projectPendingPlanChange(value.pendingPlanChange) : undefined;
  return {
    subscriptionId,
    status,
    ...(provider ? { provider } : {}),
    ...(entitlementStatus ? { entitlementStatus } : {}),
    currentPeriodStartAt,
    currentPeriodEndAt,
    entitlementValidUntil,
    cancelAtPeriodEnd: value.cancelAtPeriodEnd,
    ...(typeof value.resumable === 'boolean' ? { resumable: value.resumable } : {}),
    effectivePlan: value.effectivePlan === null ? null : projectEffectivePlan(value.effectivePlan),
    purchaseAttemptId,
    paymentAction: projectPaymentAction(value.paymentAction),
    ...(pendingPlanChange === undefined ? {} : { pendingPlanChange }),
  };
}

export function projectBillingCurrentSubscription(value: unknown): BillingCurrentSubscription {
  if (!isRecord(value) || !('subscription' in value)) invalidResponse();
  return {
    subscription:
      value.subscription === null ? null : projectBillingSubscription(value.subscription),
  };
}
