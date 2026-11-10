/** Desktop platform assembly for the common Codex proxy. */
import { bearerKeyFromHeaders, reportCindyGatewayKeyRejected } from '../model-access/gatewayKeyRejection.js';
import { createAttachmentRecovery } from './oversized-attachment-recovery.js';
import { restrictSubscriptionRequest, withSubscriptionFastRequestPolicy } from './subscription-fast-request-policy.js';
import { peekGrokAccessToken } from './grok-oauth-login.desktop.js';
import { isClaudeSubscriptionProviderId, isXaiSubscriptionProviderId } from './subscription-account-auth.js';

import {
  buildCodexGatewayBaseUrl,
  CODEX_OAUTH_UPSTREAM,
} from './codex-gateway-config.desktop.js';
import { claudeUpstreamEndpoint } from './runtime-configs.js';
import { isOpenAiSubscriptionProviderId } from './codex-account-auth.desktop.js';
import { createXaiProxyAuthInvalidationObserver } from './xai-auth-invalidation-host.js';
import { resolveDesktopOutboundProxy } from './outbound-proxy-resolver.js';
import { outboundFetch } from './outbound-fetch.desktop.js';
import { readSilentEncryptedRetrySettings } from './silent-encrypted-retry-store.js';
import { recordXaiRateLimitSnapshot } from '../usageBroadcaster.js';
import {
  CODEX_IMAGE_GENERATION_ACTOR_HEADER,
  codexCustomProviderRoutesSignature,
  findCodexAppliedCustomProviderRoute,
  isCodexCustomProviderNamespacePath,
  parseCodexCustomProviderPath,
  relativeProviderRequestPath,
  setCodexAppliedCustomProviderRoutes as setAppliedCustomProviderRoutes,
  type CodexCustomProviderRoute,
} from './codex-custom-provider-route.js';
import { createCodexProxyHost } from './codex-proxy-host.js';
export type { CodexObservedSubagentIdentity, CodexProxyAuthInjection } from './codex-proxy-host.js';
export const { setCodexAppliedCustomProviderRoutes, armCodexHttpRecovery, setCodexProxyAuthInjection, clearCodexProxyAuthInjection, getCodexProxyAuthInjectionState, getCodexProxyAuthInjection, setCodexSubagentOAuthReader, setCodexProxyGatewayKeyReader, getObservedCodexSubagentIdentity, chatBridgeSystemMessagePolicyForRoute, chatBridgeCapabilitiesForRoute, resolveXaiCodexCatalogModel, createCrossProviderCompactionCompatTransform, decideCodexRoute, createCodexGuestRoutingGuard, createModelRoutingTransform, getCodexThreadUpstreamOrigin, resetCodexThreadUpstreamForTest, withCodexUpstreamRecording, ensureCodexProxyReady, ensureCodexControlPlaneProxyReady, isCodexControlPlaneProxyHandleReady, getCodexControlPlaneProxyEndpoint, ensureCodexCustomContextProxyReady, isCodexCustomContextProxyHandleReady, getCodexCustomContextProxyEndpoint, releaseCodexCustomContextProxy, getCodexProxyEndpoint, registerComposed, registerReviewerRouteContext, registerChildThread, unregister, isCodexProxyHandleReady, disposeCodexProxy } = createCodexProxyHost({ bearerKeyFromHeaders, reportCindyGatewayKeyRejected, createAttachmentRecovery, restrictSubscriptionRequest, withSubscriptionFastRequestPolicy, peekGrokAccessToken, isClaudeSubscriptionProviderId, isXaiSubscriptionProviderId, buildCodexGatewayBaseUrl, CODEX_OAUTH_UPSTREAM, claudeUpstreamEndpoint, isOpenAiSubscriptionProviderId, createXaiProxyAuthInvalidationObserver, resolveDesktopOutboundProxy, outboundFetch, readSilentEncryptedRetrySettings, recordXaiRateLimitSnapshot, CODEX_IMAGE_GENERATION_ACTOR_HEADER, codexCustomProviderRoutesSignature, findCodexAppliedCustomProviderRoute, isCodexCustomProviderNamespacePath, parseCodexCustomProviderPath, relativeProviderRequestPath, setAppliedCustomProviderRoutes });
