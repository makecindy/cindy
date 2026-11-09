import { shell } from 'electron';
import { outboundFetch } from './outbound-fetch.desktop.js';
import { genericOAuthSecretIo, getProviderSecretStore } from '../secrets/providerSecretStore.js';
import { createGrokOAuthService } from './grok-oauth-login.js';
export type CallbackListener = InstanceType<ReturnType<typeof createGrokOAuthService>['CallbackListener']>;
export type * from './grok-oauth-login.js';
export const { xaiCallbackCorsHeaders, XAI_CALLBACK_PORT_OCCUPIED_MESSAGE, CallbackListener, cancelGrokOAuthLogin, isGrokOAuthLoginInProgress, getGrokOAuthCredentialGeneration, resetGrokOAuthMemoryCache, hasGrokOAuthLogin, hasGrokOAuthLoginUnbound, logoutGrok, runGrokOAuthLogin, getGrokAccessToken, peekGrokAccessToken, recoverGrokAuthAfterRejection, grokAccountIdentity } = createGrokOAuthService({
  outboundFetch: (...args) => outboundFetch(...args),
  openExternal: url => shell.openExternal(url),
  genericOAuthSecretIo: {
    read: (...args) => genericOAuthSecretIo.read(...args),
    readStrict: (...args) => genericOAuthSecretIo.readStrict(...args),
    write: (...args) => genericOAuthSecretIo.write(...args),
    remove: (...args) => genericOAuthSecretIo.remove(...args),
  },
  getProviderSecretStore: () => getProviderSecretStore(),
});
