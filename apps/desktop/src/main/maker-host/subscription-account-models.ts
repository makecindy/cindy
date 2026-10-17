import { activeOwnerScopeKey, ownerScopedUserDataPath } from '../appSessionState.js';
import { subscriptionAccountKind } from './subscription-account-auth.js';
import { getGrokAccessToken, peekGrokAccessToken, hasGrokOAuthLogin } from './grok-oauth-login.js';
import { refreshXaiMediaModels } from './model-discovery/xai-media.js';
import { refreshXaiModelsFromHttp } from './model-discovery/xai.js';
import { setXaiDiscoveredModels } from './active-catalog.js';
import { invalidateXaiBridgeAuth } from './xai-auth-invalidation-host.js';

/** 独立订阅账号的模型清单刷新。独立 Claude 账号已停用,不拉清单(返回 false)。 */
export async function refreshSubscriptionAccountModels(providerId: string): Promise<boolean> {
  const kind = subscriptionAccountKind(providerId);
  if (kind === 'xai') {
    const owner = activeOwnerScopeKey();
    const chat = await refreshXaiModelsFromHttp({
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
    if (owner !== activeOwnerScopeKey() || subscriptionAccountKind(providerId) !== 'xai') return false;
    const media = await refreshXaiMediaModels(providerId);
    return chat || media;
  }
  return false;
}
