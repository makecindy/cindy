import type {
  CreateBillingSubscriptionRequest,
  CreateBillingTopupRequest,
} from '../../../shared/billing';

const LEGACY_BILLING_CHECKOUT_INTENT_KEY = 'cindy.billing.checkout-intent.v1';
const BILLING_CHECKOUT_INTENT_KEY_PREFIX = 'cindy.billing.checkout-intent.v2';

export type BillingCheckoutIntentV1 =
  | {
      version: 1;
      kind: 'TOPUP';
      idempotencyKey: string;
      request: CreateBillingTopupRequest;
      orderId: string | null;
      createdAt: string;
    }
  | {
      version: 1;
      kind: 'SUBSCRIPTION';
      idempotencyKey: string;
      request: CreateBillingSubscriptionRequest;
      subscriptionId: string | null;
      purchaseAttemptId: string | null;
      createdAt: string;
    }
  | {
      version: 1;
      kind: 'TOPUP_RETRY';
      idempotencyKey: string;
      orderId: string;
      createdAt: string;
    };

const KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const CODE_PATTERN = /^[a-z][a-z0-9_]{1,63}$/;
const AMOUNT_PATTERN = /^(0|[1-9]\d{0,14})(?:\.\d{1,9})?$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isRequiredString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isTopupRequest(value: unknown): value is CreateBillingTopupRequest {
  if (!isRecord(value)) return false;
  return (
    hasOnlyKeys(value, ['offerCode', 'amount', 'purchaseOptionId']) &&
    typeof value.offerCode === 'string' &&
    CODE_PATTERN.test(value.offerCode) &&
    isRequiredString(value.purchaseOptionId) &&
    (value.amount === undefined ||
      (typeof value.amount === 'string' && AMOUNT_PATTERN.test(value.amount)))
  );
}

function isSubscriptionRequest(value: unknown): value is CreateBillingSubscriptionRequest {
  if (!isRecord(value)) return false;
  return (
    hasOnlyKeys(value, ['offerCode', 'purchaseOptionId']) &&
    typeof value.offerCode === 'string' &&
    CODE_PATTERN.test(value.offerCode) &&
    isRequiredString(value.purchaseOptionId)
  );
}

export function isBillingCheckoutIntent(value: unknown): value is BillingCheckoutIntentV1 {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.idempotencyKey !== 'string' ||
    !KEY_PATTERN.test(value.idempotencyKey) ||
    typeof value.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(value.createdAt))
  )
    return false;
  if (value.kind === 'TOPUP') {
    return (
      hasOnlyKeys(value, [
        'version',
        'kind',
        'idempotencyKey',
        'request',
        'orderId',
        'createdAt',
      ]) &&
      isTopupRequest(value.request) &&
      (value.orderId === null || isRequiredString(value.orderId))
    );
  }
  if (value.kind === 'SUBSCRIPTION') {
    return (
      hasOnlyKeys(value, [
        'version',
        'kind',
        'idempotencyKey',
        'request',
        'subscriptionId',
        'purchaseAttemptId',
        'createdAt',
      ]) &&
      isSubscriptionRequest(value.request) &&
      (value.subscriptionId === null || isRequiredString(value.subscriptionId)) &&
      (value.purchaseAttemptId === null || isRequiredString(value.purchaseAttemptId))
    );
  }
  if (value.kind === 'TOPUP_RETRY') {
    return (
      hasOnlyKeys(value, ['version', 'kind', 'idempotencyKey', 'orderId', 'createdAt']) &&
      isRequiredString(value.orderId)
    );
  }
  return false;
}

export function billingCheckoutIntentKey(accountId: string): string {
  return `${BILLING_CHECKOUT_INTENT_KEY_PREFIX}:${encodeURIComponent(accountId)}`;
}

export function readBillingCheckoutIntent(accountId: string): BillingCheckoutIntentV1 | null {
  const storageKey = billingCheckoutIntentKey(accountId);
  try {
    // A v1 intent has no account identity and must never be replayed after an
    // account switch. Drop it instead of guessing who created it.
    localStorage.removeItem(LEGACY_BILLING_CHECKOUT_INTENT_KEY);
    const raw = localStorage.getItem(storageKey);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (isBillingCheckoutIntent(parsed)) return parsed;
    localStorage.removeItem(storageKey);
  } catch {
    try {
      localStorage.removeItem(storageKey);
    } catch {
      // Storage is unavailable; checkout remains server-recoverable.
    }
  }
  return null;
}

export function writeBillingCheckoutIntent(
  accountId: string,
  intent: BillingCheckoutIntentV1,
): void {
  localStorage.removeItem(LEGACY_BILLING_CHECKOUT_INTENT_KEY);
  localStorage.setItem(billingCheckoutIntentKey(accountId), JSON.stringify(intent));
}

export function clearBillingCheckoutIntent(accountId: string): void {
  localStorage.removeItem(LEGACY_BILLING_CHECKOUT_INTENT_KEY);
  localStorage.removeItem(billingCheckoutIntentKey(accountId));
}

export function newBillingIdempotencyKey(kind: 'topup' | 'subscription' | 'retry'): string {
  return `desktop:${kind}:${crypto.randomUUID()}`;
}
