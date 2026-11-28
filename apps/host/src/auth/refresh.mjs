/**
 * Renew the adopted Cindy account session from the Host.
 *
 * The one renewal of the account session the Host has; every caller in main.ts (the renewal timer,
 * the server API's 401 retry, Device Link's auth failure, the first startup, /api/auth/refresh)
 * goes through it. It is the one shared credential the Host writes while a Cindy desktop app
 * running on its own uses the profile (coexistence row, C): the Host would sign itself out
 * otherwise. So it renews as the desktop's runtime refresh does (authManager.ts refresh() and
 * commitDesktopRefreshCredentials), and the two processes can renew one login in turn:
 * 1. A rejected token is retried with the replacement another process wrote: the shared
 *    runRefreshWithReplacementRetry over the three stored sources, in the desktop's order (the v1
 *    session record, the vault's active resource, the legacy bare token of the build's region).
 * 2. After the request, before judging a failure, the v1 record is read again; when it no longer
 *    holds a token this renewal had rejected, the failure is another session's and is dropped.
 *    Host difference: the desktop compares only the last token tried. A Host login leaves an older
 *    token of the same account in the vault (`cindy-host login` writes only the v1 record); when
 *    the v1 token is rejected and that older one is tried last, the v1 record still holds a
 *    rejected token, and the failure is definitive instead of being retried for ever.
 * 3. Only a definitive failure while the record still holds that token signs out (the caller does,
 *    in this process only; the Host deletes no stored credential). DEVICE_MISMATCH the same: this
 *    process only, the stored credentials stay.
 * 4. The result is written under the account-vault lock both processes take, after reading
 *    everything again: the vault by the desktop's rule (authRefreshCommit.ts), then the v1 record
 *    (with this login's Host device binding) and the legacy bare token when it exists. A renewal
 *    that no longer holds its token writes no v1 record.
 *    Host difference: the v1 record is also kept when it still held the token although the vault
 *    names no or another active account (`cindy-host login` writes only the v1 record).
 * 5. A record that exists but cannot be read now is a transient failure; only a missing one
 *    ends the session.
 * The access token stays in memory only.
 */

import path from 'node:path';

import { accountVaultKey, AuthApiError, parseAuthSessionRecord, serializeAuthSessionRecord } from '@cindy/auth-client';

import { readSessionDeviceId, serializeHostSession } from './device-identity.mjs';
import {
  AUTH_ACCOUNT_LOGOUT_TOMBSTONES_KEY,
  AUTH_ACCOUNT_VAULT_KEY,
  AUTH_SESSION_KEY,
  LEGACY_RESOURCE_REFRESH_TOKEN_KEY,
} from '../../../desktop/src/main/authCredentialKeys.ts';
import { runRefreshWithReplacementRetry } from '../../../desktop/src/main/authRefreshFailure.ts';
import {
  applyRefreshedCredentialsToVault,
  AUTH_ACCOUNT_VAULT_LOCK_FILE,
  AUTH_ACCOUNT_VAULT_VERSION,
} from '../../../desktop/src/main/authRefreshCommit.ts';
import { withCrossProcessLock } from '../../../desktop/src/main/device-link/crossProcessLock.ts';

/** authManager.ts REFRESH_TOKEN_REPLACEMENT_RETRY_LIMIT and RUNTIME_REFRESH_TOKEN_REPLACEMENT_RECHECK_DELAYS_MS. */
export const HOST_REFRESH_REPLACEMENT_RETRY_LIMIT = 2;
export const HOST_REFRESH_REPLACEMENT_RECHECK_DELAYS_MS = Object.freeze([250, 1000]);

/** The stored session is gone: the session ends (step 5). */
export class HostSessionMissingError extends Error {
  constructor() {
    super('no stored Cindy session to refresh');
    this.name = 'HostSessionMissingError';
  }
}

/** The renewal did not settle anything: the session stays, renew again later. */
export class HostRefreshDeferredError extends Error {
  /** @param {string} message @param {{retryAt?: number, networkFailure?: boolean}} [options] */
  constructor(message, options = {}) {
    super(message);
    this.name = 'HostRefreshDeferredError';
    this.retryAt = options.retryAt;
    this.networkFailure = options.networkFailure === true;
  }
}

/**
 * The account-vault lock of a profile, as the desktop's transactAuthAccountVault takes it. The
 * server has already rotated the token when the result is written, so a busy lock is waited out
 * (as `waitWhileBusyAfterRotation`); an unavailable one fails.
 * @param {string} userDataDir
 * @returns {<T>(task: () => T | Promise<T>) => Promise<T>}
 */
export function hostAccountVaultLock(userDataDir) {
  const lockPath = path.join(userDataDir, AUTH_ACCOUNT_VAULT_LOCK_FILE);
  return async (task) => {
    for (;;) {
      const attempt = await withCrossProcessLock(lockPath, { label: 'auth-account-vault', waitMs: 5000 },
        async (lock) => (lock.held ? { done: true, value: await task() } : { done: false, reason: lock.reason }));
      if (attempt.done) return attempt.value;
      if (attempt.reason !== 'busy') throw new HostRefreshDeferredError('Saved account credentials are unavailable now');
    }
  };
}

function readOrNull(store, key) {
  try { return store.read(key); } catch { return null; }
}

function readSession(store) {
  return parseAuthSessionRecord(readOrNull(store, AUTH_SESSION_KEY));
}

/**
 * The vault as the desktop's readAuthAccountVault presents it to the commit rule (logout tombstones
 * merged, an active account that is logged out or missing is none), and the stored object.
 * Throws when either record cannot be read or is not a vault.
 */
function readVault(store) {
  const raw = store.read(AUTH_ACCOUNT_VAULT_KEY);
  const tombstoneRaw = store.read(AUTH_ACCOUNT_LOGOUT_TOMBSTONES_KEY);
  const tombstones = tombstoneRaw ? JSON.parse(tombstoneRaw) : { version: 1, accountKeys: [] };
  if (tombstones?.version !== 1 || !Array.isArray(tombstones.accountKeys)) throw new Error('Saved account logout state is unavailable');
  const stored = raw ? JSON.parse(raw) : null;
  if (stored !== null && (![1, AUTH_ACCOUNT_VAULT_VERSION].includes(stored?.version) || !stored.resources || typeof stored.resources !== 'object'
    || !stored.passports || typeof stored.passports !== 'object')) throw new Error('Saved accounts are unavailable');
  const resources = { ...(stored?.resources ?? {}) };
  const loggedOut = [...new Set([...(stored?.loggedOutAccountKeys ?? []), ...tombstones.accountKeys])];
  const active = typeof stored?.activeAccountKey === 'string' ? stored.activeAccountKey : null;
  const view = {
    version: AUTH_ACCOUNT_VAULT_VERSION,
    activeAccountKey: active && resources[active] && !loggedOut.includes(active) ? active : null,
    resources,
    passports: stored?.passports ?? {},
    ...(loggedOut.length > 0 ? { loggedOutAccountKeys: loggedOut } : {}),
    ...(typeof stored?.signedOutAt === 'number' ? { signedOutAt: stored.signedOutAt } : {}),
  };
  return { stored, view };
}

/** authManager.ts readStoredRefreshTokenCandidates: every source, in order, not folded. */
function readStoredRefreshTokenCandidates(store, realm, buildRegion) {
  const session = readSession(store);
  let activeResource;
  try {
    const { view } = readVault(store);
    activeResource = view.activeAccountKey ? view.resources[view.activeAccountKey] : undefined;
  } catch { activeResource = undefined; }
  return [
    session?.realm === realm ? session.refreshToken : null,
    activeResource?.realm === realm && typeof activeResource.refreshToken === 'string' ? activeResource.refreshToken : null,
    realm === buildRegion ? readOrNull(store, LEGACY_RESOURCE_REFRESH_TOKEN_KEY) : null,
  ];
}

/** CindyAuthClient.refresh as the shared runner's request (authManager.ts refreshSavedResourceSession). */
async function requestRefresh(refresh, refreshToken) {
  try {
    const pair = await refresh(refreshToken);
    return { ok: true, status: 200, data: pair };
  } catch (error) {
    if (!(error instanceof AuthApiError)) throw error;
    return { ok: false, status: error.statusCode, data: { error: { code: error.code } }, retryAt: error.retryAt, error };
  }
}

/**
 * Write the renewal under the account-vault lock (step 4). Returns whether this renewal still owned
 * the session and wrote its v1 record.
 */
function commitRenewal(store, input) {
  const { pair, realm, requestedToken, buildRegion, deviceId } = input;
  const session = readSession(store);
  const sessionHeldToken = session?.realm === realm && session.refreshToken === requestedToken;
  let commit = 'unknown';
  if (pair.membership?.id) {
    try {
      const { stored, view } = readVault(store);
      const key = accountVaultKey(realm, pair.membership.id);
      const activeBefore = view.activeAccountKey;
      const resourceBefore = JSON.stringify(view.resources[key] ?? null);
      commit = applyRefreshedCredentialsToVault(view, {
        pair, realm, requestedRefreshToken: requestedToken, buildRegion,
        readStoredSession: () => session,
        readLegacyResourceRefreshToken: () => readOrNull(store, LEGACY_RESOURCE_REFRESH_TOKEN_KEY),
      });
      if (stored && JSON.stringify(view.resources[key] ?? null) !== resourceBefore) {
        // Only what the rule changed; the rest of the stored vault is written back as it was read.
        // Legacy-readable version, as the desktop's writeAuthAccountVault.
        const next = { ...stored, version: 1, resources: { ...stored.resources, [key]: view.resources[key] } };
        if (view.activeAccountKey !== activeBefore) { next.activeAccountKey = view.activeAccountKey; delete next.signedOutAt; }
        store.write(AUTH_ACCOUNT_VAULT_KEY, JSON.stringify(next));
      }
    } catch (error) {
      // The vault cannot be read or written now: the v1 record this login renews from is still kept.
      console.warn('[host] auth refresh: the saved-account vault was not updated:', error instanceof Error ? error.message : String(error));
    }
  }
  if (commit !== 'active' && !sessionHeldToken) return { owned: false, commit };
  if (session?.realm !== realm || session.refreshToken !== pair.refreshToken) {
    store.write(AUTH_SESSION_KEY, deviceId
      ? serializeHostSession(realm, pair.refreshToken, deviceId)
      : serializeAuthSessionRecord(realm, pair.refreshToken));
  }
  mirrorLegacyResourceRefreshToken(store, pair.refreshToken, realm, buildRegion);
  return { owned: true, commit };
}

/** authManager.ts mirrorLegacyResourceRefreshToken: only the build's region, only when the file exists. */
function mirrorLegacyResourceRefreshToken(store, refreshToken, realm, buildRegion) {
  if (realm !== buildRegion) return;
  let current;
  try { current = store.read(LEGACY_RESOURCE_REFRESH_TOKEN_KEY); } catch { current = undefined; }
  if (current === null || current === refreshToken) return;
  try { store.write(LEGACY_RESOURCE_REFRESH_TOKEN_KEY, refreshToken); }
  catch (error) {
    console.warn('[host] auth refresh: the legacy credential file was not updated; older apps catch up at the next renewal:',
      error instanceof Error ? error.message : String(error));
  }
}

/**
 * @typedef {object} RefreshResult
 * @property {string} sessionToken
 * @property {'cn' | 'global'} realm
 * @property {boolean} rotated
 * @property {number} replacementRetries
 */

/**
 * @param {{
 *   store: {read(key: string): string | null, write(key: string, value: string): void},
 *   refresh(refreshToken: string): Promise<{accessToken: string, refreshToken?: string, membership?: {id: string, passportId?: string}}>,
 *   withVaultLock<T>(task: () => T | Promise<T>): Promise<T>,
 *   buildRegion: 'cn' | 'global',
 *   sleep?: (ms: number) => Promise<void>,
 * }} deps
 * @returns {Promise<RefreshResult>}
 * @throws {HostSessionMissingError} the stored session is gone
 * @throws {HostRefreshDeferredError} nothing settled; keep the session and renew later
 * @throws {AuthApiError} a definitive rejection (or DEVICE_MISMATCH) of the token still stored
 */
export async function refreshHostSession(deps) {
  let raw;
  try { raw = deps.store.read(AUTH_SESSION_KEY); }
  catch { throw new HostRefreshDeferredError('the stored Cindy session cannot be read now'); }
  if (raw === null) throw new HostSessionMissingError();
  const record = parseAuthSessionRecord(raw);
  if (!record) throw new HostRefreshDeferredError('the stored Cindy session cannot be read now');
  const deviceId = readSessionDeviceId(raw);
  const { realm } = record;

  const run = await runRefreshWithReplacementRetry(record.refreshToken, {
    doRefresh: token => requestRefresh(deps.refresh, token),
    readLatestStoredTokens: () => readStoredRefreshTokenCandidates(deps.store, realm, deps.buildRegion),
    maxReplacementRetries: HOST_REFRESH_REPLACEMENT_RETRY_LIMIT,
    replacementRecheck: { delaysMs: HOST_REFRESH_REPLACEMENT_RECHECK_DELAYS_MS, sleep: deps.sleep },
  });
  const { result, requestedToken } = run;
  if (!result.ok) {
    const latest = readSession(deps.store);
    if (latest?.realm !== realm || !run.rejectedTokens.includes(latest.refreshToken))
      throw new HostRefreshDeferredError('the stored session changed while renewing; that failure is not the current session\'s');
    const action = run.failureAction ?? { kind: 'transient-failure' };
    if (action.kind === 'definitive-failure' || action.kind === 'foreign-device') throw result.error;
    throw new HostRefreshDeferredError(`the renewal failed for now (${result.error?.code ?? result.status}): ${result.error?.message ?? 'no response'}`,
      { retryAt: result.retryAt, networkFailure: result.status === 0 });
  }
  const pair = result.data;
  if (!pair?.accessToken) throw new Error('refresh response contained no access token');
  const rotated = Boolean(pair.refreshToken && pair.refreshToken !== requestedToken);
  if (rotated || requestedToken !== record.refreshToken) {
    const { owned } = await deps.withVaultLock(() => commitRenewal(deps.store, {
      pair: { ...pair, refreshToken: pair.refreshToken || requestedToken }, realm, requestedToken, buildRegion: deps.buildRegion, deviceId,
    }));
    if (!owned) throw new HostRefreshDeferredError('another process holds the stored session now');
  }
  return { sessionToken: pair.accessToken, realm, rotated, replacementRetries: run.replacementRetries };
}
