import { createGenericOAuthRuntime } from '@cindy/model-providers/provider-auth/generic-oauth';
import { desktopMakerLogger } from './logger-adapter.js';
import { outboundFetch } from './outbound-fetch.js';

const runtime = createGenericOAuthRuntime({
  log: desktopMakerLogger.child('generic-oauth'),
  fetchImpl: outboundFetch,
});
export type {
  GenericOAuthStorage,
  GenericOAuthLoginResult,
  GenericOAuthDeviceCodeProgress,
  GenericOAuthLoginOptions,
} from '@cindy/model-providers/provider-auth/generic-oauth';
export { parseModelsListResponse } from '@cindy/model-providers';
export const {
  configureGenericOAuth,
  hasGenericOAuthLogin,
  logoutGenericOAuth,
  removeGenericOAuthCredentialsReversibly,
  resetGenericOAuthMemoryCache,
  refreshGenericOAuthIfNeeded,
  readCachedGenericOAuthAccessToken,
  cancelGenericOAuthLogin,
  runGenericOAuthLogin,
  deriveModelsDiscoveryUrl,
  discoverGenericOAuthModels,
} = runtime;
