import { activeOwnerScopeKey, isAppSessionBoundaryPending, ownerScopedUserDataPath } from '../appSessionState.js';
import { genericOAuthSecretIo } from '../secrets/providerSecretStore.js';
import { getActiveCatalog, setDiscoveredProviderModels, setXaiDiscoveredModels } from './active-catalog.js';
import { discardXaiModelsDiskCache } from './model-discovery/xai.js';
import {
  runGrokOAuthLogin,
  cancelGrokOAuthLogin,
  hasGrokOAuthLogin,
  grokAccountIdentity,
  logoutGrok,
  resetGrokOAuthMemoryCache,
} from './grok-oauth-login.js';
import { createLogger } from '../logger.js';

const log = createLogger('subscription-account-auth');
let onInvalidated: (providerId: string) => void = () => {};
export function setSubscriptionAccountInvalidatedHandler(handler: typeof onInvalidated): void {
  onInvalidated = handler;
}
/**
 * 独立 Claude 账号已停用的归因。它的凭证是 Cindy 自己跑 OAuth 登录后保存的,而 Claude 订阅
 * 只允许经官方 Claude Code CLI 自己的登录使用(见 claude-native-cli);已有条目保留在设置里
 * 供用户查看 / 删除,不再参与任何会话。
 */
export const CLAUDE_ACCOUNT_RETIRED_REASON = 'claude_account_retired';

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
export function subscriptionAccountState(providerId: string): {
  authenticated: boolean;
  identity?: string;
  errorReason?: string;
  authSource: 'oauth';
} {
  const kind = subscriptionAccountKind(providerId);
  if (kind === 'claude') {
    return { authenticated: false, errorReason: CLAUDE_ACCOUNT_RETIRED_REASON, authSource: 'oauth' };
  }
  return {
    authenticated: kind === 'xai' ? hasGrokOAuthLogin(providerId) : false,
    identity: kind === 'xai' ? grokAccountIdentity(providerId) : undefined,
    authSource: 'oauth',
  };
}
const logins = new Map<string, { cancel: () => void }>();
export function cancelSubscriptionAccountLogin(providerId: string): void {
  logins.get(`${activeOwnerScopeKey()}:${providerId}`)?.cancel();
}
export function resetSubscriptionAccountCaches(): void {
  for (const operation of logins.values()) operation.cancel();
}
export async function loginSubscriptionAccount(
  providerId: string,
  isCurrent: () => boolean,
  options?: {
    method?: 'browser' | 'device';
    onDeviceCode?: (code: { userCode: string; verificationUrl: string; expiresAt: number }) => void;
  },
): Promise<{
  ok: boolean;
  reason?: string;
  firstLogin?: boolean;
  rollbackCredentials?: () => boolean;
}> {
  const kind = subscriptionAccountKind(providerId);
  if (!kind) throw new Error('Unknown subscription account');
  if (kind === 'claude') return { ok: false, reason: CLAUDE_ACCOUNT_RETIRED_REASON };
  if (kind !== 'xai' && options?.method === 'device') throw new Error('Device login is only available for Grok');
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
      cancelGrokOAuthLogin(providerId);
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
      const raw = JSON.stringify(blob);
      if (!genericOAuthSecretIo.write(providerId, raw))
        throw new Error('Failed to save account credentials');
      written = raw;
    };
    const result = await runGrokOAuthLogin({
      isCurrent: current,
      persist,
      method: options?.method,
      onDeviceCode: options?.onDeviceCode,
    }, providerId);
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
