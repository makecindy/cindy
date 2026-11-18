// The one-shot requests live in oneShotCandidatesCore.ts (shared with the Node Host). This
// module builds the single Desktop instance; its ports resolve the Desktop modules when
// called, never when this module loads.
export { isProviderModelRouteDisabled, isProviderRouteSuspended } from '../maker-host/model-route-availability.js';
import { readClaudeApiKey } from '../maker-host/auth-adapters.js';
import { getChatgptBridgeAuth, getChatgptBridgeAuthForDispatch } from '../maker-host/anthropic-responses-bridge-host.js';
import { getGrokAccessToken, getGrokOAuthCredentialGeneration } from '../maker-host/grok-oauth-login.desktop.js';
import { readCachedGenericOAuthAccessToken, readGenericOAuthAccessToken, getGenericOAuthLoginGeneration } from '../maker-host/generic-oauth.desktop.js';
// undici 的 fetch,但 per-request 现取系统代理(裸 undici 不吃代理设置)。
import { outboundUndiciFetch as undiciFetch } from '../maker-host/outbound-fetch.desktop.js';
import { claudeUpstreamEndpoint } from '../maker-host/runtime-configs.js';
import { reportCindyGatewayKeyRejected } from '../model-access/gatewayKeyRejection.js';
import { readCustomProviderKey } from '../secrets/providerSecretStore.js';
import { ensureManagedOllamaReadyForSession } from '../local-model-runtime/preflight.js';
import { getUtilityModelChainProfiles } from './UtilityModelSelection.js';
import { getEffectiveAuxiliaryModelChain } from './resolveAuxiliaryModelChain.js';
// After the Desktop modules, so module evaluation keeps the former order.
import { createOneShotCandidates } from './oneShotCandidatesCore.js';

export { DEDICATED_AUTO_REVIEW_CANDIDATES } from './oneShotCandidatesCore.js';
export type {
  AutoReviewAuxiliaryFallback,
  DedicatedAutoReviewCandidate,
  UtilityTextCandidate,
  UtilityTextCapability,
  UtilityTextDispatchRoute,
  UtilityTextRequestOptions,
} from './oneShotCandidatesCore.js';

const desktopOneShot = createOneShotCandidates({
  readClaudeApiKey: (...args) => readClaudeApiKey(...args),
  getChatgptBridgeAuth: (...args) => getChatgptBridgeAuth(...args),
  getChatgptBridgeAuthForDispatch: (...args) => getChatgptBridgeAuthForDispatch(...args),
  getGrokAccessToken: (...args) => getGrokAccessToken(...args),
  getGrokOAuthCredentialGeneration: (...args) => getGrokOAuthCredentialGeneration(...args),
  readCachedGenericOAuthAccessToken: (...args) => readCachedGenericOAuthAccessToken(...args),
  readGenericOAuthAccessToken: (...args) => readGenericOAuthAccessToken(...args),
  getGenericOAuthLoginGeneration: (...args) => getGenericOAuthLoginGeneration(...args),
  undiciFetch: (...args) => undiciFetch(...args),
  claudeUpstreamEndpoint: (...args) => claudeUpstreamEndpoint(...args),
  reportCindyGatewayKeyRejected: (...args) => reportCindyGatewayKeyRejected(...args),
  readCustomProviderKey: (...args) => readCustomProviderKey(...args),
  ensureManagedOllamaReadyForSession: (...args) => ensureManagedOllamaReadyForSession(...args),
  getUtilityModelChainProfiles: (...args) => getUtilityModelChainProfiles(...args),
  getEffectiveAuxiliaryModelChain: (...args) => getEffectiveAuxiliaryModelChain(...args),
});
type Instance = typeof desktopOneShot;

export function isUtilityRoutePaymentRequired(...args: Parameters<Instance['isUtilityRoutePaymentRequired']>): ReturnType<Instance['isUtilityRoutePaymentRequired']> {
  return desktopOneShot.isUtilityRoutePaymentRequired(...args);
}

export function agentSupportsOneShot(...args: Parameters<Instance['agentSupportsOneShot']>): ReturnType<Instance['agentSupportsOneShot']> {
  return desktopOneShot.agentSupportsOneShot(...args);
}

export function getUtilityTextCandidates(...args: Parameters<Instance['getUtilityTextCandidates']>): ReturnType<Instance['getUtilityTextCandidates']> {
  return desktopOneShot.getUtilityTextCandidates(...args);
}

export function isUtilityRouteDisabled(...args: Parameters<Instance['isUtilityRouteDisabled']>): ReturnType<Instance['isUtilityRouteDisabled']> {
  return desktopOneShot.isUtilityRouteDisabled(...args);
}

export function requestUtilityText(...args: Parameters<Instance['requestUtilityText']>): ReturnType<Instance['requestUtilityText']> {
  return desktopOneShot.requestUtilityText(...args);
}

export function requestExplicitUtilityText(...args: Parameters<Instance['requestExplicitUtilityText']>): ReturnType<Instance['requestExplicitUtilityText']> {
  return desktopOneShot.requestExplicitUtilityText(...args);
}

export function createCustomAutoReviewFallback(...args: Parameters<Instance['createCustomAutoReviewFallback']>): ReturnType<Instance['createCustomAutoReviewFallback']> {
  return desktopOneShot.createCustomAutoReviewFallback(...args);
}

export function requestDedicatedAutoReviewCandidateText(...args: Parameters<Instance['requestDedicatedAutoReviewCandidateText']>): ReturnType<Instance['requestDedicatedAutoReviewCandidateText']> {
  return desktopOneShot.requestDedicatedAutoReviewCandidateText(...args);
}

export function toAnthropicApiModelId(...args: Parameters<Instance['toAnthropicApiModelId']>): ReturnType<Instance['toAnthropicApiModelId']> {
  return desktopOneShot.toAnthropicApiModelId(...args);
}
