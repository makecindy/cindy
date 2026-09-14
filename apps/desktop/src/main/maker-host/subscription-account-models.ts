import { activeOwnerScopeKey, ownerScopedUserDataPath } from '../appSessionState.js';
import {
  subscriptionAccountKind,
  getValidClaudeAccountOAuth,
  readClaudeAccountOAuth,
} from './subscription-account-auth.js';
import { getGrokAccessToken, peekGrokAccessToken, hasGrokOAuthLogin } from './grok-oauth-login.js';
import { refreshXaiModelsFromHttp } from './model-discovery/xai.js';
import { mapAnthropicHttpModels } from './model-discovery/anthropic.js';
import { setXaiDiscoveredModels, setDiscoveredProviderModels } from './active-catalog.js';
import { invalidateXaiBridgeAuth } from './xai-auth-invalidation-host.js';
import { outboundFetch } from './outbound-fetch.js';

export async function refreshSubscriptionAccountModels(providerId: string): Promise<boolean> {
  const kind = subscriptionAccountKind(providerId);
  if (kind === 'xai')
    return refreshXaiModelsFromHttp({
      getAccessToken: () => getGrokAccessToken(providerId),
      peekAccessToken: () => peekGrokAccessToken(providerId),
      hasLogin: () =>
        subscriptionAccountKind(providerId) === 'xai' && hasGrokOAuthLogin(providerId),
      getConnectionSource: () => 'explicit-provider-oauth',
      getScopeKey: () => `${activeOwnerScopeKey()}:${providerId}`,
      cacheFilePath: () => ownerScopedUserDataPath('model-discovery', `${providerId}-models.json`),
      applySnapshot: (models) => setXaiDiscoveredModels(models, providerId),
      invalidateAuth: (failure) => invalidateXaiBridgeAuth(failure, providerId),
    });
  if (kind !== 'claude') return false;
  const scope = activeOwnerScopeKey();
  const oauth = await getValidClaudeAccountOAuth(providerId);
  if (!oauth || scope !== activeOwnerScopeKey()) return false;
  const current = () =>
    scope === activeOwnerScopeKey() &&
    readClaudeAccountOAuth(providerId)?.accessToken === oauth.accessToken;
  const entries: unknown[] = [];
  let after: string | undefined;
  for (let page = 0; page < 5; page++) {
    const url = new URL('https://api.anthropic.com/v1/models');
    url.searchParams.set('limit', '1000');
    if (after) url.searchParams.set('after_id', after);
    const response = await outboundFetch(url.toString(), {
      headers: {
        authorization: `Bearer ${oauth.accessToken}`,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'oauth-2025-04-20',
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok || !current()) return false;
    const raw = (await response.json()) as {
      data?: unknown[];
      has_more?: boolean;
      last_id?: string;
    };
    if (!Array.isArray(raw?.data)) return false;
    entries.push(...raw.data);
    if (!raw.has_more) {
      const models = mapAnthropicHttpModels(entries).map((entry) => entry.model);
      if (!models.length || !current()) return false;
      setDiscoveredProviderModels(providerId, 'claude-code', models);
      return true;
    }
    if (typeof raw.last_id !== 'string' || raw.last_id === after) return false;
    after = raw.last_id;
  }
  return false;
}
