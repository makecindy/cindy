import { app } from 'electron';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { activeOwnerScopeKey, isAppSessionBoundaryPending, ownerScopedUserDataPath } from '../appSessionState.js';
import { genericOAuthSecretIo } from '../secrets/providerSecretStore.js';
import { getActiveCatalog, setDiscoveredProviderModels, setXaiDiscoveredModels } from './active-catalog.js';
import { discardXaiModelsDiskCache } from './model-discovery/xai.js';
import { createClaudeOAuthRefresher, type GetValidOAuthOptions } from './claude-oauth-refresh.js';
import { type ClaudeAiOAuth, readClaudeAiOAuth } from './claude-credentials-store.js';
import { runClaudeOAuthLogin, cancelClaudeOAuthLogin } from './claude-oauth-login.js';
import {
  runGrokOAuthLogin,
  cancelGrokOAuthLogin,
  hasGrokOAuthLogin,
  grokAccountIdentity,
  logoutGrok,
  resetGrokOAuthMemoryCache,
} from './grok-oauth-login.js';
import { outboundFetch } from './outbound-fetch.js';
import { createLogger } from '../logger.js';

const log = createLogger('subscription-account-auth');
let onInvalidated: (providerId: string) => void = () => {};
export function setSubscriptionAccountInvalidatedHandler(handler: typeof onInvalidated): void {
  onInvalidated = handler;
}
type AccountRefreshState = {
  refresher: ReturnType<typeof createClaudeOAuthRefresher>;
  invalidatedCredential?: string;
};
const refreshers = new Map<string, AccountRefreshState>();
function credentialFingerprint(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export function subscriptionAccountKind(providerId?: string | null): 'claude' | 'xai' | null {
  const native = getActiveCatalog().providers.find((p) => p.id === providerId)?.auth.native;
  return native === 'claude' || native === 'xai' ? native : null;
}
/** Account replacement/removal invalidates membership, never another connection's catalog. */
export function clearSubscriptionAccountDiscoveredModels(providerId: string): Promise<void> {
  setDiscoveredProviderModels(providerId, 'claude-code', []);
  setXaiDiscoveredModels(null, providerId);
  if (subscriptionAccountKind(providerId) === 'xai') {
    // Share the discovery writer's queue so an older pending write cannot recreate the LKG.
    return discardXaiModelsDiskCache({
      getScopeKey: () => `${activeOwnerScopeKey()}:${providerId}`,
      cacheFilePath: () => ownerScopedUserDataPath('model-discovery', `${providerId}-models.json`),
    });
  }
  return Promise.resolve();
}
export function isClaudeSubscriptionProviderId(providerId?: string | null): boolean {
  return providerId === 'anthropic' || subscriptionAccountKind(providerId) === 'claude';
}
export function isXaiSubscriptionProviderId(providerId?: string | null): boolean {
  return providerId === 'xai' || subscriptionAccountKind(providerId) === 'xai';
}
export function readClaudeAccountOAuth(providerId = 'anthropic'): ClaudeAiOAuth | null {
  if (providerId === 'anthropic') return readClaudeAiOAuth();
  if (subscriptionAccountKind(providerId) !== 'claude' || isAppSessionBoundaryPending())
    return null;
  try {
    const raw = genericOAuthSecretIo.read(providerId) ?? 'null';
    if (refreshers.get(`${activeOwnerScopeKey()}:${providerId}`)?.invalidatedCredential === credentialFingerprint(raw)) return null;
    const blob = JSON.parse(raw);
    return typeof blob?.accessToken === 'string' && blob.accessToken ? blob : null;
  } catch {
    return null;
  }
}
function claudeAccount(providerId: string) {
  const scope = activeOwnerScopeKey();
  const key = `${scope}:${providerId}`;
  let account = refreshers.get(key);
  if (!account) {
    const current = () => activeOwnerScopeKey() === scope && !isAppSessionBoundaryPending();
    const directory = path.join(
      app.getPath('userData'),
      'subscription-accounts',
      createHash('sha256').update(key).digest('hex'),
    );
    const refresher = createClaudeOAuthRefresher({
      readOAuth: () => (current() ? readClaudeAccountOAuth(providerId) : null),
      writeOAuth: (oauth) => {
        if (!current() || !genericOAuthSecretIo.write(providerId, JSON.stringify(oauth)))
          throw new Error('Failed to save account credentials');
      },
      fetchFn: outboundFetch,
      now: Date.now,
      lockDir: () => directory,
      onInvalidGrant: () => {
        if (!current()) return;
        const raw = genericOAuthSecretIo.readStrict(providerId);
        if (raw) account!.invalidatedCredential = credentialFingerprint(raw);
        account!.refresher.invalidate();
        if (!genericOAuthSecretIo.remove(providerId)) {
          log.warn('revoked account credential could not be removed; suppressing retained credential', { providerId });
        }
        void clearSubscriptionAccountDiscoveredModels(providerId);
        onInvalidated(providerId);
      },
    });
    account = { refresher };
    refreshers.set(key, account);
  }
  return account.refresher;
}
export async function getValidClaudeAccountOAuth(providerId: string, options?: GetValidOAuthOptions) {
  const scope = activeOwnerScopeKey();
  const result = await claudeAccount(providerId).getValidOAuth(options);
  // The native refresher may return its pre-refresh credential on a failed refresh.
  // Re-read after invalidation/login so that captured revoked credentials cannot escape.
  return result && activeOwnerScopeKey() === scope && !isAppSessionBoundaryPending()
    ? readClaudeAccountOAuth(providerId) : null;
}
export async function prepareClaudeAccountUsage(providerId: string): Promise<ClaudeAiOAuth | null> {
  const scope = activeOwnerScopeKey();
  const refresher = claudeAccount(providerId);
  const oauth = await getValidClaudeAccountOAuth(providerId);
  if (!oauth || activeOwnerScopeKey() !== scope) return null;
  if (!oauth.subscriptionType) await refresher.backfillSubscriptionProfile(oauth.accessToken);
  return activeOwnerScopeKey() === scope ? readClaudeAccountOAuth(providerId) : null;
}
export function subscriptionAccountState(providerId: string) {
  const kind = subscriptionAccountKind(providerId);
  const oauth = kind === 'claude' ? readClaudeAccountOAuth(providerId) : null;
  return {
    authenticated: kind === 'xai' ? hasGrokOAuthLogin(providerId) : !!oauth,
    identity:
      kind === 'xai'
        ? grokAccountIdentity(providerId)
        : typeof oauth?.identity === 'string'
          ? oauth.identity
          : undefined,
    authSource: 'oauth' as const,
  };
}
const logins = new Map<string, { cancel: () => void }>();
export function cancelSubscriptionAccountLogin(providerId: string): void {
  logins.get(`${activeOwnerScopeKey()}:${providerId}`)?.cancel();
}
export function resetSubscriptionAccountCaches(): void {
  for (const operation of logins.values()) operation.cancel();
  for (const account of refreshers.values()) account.refresher.invalidate();
  refreshers.clear();
}
export async function loginSubscriptionAccount(
  providerId: string,
  isCurrent: () => boolean,
): Promise<{
  ok: boolean;
  reason?: string;
  firstLogin?: boolean;
  rollbackCredentials?: () => boolean;
}> {
  const kind = subscriptionAccountKind(providerId);
  if (!kind) throw new Error('Unknown subscription account');
  const scope = activeOwnerScopeKey();
  const key = `${scope}:${providerId}`;
  if (logins.has(key)) return { ok: false, reason: 'login_in_progress' };
  const before = genericOAuthSecretIo.readStrict(providerId);
  let cancelled = false;
  let written: string | undefined;
  const current = () =>
    !cancelled && isCurrent() && activeOwnerScopeKey() === scope && !isAppSessionBoundaryPending();
  const operation = {
    cancel: () => {
      cancelled = true;
      if (kind === 'claude') cancelClaudeOAuthLogin(key);
      else cancelGrokOAuthLogin(providerId);
    },
  };
  logins.set(key, operation);
  const rollbackCredentials = () => {
    if (
      activeOwnerScopeKey() !== scope ||
      !written ||
      genericOAuthSecretIo.readStrict(providerId) !== written
    )
      return false;
    if (kind === 'claude') claudeAccount(providerId).invalidate();
    const restored =
      before === null
        ? genericOAuthSecretIo.remove(providerId)
        : genericOAuthSecretIo.write(providerId, before);
    if (kind === 'xai') resetGrokOAuthMemoryCache(providerId);
    if (restored) void clearSubscriptionAccountDiscoveredModels(providerId);
    return restored;
  };
  const restoreWrittenCredentials = () => {
    if (written && activeOwnerScopeKey() === scope && genericOAuthSecretIo.readStrict(providerId) === written) {
      if (!rollbackCredentials()) throw new Error('Failed to restore credentials after unsuccessful login');
    }
  };
  try {
    const persist = (blob: unknown) => {
      if (!current()) throw new Error('login_cancelled');
      if (kind === 'claude') claudeAccount(providerId).invalidate();
      const raw = JSON.stringify(blob);
      if (!genericOAuthSecretIo.write(providerId, raw))
        throw new Error('Failed to save account credentials');
      written = raw;
    };
    const result =
      kind === 'claude'
        ? await runClaudeOAuthLogin({
            loginKey: key,
            isCurrent: current,
            persist,
            backfill: async () => {},
          })
        : await runGrokOAuthLogin({ isCurrent: current, persist }, providerId);
    if (!current()) {
      restoreWrittenCredentials();
      return { ok: false, reason: 'login_cancelled' };
    }
    if (!result.ok && written && !rollbackCredentials()) {
      throw new Error('Failed to restore credentials after unsuccessful login');
    }
    if (result.ok) {
      await clearSubscriptionAccountDiscoveredModels(providerId);
      if (!current()) {
        restoreWrittenCredentials();
        return { ok: false, reason: 'login_cancelled' };
      }
    }
    // Profile backfill is deferred to the account refresher after the login transaction commits.
    return { ...result, firstLogin: before === null, rollbackCredentials };
  } catch (error) {
    restoreWrittenCredentials();
    throw error;
  } finally {
    if (logins.get(key) === operation) logins.delete(key);
  }
}
export function removeSubscriptionAccountCredentialsReversibly(providerId: string): () => boolean {
  cancelSubscriptionAccountLogin(providerId);
  const scope = activeOwnerScopeKey();
  const previous = genericOAuthSecretIo.readStrict(providerId);
  if (subscriptionAccountKind(providerId) === 'claude') claudeAccount(providerId).invalidate();
  if (subscriptionAccountKind(providerId) === 'xai') logoutGrok(providerId);
  else if (!genericOAuthSecretIo.remove(providerId))
    throw new Error('Failed to remove account credentials');
  void clearSubscriptionAccountDiscoveredModels(providerId);
  return () => {
    if (activeOwnerScopeKey() !== scope || genericOAuthSecretIo.readStrict(providerId) !== null)
      return false;
    const restored = previous === null || genericOAuthSecretIo.write(providerId, previous);
    if (subscriptionAccountKind(providerId) === 'xai') resetGrokOAuthMemoryCache(providerId);
    if (restored) void clearSubscriptionAccountDiscoveredModels(providerId);
    return restored;
  };
}
export function logoutSubscriptionAccount(providerId: string): void {
  removeSubscriptionAccountCredentialsReversibly(providerId);
}
