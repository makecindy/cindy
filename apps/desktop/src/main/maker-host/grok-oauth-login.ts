import { shell } from 'electron';
import { createGrokOAuthRuntime } from '@cindy/model-providers/provider-auth/grok-oauth';
import { desktopMakerLogger } from './logger-adapter.js';
import { retainInvalidatedProviderPresentation } from './provider-presentation-store.js';
import { outboundFetch } from './outbound-fetch.js';
import { genericOAuthSecretIo, getProviderSecretStore } from '../secrets/providerSecretStore.js';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../appSessionState.js';
import { OwnerBoundaryPendingError } from './owner-boundary-error.js';
import {
  bindNativeProviderAuth,
  isNativeProviderAuthBound,
  unbindNativeProviderAuth,
} from './nativeProviderAuthBinding.js';


const runtime = createGrokOAuthRuntime({
  log: desktopMakerLogger.child('grok-oauth-login'), shell, outboundFetch,
  getProviderSecretStore, genericOAuthSecretIo, activeOwnerScopeKey,
  isAppSessionBoundaryPending, OwnerBoundaryPendingError, bindNativeProviderAuth,
  isNativeProviderAuthBound, unbindNativeProviderAuth, retainInvalidatedProviderPresentation,
});
export type { GrokTokenBlob, GrokDeviceCode, GrokOAuthLoginResult } from '@cindy/model-providers/provider-auth/grok-oauth';
export type CallbackListener = InstanceType<typeof runtime.CallbackListener>;
export const {
  xaiCallbackCorsHeaders,
  XAI_CALLBACK_PORT_OCCUPIED_MESSAGE,
  CallbackListener,
  cancelGrokOAuthLogin,
  isGrokOAuthLoginInProgress,
  getGrokOAuthCredentialGeneration,
  resetGrokOAuthMemoryCache,
  hasGrokOAuthLogin,
  hasGrokOAuthLoginUnbound,
  logoutGrok,
  runGrokOAuthLogin,
  getGrokAccessToken,
  peekGrokAccessToken,
  recoverGrokAuthAfterRejection,
  grokAccountIdentity
} = runtime;
