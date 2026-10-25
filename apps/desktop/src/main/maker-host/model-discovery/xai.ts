/** xAI SuperGrok account model discovery and owner-scoped last-known-good snapshot. */

import { createXaiModelDiscovery, type XaiModelDiscoveryDeps } from '@cindy/model-providers/provider-auth/xai-model-discovery';
export type { XaiModelDiscoveryDeps } from '@cindy/model-providers/provider-auth/xai-model-discovery';

export { parseXaiAccountModels } from './xai-models.js';

import { activeOwnerScopeKey, ownerScopedUserDataPath } from '../../appSessionState.js';
import { createLogger } from '../../logger.js';
import { setXaiDiscoveredModels } from '../active-catalog.js';
import { getGrokAccessToken, hasGrokOAuthLogin, peekGrokAccessToken } from '../grok-oauth-login.js';
import { outboundFetch } from '../outbound-fetch.js';
import { invalidateXaiBridgeAuth } from '../xai-auth-invalidation-host.js';
import { getNativeProviderAuthSource } from '../nativeProviderAuthBinding.js';

const log = createLogger('model-discovery:xai');
const DEFAULT_DEPS: XaiModelDiscoveryDeps = {
  fetchImpl: outboundFetch,
  getAccessToken: getGrokAccessToken,
  peekAccessToken: peekGrokAccessToken,
  hasLogin: hasGrokOAuthLogin,
  getConnectionSource: () =>
    getNativeProviderAuthSource('xai') === 'explicit-provider-oauth'
      ? 'explicit-provider-oauth'
      : null,
  getScopeKey: activeOwnerScopeKey,
  cacheFilePath: () => ownerScopedUserDataPath('model-discovery', 'xai-models.json'),
  applySnapshot: setXaiDiscoveredModels,
  invalidateAuth: invalidateXaiBridgeAuth,
  log,
};
const runtime = createXaiModelDiscovery(DEFAULT_DEPS);
export const {
  XAI_ACCOUNT_USER_URL,
  XAI_ACCOUNT_MODELS_URL,
  XAI_GROK_CLIENT_VERSION,
  loadXaiModelsFromDiskCache,
  buildXaiCliProxyHeaders,
  refreshXaiModelsFromHttp,
  clearXaiDiscoveredModels,
  discardXaiModelsDiskCache,
  waitForXaiDiscoveryIdleForTest,
  resetXaiDiscoveryForTest
} = runtime;
