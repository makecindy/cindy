import { createUtilityTextRuntime } from '@cindy/model-providers/utility-model/runtime';

import { createLogger } from '../logger.js';
import { getAppCapabilities } from '../appCapabilities.js';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../appSessionState.js';
import { readClaudeApiKey } from '../maker-host/auth-adapters.js';
import {
  getChatgptBridgeAuth,
  getChatgptBridgeAuthForDispatch,
} from '../maker-host/anthropic-responses-bridge-host.js';
import {
  getGrokAccessToken,
  getGrokOAuthCredentialGeneration,
} from '../maker-host/grok-oauth-login.js';
import { readCachedGenericOAuthAccessToken } from '../maker-host/generic-oauth.js';
// undici 的 fetch,但 per-request 现取系统代理(裸 undici 不吃代理设置)。
import { outboundUndiciFetch as undiciFetch } from '../maker-host/outbound-fetch.js';
import { claudeUpstreamEndpoint } from '../maker-host/runtime-configs.js';
import { getActiveCatalog, isXdGatewayPaymentRequiredRoute } from '../maker-host/active-catalog.js';
import { readModelDisableOverrides } from '../maker-host/model-disable-store.js';
import {
  getProviderRouteCredentialRevision,
  isProviderRouteMutationInProgress,
} from '../maker-host/provider-route.js';
import { withOpenCodeGoSessionHeader } from '../maker-host/opencode-go-session.js';
import { effectiveXdGatewayBaseUrl } from '../model-access/effectiveEndpoint.js';
import { reportCindyGatewayKeyRejected } from '../model-access/gatewayKeyRejection.js';
import { readCustomProviderKey } from '../secrets/providerSecretStore.js';
import {
  MANAGED_OLLAMA_PROVIDER_ID,
  isManagedSidecarProviderId,
} from '../../shared/localModelRuntime.js';
import { ensureManagedOllamaReadyForSession } from '../local-model-runtime/preflight.js';
import { getUtilityModelChainProfiles } from './UtilityModelSelection.js';
import { getEffectiveAuxiliaryModelChain } from './resolveAuxiliaryModelChain.js';
export type {
  UtilityTextCapability,
  UtilityTextCandidate,
  DedicatedAutoReviewCandidate,
  AutoReviewAuxiliaryFallback,
  UtilityTextRequestOptions,
  UtilityTextDispatchRoute,
} from '@cindy/model-providers/utility-model/runtime';
export { DEDICATED_AUTO_REVIEW_CANDIDATES } from '@cindy/model-providers/utility-model/runtime';
const runtime = createUtilityTextRuntime({
  log: createLogger('utility-model:one-shot'),
  getAppCapabilities: (...args) => getAppCapabilities(...args),
  activeOwnerScopeKey: (...args) => activeOwnerScopeKey(...args),
  isAppSessionBoundaryPending: (...args) => isAppSessionBoundaryPending(...args),
  readClaudeApiKey: (...args) => readClaudeApiKey(...args),
  getChatgptBridgeAuth: (...args) => getChatgptBridgeAuth(...args),
  getChatgptBridgeAuthForDispatch: (...args) => getChatgptBridgeAuthForDispatch(...args),
  getGrokAccessToken: (...args) => getGrokAccessToken(...args),
  getGrokOAuthCredentialGeneration: (...args) => getGrokOAuthCredentialGeneration(...args),
  readCachedGenericOAuthAccessToken: (...args) => readCachedGenericOAuthAccessToken(...args),
  undiciFetch: (...args) => undiciFetch(...args),
  claudeUpstreamEndpoint: (...args) => claudeUpstreamEndpoint(...args),
  getActiveCatalog: (...args) => getActiveCatalog(...args),
  isXdGatewayPaymentRequiredRoute: (...args) => isXdGatewayPaymentRequiredRoute(...args),
  readModelDisableOverrides: (...args) => readModelDisableOverrides(...args),
  getProviderRouteCredentialRevision: (...args) => getProviderRouteCredentialRevision(...args),
  isProviderRouteMutationInProgress: (...args) => isProviderRouteMutationInProgress(...args),
  withOpenCodeGoSessionHeader: (...args) => withOpenCodeGoSessionHeader(...args),
  effectiveXdGatewayBaseUrl: (...args) => effectiveXdGatewayBaseUrl(...args),
  reportCindyGatewayKeyRejected: (...args) => reportCindyGatewayKeyRejected(...args),
  readCustomProviderKey: (...args) => readCustomProviderKey(...args),
  MANAGED_OLLAMA_PROVIDER_ID,
  isManagedSidecarProviderId: (...args) => isManagedSidecarProviderId(...args),
  ensureManagedOllamaReadyForSession: (...args) => ensureManagedOllamaReadyForSession(...args),
  getUtilityModelChainProfiles: (...args) => getUtilityModelChainProfiles(...args),
  getEffectiveAuxiliaryModelChain: (...args) => getEffectiveAuxiliaryModelChain(...args),
});
export const {
  isUtilityRoutePaymentRequired,
  agentSupportsOneShot,
  getUtilityTextCandidates,
  isUtilityRouteDisabled,
  isProviderRouteSuspended,
  isProviderModelRouteDisabled,
  requestUtilityText,
  requestExplicitUtilityText,
  createCustomAutoReviewFallback,
  requestDedicatedAutoReviewCandidateText,
  toAnthropicApiModelId,
} = runtime;
