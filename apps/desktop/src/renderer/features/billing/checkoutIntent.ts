/**
 * Checkout state is ephemeral: the idempotency key and the current server
 * response live only in hook memory for the open dialog. Nothing is persisted
 * across restarts anymore — closing the dialog abandons the session and the
 * server replaces any stale payment action on the next create call.
 */

const LEGACY_STORAGE_KEYS = [
  'cindy.billing.checkout-intent.v1',
] as const;

const LEGACY_STORAGE_KEY_PREFIXES = [
  'cindy.billing.checkout-intent.v2',
  'cindy.billing.plan-change-intent.v1',
] as const;

/**
 * Old app versions persisted checkout / plan-change intents in localStorage
 * and replayed them on startup. Remove them without replaying: the server no
 * longer exposes recoverable payment tasks.
 */
export function clearLegacyBillingIntentStorage(accountId: string | null): void {
  try {
    for (const key of LEGACY_STORAGE_KEYS) localStorage.removeItem(key);
    if (accountId) {
      for (const prefix of LEGACY_STORAGE_KEY_PREFIXES) {
        localStorage.removeItem(`${prefix}:${encodeURIComponent(accountId)}`);
      }
    }
  } catch {
    // Storage unavailable; nothing to clean.
  }
}

export function newBillingIdempotencyKey(
  kind: 'topup' | 'subscription' | 'retry' | 'plan-change',
): string {
  return `desktop:${kind}:${crypto.randomUUID()}`;
}
