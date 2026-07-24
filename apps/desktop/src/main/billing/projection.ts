import type {
  BillingCatalog,
  BillingCatalogOffer,
  BillingCatalogProduct,
  BillingCurrentSubscription,
  BillingFulfillmentStatus,
  BillingOrderList,
  BillingPaymentAction,
  BillingPaymentOrder,
  BillingPaymentOrderStatus,
  BillingPendingPlanChange,
  BillingPlanChange,
  BillingPlanChangeStatus,
  BillingPlanChangeTargetPlan,
  BillingPurchaseOption,
  BillingSubscription,
  BillingSubscriptionStatus,
} from '../../shared/billing.js';
import type {
  ModelAccessBalance,
  ModelAccessCreditPoolUsage,
  ModelAccessCreditUsage,
  ModelAccessPromotionalGrantState,
  ModelAccessPromotionalGrantUsage,
} from '../../shared/modelAccess.js';
import { isAllowedBillingRedirectUrl } from './paymentRedirect.js';

const MAX_ID_LENGTH = 128;
const MAX_NAME_LENGTH = 128;
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
  return {
    grantId,
    displayName,
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
    productKind === 'CREDIT_TOPUP'
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
  if (!isSubscription && !isFixedTopup && !isCustomTopup) return null;

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
    (value.kind !== 'CREDIT_TOPUP' && value.kind !== 'SUBSCRIPTION')
  ) {
    return null;
  }
  const productCode = code(value.code);
  const name = boundedString(value.name, MAX_NAME_LENGTH);
  const kind = value.kind;
  const level =
    kind === 'CREDIT_TOPUP'
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
  return {
    orderId,
    productCode,
    offerCode,
    amount,
    currency: orderCurrency,
    status,
    paymentAction: projectPaymentAction(value.paymentAction),
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
  const managementAction =
    value.managementAction === 'API_CANCEL' || value.managementAction === 'PORTAL'
      ? value.managementAction
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
    ...(managementAction ? { managementAction } : {}),
    ...(entitlementStatus ? { entitlementStatus } : {}),
    currentPeriodStartAt,
    currentPeriodEndAt,
    entitlementValidUntil,
    cancelAtPeriodEnd: value.cancelAtPeriodEnd,
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
