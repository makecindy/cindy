import { createGenericOAuthService } from './generic-oauth.js';
import { outboundFetch } from './outbound-fetch.desktop.js';
export type * from './generic-oauth.js';



export { parseModelsListResponse } from "@cindy/model-providers";

export const { readGenericOAuthAccessToken, getGenericOAuthLoginGeneration, configureGenericOAuth, hasGenericOAuthLogin, logoutGenericOAuth, removeGenericOAuthCredentialsReversibly, resetGenericOAuthMemoryCache, refreshGenericOAuthIfNeeded, readCachedGenericOAuthAccessToken, cancelGenericOAuthLogin, runGenericOAuthLogin, deriveModelsDiscoveryUrl, discoverGenericOAuthModels } = createGenericOAuthService({ fetchImpl: outboundFetch });
