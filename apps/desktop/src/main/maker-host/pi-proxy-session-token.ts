/**
 * Restart-stable remote Pi proxy authentication.
 *
 * The HMAC key is owner-scoped and encrypted by Electron safeStorage. Only a
 * derived per-session token is passed to the remote Pi daemon; the host key
 * never leaves Desktop. Account-boundary secret clearing rotates the key and
 * invalidates the process cache so an old owner's daemon cannot authenticate.
 */
import { createHmac, randomBytes } from 'node:crypto';

import {
  addProviderSecretsClearedListener,
  readPiProxyDerivationKey,
  writePiProxyDerivationKey,
} from '../secrets/providerSecretStore.js';

const KEY_RE = /^[a-f0-9]{64}$/;
let cachedKey: string | null | undefined;
let unregisterClearListener: (() => void) | null = null;

function ensureClearListener(): void {
  if (unregisterClearListener) return;
  unregisterClearListener = addProviderSecretsClearedListener(() => {
    cachedKey = undefined;
  });
}

function getOrCreateDerivationKey(): string | null {
  ensureClearListener();
  if (cachedKey !== undefined) return cachedKey;
  const existing = readPiProxyDerivationKey();
  if (existing && KEY_RE.test(existing)) {
    cachedKey = existing;
    return existing;
  }
  const created = randomBytes(32).toString('hex');
  if (!writePiProxyDerivationKey(created)) return null;
  cachedKey = created;
  return created;
}

export function derivePiProxySessionToken(sessionId: string): string {
  const key = getOrCreateDerivationKey();
  if (!key) {
    throw new Error(
      '[PI_PROXY_DERIVATION_KEY_UNAVAILABLE] Cannot persist remote Pi proxy authentication; reconnect after secure storage becomes available.',
    );
  }
  return createHmac('sha256', key).update(sessionId).digest('base64url');
}

/** Test-only process restart simulation; does not delete the persisted key. */
export function resetPiProxyDerivationKeyCacheForTests(): void {
  cachedKey = undefined;
  unregisterClearListener?.();
  unregisterClearListener = null;
}
