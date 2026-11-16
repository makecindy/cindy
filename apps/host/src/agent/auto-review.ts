import type { AutoReviewDelegate, Maker } from '@cindy/maker-core';
import { createOneShotCandidates, DEDICATED_AUTO_REVIEW_CANDIDATES } from '../../../desktop/src/main/utility-model/oneShotCandidatesCore.js';
import { AUTO_REVIEW_ROUTER_GUARD_TIMEOUT_MS, createAutoReviewModelRouter } from '../../../desktop/src/main/maker-host/autoReviewModelRouterCore.js';
import { createAutoPermissionReviewer } from '../../../desktop/src/main/maker-host/auto-permission-reviewer.js';
import { createToolLoopReviewer } from '../../../desktop/src/main/maker-host/tool-loop-reviewer.js';
import type { createAnthropicResponsesBridgeHost } from '../../../desktop/src/main/maker-host/anthropicResponsesBridgeHostCore.js';
import { hostOutbound } from '../outbound.mjs';
import { createHostAuxiliaryModelChain } from './auxiliary-model-chain.js';
import type { createHostProviderConfig } from './provider-config.js';
import type { HostGateway } from './runtime.js';

type SubscriptionBridge = ReturnType<typeof createAnthropicResponsesBridgeHost>;
interface AutoReviewLogger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

/** Thrown by the one port the two review paths never reach (release table, section two). */
export const HOST_UTILITY_PROFILE_CHAIN_UNWIRED = 'The Host does not read the utility model profiles yet; only the auxiliary-model chain is wired';

/**
 * The desktop's Auto-review and tool-loop review (maker-host/index.ts), built from the same
 * shared code over this profile's services:
 * - the one-shot requests (oneShotCandidatesCore.ts) with the account gateway, the profile's
 *   provider credentials, the Codex runtime's subscription bridge and the Host outbound fetch;
 * - the dedicated Auto-review candidates, then the auxiliary chain the user customized
 *   (autoReviewModelRouterCore.ts);
 * - the tool-loop reviewer over the auxiliary chain.
 * Not here, by design: the managed local model runtime (the Host has none, so that candidate
 * fails) and the legacy utility profile chain, which neither review path reads.
 */
export function createHostAutoReview(options: {
  userDataDir: string;
  getMaker(): Maker;
  gateway?: HostGateway | null;
  reportGatewayKeyRejected?(key: string): void;
  providerConfig: ReturnType<typeof createHostProviderConfig>;
  bridge?: (() => SubscriptionBridge | null) | null;
  logger: AutoReviewLogger;
}) {
  const config = options.providerConfig;
  const bridge = () => {
    const value = options.bridge?.() ?? null;
    if (!value) throw new Error('The ChatGPT subscription bridge needs the Host Codex runtime');
    return value;
  };
  const { chain } = createHostAuxiliaryModelChain({ userDataDir: options.userDataDir });
  const oneShot = createOneShotCandidates({
    readClaudeApiKey: () => options.gateway?.credential || null,
    getChatgptBridgeAuth: (...args) => bridge().getChatgptBridgeAuth(...args),
    getChatgptBridgeAuthForDispatch: (...args) => bridge().getChatgptBridgeAuthForDispatch(...args),
    getGrokAccessToken: (...args) => config.grok.getGrokAccessToken(...args),
    getGrokOAuthCredentialGeneration: (...args) => config.grok.getGrokOAuthCredentialGeneration(...args),
    readCachedGenericOAuthAccessToken: (...args) => config.oauth.readCachedGenericOAuthAccessToken(...args),
    readGenericOAuthAccessToken: (...args) => config.oauth.readGenericOAuthAccessToken(...args),
    getGenericOAuthLoginGeneration: (...args) => config.oauth.getGenericOAuthLoginGeneration(...args),
    undiciFetch: (...args) => hostOutbound.outboundUndiciFetch(...args),
    claudeUpstreamEndpoint: () => options.gateway?.endpoint ?? '',
    reportCindyGatewayKeyRejected: key => { if (key) options.reportGatewayKeyRejected?.(key); },
    readCustomProviderKey: (providerId, agent) => config.readKey(providerId, agent),
    ensureManagedOllamaReadyForSession: async () => { throw new Error('The Host does not run the managed local model runtime'); },
    getUtilityModelChainProfiles: () => { throw new Error(HOST_UTILITY_PROFILE_CHAIN_UNWIRED); },
    getEffectiveAuxiliaryModelChain: () => chain.getEffectiveAuxiliaryModelChain(),
  });
  const requestAutoReviewText = createAutoReviewModelRouter({
    logger: options.logger,
    candidates: DEDICATED_AUTO_REVIEW_CANDIDATES,
    requestCandidate: (...args) => oneShot.requestDedicatedAutoReviewCandidateText(...args),
    createAuxiliaryFallback: () => oneShot.createCustomAutoReviewFallback(),
  });
  const reviewAutoPermissionAction: AutoReviewDelegate = createAutoPermissionReviewer({
    logger: options.logger,
    managesRetries: true,
    resolveRequestTimeoutMs: () => AUTO_REVIEW_ROUTER_GUARD_TIMEOUT_MS,
    requestText: (_request, prompt, { signal }) => requestAutoReviewText(prompt, signal),
  });
  const toolLoopReviewer = createToolLoopReviewer({
    requestText: (prompt, opts) => oneShot.requestUtilityText(options.getMaker(), prompt, opts),
  });
  let contextResolver: AutoReviewDelegate['prepareRequest'];
  // As the desktop before its resolver is set: no review without the authorization context.
  reviewAutoPermissionAction.prepareRequest = async request => {
    if (!contextResolver) throw new Error('Authorization context is not ready');
    return contextResolver(request);
  };
  return {
    reviewAutoPermissionAction, toolLoopReviewer, oneShot, chain,
    /** The desktop's setAutoReviewContextResolver. */
    setContextResolver(resolver: AutoReviewDelegate['prepareRequest']) { contextResolver = resolver; },
  };
}
