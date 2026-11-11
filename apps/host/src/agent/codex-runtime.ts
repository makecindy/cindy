import { createCodexLocalModelSink } from '../../../desktop/src/main/maker-host/codexLocalModelSink.js';
import { resolveModelDefaultContextWindow } from '../../../desktop/src/main/maker-host/catalog-to-descriptors.js';
import { readModelContextLimit } from '../../../desktop/src/main/maker-host/model-context-limit-store.js';
import { hostBlobStore, hostMediaIngest, hostMediaJournal } from '../media-store.js';
import { MAKER_PUSH } from '../../../desktop/src/main/maker-ipc/channels.js';
import path from 'node:path';
import type { AgentDeps } from '@cindy/maker-core';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../../../desktop/src/main/appSessionState.js';
import { createCodexProxyHost } from '../../../desktop/src/main/maker-host/codex-proxy-host.js';
import { createCodexSpawnConfig, createCodexRoutingSignature } from '../../../desktop/src/main/maker-host/codexSpawnConfigCore.js';
import { createAttachmentRecoveryService } from '../../../desktop/src/main/maker-host/oversizedAttachmentRecoveryCore.js';
import { createSilentEncryptedRetryStore } from '../../../desktop/src/main/maker-host/silentEncryptedRetryCore.js';
import { createXaiAuthInvalidationHost } from '../../../desktop/src/main/maker-host/xaiAuthInvalidationCore.js';
import { createXaiRateLimitPublisher } from '../../../desktop/src/main/usage/xaiRateLimits.js';
import { createSubscriptionFastPolicies } from '../../../desktop/src/main/maker-host/subscriptionFastPolicyCore.js';
import { createSubscriptionFastRequestPolicy } from '../../../desktop/src/main/maker-host/subscriptionFastRequestCore.js';
import { createProviderGroupStore } from '../../../desktop/src/main/provider-group/storeCore.js';
import { createProviderGroupBindings } from '../../../desktop/src/main/provider-group/bindings.js';
import type { createAvailabilityPolicy } from '../../../desktop/src/main/device-link/providerShareAvailabilityPolicyCore.js';
import { buildCodexGatewayBaseUrl, CODEX_OAUTH_UPSTREAM } from '../../../desktop/src/main/maker-host/codex-gateway-config.js';
import * as routes from '../../../desktop/src/main/maker-host/codex-custom-provider-route.js';
import { isClaudeSubscriptionProviderId, isXaiSubscriptionProviderId } from '../../../desktop/src/main/maker-host/subscription-account-kind.js';
import { getActiveCatalog } from '../../../desktop/src/main/maker-host/active-catalog.js';
import { filterLegacyGptContextProfiles } from '../../../desktop/src/main/maker-host/legacy-context-profiles.js';
import { createModelContextProviderResolver } from '../../../desktop/src/main/maker-host/modelContextProvider.js';
import { hasClaudeNativeLogin } from '../../../desktop/src/main/maker-host/claude-native-auth.js';
import { bearerKeyFromHeaders } from '../../../desktop/src/main/model-access/gatewayKeyRejectionCore.js';
import { captureCodexLocalAuthPolicy } from '../../../desktop/src/main/maker-host/provider-route.js';
import { registerCodexTextOnlyPolicy } from '../../../desktop/src/main/maker-host/codex-text-only-policy.js';
import { createHostCodexCredentials } from './codex-credentials.js';
import { hostOutbound, resolveHostOutboundProxy } from '../outbound.mjs';
import type { createHostProviderConfig } from './provider-config.js';
import type { createHostModelAccess } from './model-access.js';
import type { createHostMcpRuntime } from './mcp-runtime.js';

/** Same Codex proxy and spawn policy as desktop, assembled with owner-bound Node IO. */
export function createHostCodexRuntime(options: {
  profileDir: string; binaryPath: string;
  config: ReturnType<typeof createHostProviderConfig>;
  modelAccess: ReturnType<typeof createHostModelAccess>;
  availabilityPolicy: ReturnType<typeof createAvailabilityPolicy>;
  mcp: ReturnType<typeof createHostMcpRuntime>;
  publish(channel: string, payload: unknown): void;
}) {
  const owner = activeOwnerScopeKey();
  let closed = false;
  const current = () => !closed && owner === activeOwnerScopeKey() && !isAppSessionBoundaryPending();
  const check = () => { if (!current()) throw new Error('CODEX_RUNTIME_OWNER_CHANGED'); };
  const publish = (channel: string, payload: unknown) => { if (current()) options.publish(channel, payload); };
  const groups = createProviderGroupStore(options.availabilityPolicy);
  const bindings = createProviderGroupBindings(groups);
  const policies = createSubscriptionFastPolicies({ ...groups, ...bindings });
  const requestPolicy = createSubscriptionFastRequestPolicy(policies);
  const xai = createXaiAuthInvalidationHost(options.config.grok);
  const usage = createXaiRateLimitPublisher(publish);
  xai.setXaiAuthInvalidatedHandler(id => {
    usage.clearXaiRateLimitSnapshot(id);
    publish(MAKER_PUSH.PROVIDER_CHANGED, { providerId: id });
  });
  const getUserDataDir = () => { check(); return options.profileDir; };
  const credential = () => { check(); return options.modelAccess.gateway.credential || null; };
  const endpoint = () => { check(); return options.modelAccess.gateway.endpoint; };
  const native = createHostCodexCredentials(options.profileDir, options.config.codexAccounts);
  const proxy = createCodexProxyHost({
    bearerKeyFromHeaders, reportCindyGatewayKeyRejected: options.modelAccess.reportRejectedKey,
    ...createAttachmentRecoveryService({ getUserDataDir, media: { ...hostBlobStore, ...hostMediaIngest, ...hostMediaJournal } }), ...requestPolicy,
    peekGrokAccessToken: options.config.grok.peekGrokAccessToken,
    isClaudeSubscriptionProviderId, isXaiSubscriptionProviderId,
    buildCodexGatewayBaseUrl: () => buildCodexGatewayBaseUrl(endpoint()), CODEX_OAUTH_UPSTREAM,
    claudeUpstreamEndpoint: endpoint,
    isOpenAiSubscriptionProviderId: options.config.codexAccounts.isOpenAiSubscriptionProviderId,
    createXaiProxyAuthInvalidationObserver: xai.createXaiProxyAuthInvalidationObserver,
    resolveDesktopOutboundProxy: resolveHostOutboundProxy, outboundFetch: hostOutbound.outboundFetch,
    ...createSilentEncryptedRetryStore({ getUserDataDir }), ...usage, ...routes,
    setAppliedCustomProviderRoutes: routes.setCodexAppliedCustomProviderRoutes,
  });
  const readRoute = () => {
    check();
    return { authInjection: proxy.getCodexProxyAuthInjectionState() ?? (native.hasLogin() ? 'oauth-bearer' : 'env-key') };
  };
  const contextProvider = createModelContextProviderResolver({
    readGatewayKey: credential, hasClaudeNativeLogin, hasCodexOAuthLogin: native.hasLogin,
  });
  const prepare = createCodexSpawnConfig({
    binaryPath: options.binaryPath, proxy,
    getCodexHome: () => { check(); return path.join(options.profileDir, 'codex-home'); },
    getCodexExtraSpawnConfig: options.mcp.prepareCodexMcp,
    broadcastCodexRuntimeRoute: async () => publish(MAKER_PUSH.CODEX_RUNTIME_ROUTE_CHANGED, readRoute()),
    readClaudeApiKey: credential, isReplacedCindyGatewayKey: options.modelAccess.isReplacedKey,
    hasCodexOAuthLogin: async () => native.hasLogin(),
    listProviders: () => options.config.publicViews(Boolean(credential())),
    getDesktopSelectableCatalog: () => { check(); return filterLegacyGptContextProfiles(getActiveCatalog()); },
    resolveDesktopModelContextProviderId: contextProvider,
    readSubagentOAuth: native.readForDispatch,
    prepareRemote: async () => { throw new Error('SSH Codex transport is not configured in this Host'); },
  });
  const deps: Partial<AgentDeps> = {
    prepareCodexExtraSpawnConfig: async (...args) => { check(); const value = await prepare(...args); check(); return value; },
    disableCodexPluginRuntime: true,
    onCodexLocalModelsListed: createCodexLocalModelSink(options.config.list),
    resolveCodexSubagentRoutingSignature: createCodexRoutingSignature(() => options.config.publicViews(Boolean(credential()))),
    resolveCodexThreadContextWindow: (providerId, modelId) => {
      check(); const catalog = filterLegacyGptContextProfiles(getActiveCatalog());
      const source = contextProvider(catalog, 'codex', providerId, modelId);
      return (source ? readModelContextLimit('codex', source, modelId) : null)
        ?? resolveModelDefaultContextWindow(catalog, 'codex', source, modelId);
    },
    resolveCodexLocalAuthPolicy: captureCodexLocalAuthPolicy,
    isCodexAccountProvider: id => id !== 'openai' && options.config.codexAccounts.isCodexAccountProvider(id),
    isolateCodexAccountSessions: true,
    registerCodexTextOnlyPolicy,
    registerCodexSystemPromptForThread: ({ sessionId, threadId, text, subagentRoute, smartSubagentRoutes }) => {
      check(); proxy.registerComposed(sessionId, threadId, text, { subagentRoute, smartSubagentRoutes });
    },
    getCodexSubagentIdentity: ({ childThreadId }) => proxy.getObservedCodexSubagentIdentity(childThreadId),
    armCodexHttpRecovery: proxy.armCodexHttpRecovery,
    registerCodexChildThreadForParent: ({ parentThreadId, childThreadId }) => { check(); proxy.registerChildThread(parentThreadId, childThreadId); },
    createCodexAuthTokenReader: providerId => async () => {
      check(); const auth = await native.readForDispatch(providerId); check();
      if (!auth.accountId) throw new Error('Codex account identity is unavailable');
      return { accessToken: auth.accessToken, chatgptAccountId: auth.accountId };
    },
  };
  return { deps, proxy, native, readRoute, closeSession: proxy.unregister,
    async close() { closed = true; await proxy.disposeCodexProxy(); },
  };
}
