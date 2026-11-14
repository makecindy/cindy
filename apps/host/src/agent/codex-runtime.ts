import { createCodexLocalModelSink } from '../../../desktop/src/main/maker-host/codexLocalModelSink.js';
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
import { bearerKeyFromHeaders } from '../../../desktop/src/main/model-access/gatewayKeyRejectionCore.js';
import { captureCodexLocalAuthPolicy } from '../../../desktop/src/main/maker-host/provider-route.js';
import { registerCodexTextOnlyPolicy } from '../../../desktop/src/main/maker-host/codex-text-only-policy.js';
import { withParentReasoningEffort } from '../../../desktop/src/main/maker-host/codex-smart-subagent-routing.js';
import { createAnthropicResponsesBridgeHost } from '../../../desktop/src/main/maker-host/anthropicResponsesBridgeHostCore.js';
import { createPiSubscriptionWebSocket } from '../../../desktop/src/main/maker-host/piSubscriptionWebSocketCore.js';
import { chatgptAccountIdFromTokens } from '../../../desktop/src/main/maker-host/codexCredentialRead.js';
import { createHostCodexCredentials } from './codex-credentials.js';
import { createHostCodexThreadStorage } from './codex-thread-storage.js';
import { invalidateHostCodexLogin } from './codex-invalidation.js';
import { createHostCodexSystemLogin, resolveHostSystemCodexAuthPath } from './codex-system-login.js';
import { createCodexAuthBoundary } from './codex-auth-boundary.js';
import { createCodexProxyInbound } from './codex-proxy-inbound.js';
import { createLogger } from '../../../desktop/src/main/logger.js';
import { createHostModelContext } from './model-context.js';
import { hostOutbound, resolveHostOutboundProxy } from '../outbound.mjs';
import type { createHostProviderConfig } from './provider-config.js';
import type { createHostModelAccess } from './model-access.js';
import type { createHostMcpRuntime } from './mcp-runtime.js';

/** The subscription Fast policies for one owner, shared by the Codex and Claude proxies. */
export function createHostSubscriptionFastPolicies(availabilityPolicy: ReturnType<typeof createAvailabilityPolicy>) {
  const groups = createProviderGroupStore(availabilityPolicy);
  const bindings = createProviderGroupBindings(groups);
  const policies = createSubscriptionFastPolicies({ ...groups, ...bindings });
  return { policies, requestPolicy: createSubscriptionFastRequestPolicy(policies) };
}

const log = createLogger('host-codex-runtime');

/**
 * The subscription bridge's native token read, as the desktop adapter's getAccessToken: the
 * native OpenAI login is reconciled with the system login before the token is read.
 */
export function createBridgeTokenReader(options: {
  check(): void;
  systemLogin: { reconcile(): Promise<void> };
  readAccessToken(providerId?: string): Promise<string | null> | string | null;
}) {
  return async (providerId?: string): Promise<string | null> => {
    options.check();
    if (!providerId || providerId === 'openai') await options.systemLogin.reconcile();
    options.check();
    return options.readAccessToken(providerId);
  };
}

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
  const { policies, requestPolicy } = createHostSubscriptionFastPolicies(options.availabilityPolicy);
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
  // The desktop Codex adapter's reconciliation with the system login: only when installed
  // (codex-system-login.ts). One per runtime; an owner change builds a new runtime.
  const systemAuthPath = resolveHostSystemCodexAuthPath();
  const systemLogin = createHostCodexSystemLogin({
    codexHome: path.join(options.profileDir, 'codex-home'), systemAuthPath,
    loginActive: () => options.config.codexAccounts.isCodexAccountLoginActive('openai'),
    // The desktop's onOAuthBindingClaimed: a claimed credential is an auth boundary for Pi.
    onBindingClaimed: () => { if (current()) options.mcp.invalidatePiEnvironment(); },
  });
  // As the desktop's warmUp at startup: only an existing system login is reconciled.
  void systemLogin.reconcile().catch(() => undefined);
  // The Host's Codex loopback proxies require inbound credentials (codex-proxy-inbound.ts).
  const inbound = createCodexProxyInbound(current);
  const proxy = createCodexProxyHost({
    authorizeInbound: ctx => inbound.authorizeInbound(ctx),
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
  // The ChatGPT and SuperGrok subscription bridge the Claude and Pi proxy routes through
  // (desktop: anthropic-responses-bridge-host.ts, pi-subscription-websocket.ts), with this
  // profile's credentials. Ports resolve at call time.
  const accounts = options.config.codexAccounts;
  const bridge = createAnthropicResponsesBridgeHost({
    subscriptionRequestAllowsFast: (...args) => requestPolicy.subscriptionRequestAllowsFast(...args),
    isXaiSubscriptionProviderId: (...args) => isXaiSubscriptionProviderId(...args),
    app: { getPath: () => getUserDataDir() },
    outboundFetch: (...args) => hostOutbound.outboundFetch(...args),
    getGrokAccessToken: (...args) => options.config.grok.getGrokAccessToken(...args),
    peekGrokAccessToken: (...args) => options.config.grok.peekGrokAccessToken(...args),
    invalidateXaiBridgeAuth: (...args) => xai.invalidateXaiBridgeAuth(...args),
    chatgptAccountIdFromTokens: (...args) => chatgptAccountIdFromTokens(...args),
    desktopCodexAuthAdapter: {
      getAccessToken: createBridgeTokenReader({ check, systemLogin, readAccessToken: providerId => native.readAccessToken(providerId) }),
      // The bridge has just matched the rejected token against getAccessToken above.
      invalidate: reason => invalidateNative(reason),
      captureOAuthDispatchProof: (accessToken, accountId, providerId) => native.captureDispatchProof(accessToken, accountId, providerId),
    },
    codexAccountHome: (...args) => accounts.codexAccountHome(...args),
    codexAccountState: (...args) => accounts.codexAccountState(...args),
    invalidateCodexAccount: (...args) => accounts.invalidateCodexAccount(...args),
    isOpenAiSubscriptionProviderId: (...args) => accounts.isOpenAiSubscriptionProviderId(...args),
    recordXaiRateLimitSnapshot: (...args) => usage.recordXaiRateLimitSnapshot(...args),
  });
  const piWebSocket = createPiSubscriptionWebSocket({
    subscriptionRequestAllowsFast: (...args) => requestPolicy.subscriptionRequestAllowsFast(...args),
    getChatgptBridgeAuthForDispatch: (...args) => bridge.getChatgptBridgeAuthForDispatch(...args),
    invalidateChatgptBridgeAuth: (...args) => bridge.invalidateChatgptBridgeAuth(...args),
    isOpenAiSubscriptionProviderId: (...args) => accounts.isOpenAiSubscriptionProviderId(...args),
  });
  // The desktop's Codex auth-boundary hooks (maker-host/index.ts) for this runtime: login,
  // logout and server-side invalidation of the profile's native login.
  let retireLocalHosts: ((reason: string) => Promise<void>) | null = null;
  const authBoundary = createCodexAuthBoundary({
    retireLocalHosts: async reason => { await retireLocalHosts?.(reason); },
    clearProxyAuthInjection: () => proxy.clearCodexProxyAuthInjection(),
    publishRuntimeRoute: () => publish(MAKER_PUSH.CODEX_RUNTIME_ROUTE_CHANGED, readRoute()),
    clearBridgeCredentialCache: () => bridge.clearChatgptBridgeCredentialCache(),
    invalidatePiEnvironment: () => options.mcp.invalidatePiEnvironment(),
    publish, warn: (message, fields) => log.warn(message, fields),
  });
  const invalidateNative = async (reason: string, context?: { providerId?: string; credentialGeneration?: string | null; credentialAttribution?: 'unproven' }) => {
    check();
    await invalidateHostCodexLogin({ codexHome: path.join(options.profileDir, 'codex-home'), systemAuthPath, reason, ...context,
      // The account service's predicate, without the native connection (as runtime.ts gives CodexAgent).
      isCodexAccountProvider: id => id !== 'openai' && options.config.codexAccounts.isCodexAccountProvider(id),
      // The engine reports with a context; the subscription bridge reports without one.
      hostBound: context !== undefined,
      loginInProgress: () => options.config.codexAccounts.isCodexAccountLoginActive('openai'),
      // The desktop's isCodexDisconnectCurrent: this runtime's owner, without a pending boundary.
      isCurrent: current,
      // The desktop's invalidation runs logout(), whose cleanup calls onLogoutSuccess.
      disposeLocalHost: () => authBoundary.afterLogout(),
      onInvalidated: credentialScope => authBoundary.afterInvalidation(reason, credentialScope) });
  };
  const readRoute = () => {
    check();
    return { authInjection: proxy.getCodexProxyAuthInjectionState() ?? (native.hasLogin() ? 'oauth-bearer' : 'env-key') };
  };
  const modelContext = createHostModelContext({ readGatewayKey: credential, hasCodexOAuthLogin: native.hasLogin,
    codexAccountState: id => options.config.codexAccounts.codexAccountState(id), check });
  // The spawn config reads proxy endpoints through this view, so only endpoints of running
  // proxies of this runtime are recorded; a gateway fallback endpoint never is.
  const spawnProxy: typeof proxy = {
    ...proxy,
    getCodexProxyEndpoint: () => inbound.track(proxy.getCodexProxyEndpoint(), proxy.isCodexProxyHandleReady()),
    getCodexControlPlaneProxyEndpoint: mode =>
      inbound.track(proxy.getCodexControlPlaneProxyEndpoint(mode), proxy.isCodexControlPlaneProxyHandleReady(mode)),
    getCodexCustomContextProxyEndpoint: key =>
      inbound.track(proxy.getCodexCustomContextProxyEndpoint(key), proxy.isCodexCustomContextProxyHandleReady(key)),
  };
  const prepare = createCodexSpawnConfig({
    binaryPath: options.binaryPath, proxy: spawnProxy,
    getCodexHome: () => { check(); return path.join(options.profileDir, 'codex-home'); },
    getCodexExtraSpawnConfig: options.mcp.prepareCodexMcp,
    broadcastCodexRuntimeRoute: async () => publish(MAKER_PUSH.CODEX_RUNTIME_ROUTE_CHANGED, readRoute()),
    readClaudeApiKey: credential, isReplacedCindyGatewayKey: options.modelAccess.isReplacedKey,
    hasCodexOAuthLogin: async () => native.hasLogin(),
    listProviders: () => options.config.publicViews(Boolean(credential())),
    getDesktopSelectableCatalog: modelContext.getSelectableCatalog,
    resolveDesktopModelContextProviderId: modelContext.resolveContextProviderId,
    // The desktop reads subagent OAuth through the same bridge (maker-host/index.ts readSubagentOAuth).
    readSubagentOAuth: (...args) => bridge.getChatgptBridgeAuthForDispatch(...args),
    prepareRemote: async () => { throw new Error('SSH Codex transport is not configured in this Host'); },
  });
  const threadStorage = createHostCodexThreadStorage({ profileDir: options.profileDir, accounts, check });
  const deps: Partial<AgentDeps> = {
    ...threadStorage.deps,
    prepareCodexExtraSpawnConfig: async (...args) => { check(); const value = inbound.withToken(await prepare(...args)); check(); return value; },
    disableCodexPluginRuntime: true,
    onCodexLocalModelsListed: createCodexLocalModelSink(options.config.list),
    resolveCodexSubagentRoutingSignature: createCodexRoutingSignature(() => options.config.publicViews(Boolean(credential()))),
    resolveCodexLocalAuthPolicy: captureCodexLocalAuthPolicy,
    isCodexAccountProvider: id => id !== 'openai' && options.config.codexAccounts.isCodexAccountProvider(id),
    isolateCodexAccountSessions: true,
    registerCodexTextOnlyPolicy,
    // As the desktop (maker-host/index.ts): the smart subagent routes of this thread carry the
    // parent task's current reasoning effort.
    registerCodexSystemPromptForThread: ({
      sessionId,
      threadId,
      text,
      subagentRoute,
      smartSubagentRoutes,
      reasoningEffort,
    }) => {
      check();
      proxy.registerComposed(sessionId, threadId, text, {
          ...(subagentRoute ? { subagentRoute } : {}),
          // 共享的 app-server 目录不带档位。只给这条线程的智能路由盖上父任务当前档位，
          // 避免恢复后子代理掉回目录默认 low。优先用登记时带上的活档位：冷恢复
          // 这一刻 session store 还没从数据库 hydrate。
          // 空字符串是「不用推理」的显式哨兵，不能再去 store 里找一个默认档。
          // 字段缺席是「这一轮没有已选档位」（agent 不把目录默认 high 登记过来），
          // 同样不盖章：store 在任务从没存过档位时也会被填成目录默认，读它
          // 会把子代理自己选的 low 盖掉。
          ...(smartSubagentRoutes
            ? {
                smartSubagentRoutes: withParentReasoningEffort(
                  smartSubagentRoutes,
                  reasoningEffort !== undefined ? reasoningEffort : null,
                ),
              }
            : {}),
        });
    },
    getCodexSubagentIdentity: ({ childThreadId }) => proxy.getObservedCodexSubagentIdentity(childThreadId),
    armCodexHttpRecovery: proxy.armCodexHttpRecovery,
    registerCodexChildThreadForParent: ({ parentThreadId, childThreadId }) => { check(); proxy.registerChildThread(parentThreadId, childThreadId); },
  };
  return { deps, proxy, native, readRoute, modelContext,
    /** Whether this runtime still belongs to the current owner (the agent graph's Codex token reader). */
    isCurrent: current, fastPolicies: policies, fastRequestPolicy: requestPolicy, closeSession: proxy.unregister,
    invalidateNative, authBoundary, systemAuthPath, systemLogin,
    /** What this runtime's Codex processes carry to its proxies (tests; never logged). */
    inboundToken: () => inbound.token(),
    /** How this runtime retires the local Codex hosts (the agent graph's CodexAgent). */
    setLocalHostRetirement(handler: (reason: string) => Promise<void>) { retireLocalHosts = handler; },
    /** For the Claude and Pi proxy; also cleared on every Codex login and logout, as on the desktop. */
    subscriptions: { bridge, piWebSocket },
    async close() { closed = true; await proxy.disposeCodexProxy(); },
  };
}
