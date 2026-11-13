import { CODEX_PROVIDER_OAUTH_PLACEHOLDER_KEY } from '../../../desktop/src/main/maker-host/codex-gateway-config.js';
/** Node assembly of the shared Maker agents, provider configuration and MCP transports.
 * Native login, settings and platform integrations are assembled by the owning runtime. */

import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../../../desktop/src/main/appSessionState.js';
import { ClaudeCodeAgent } from '@cindy/maker-core/agents/claude-code';
import { CodexAgent } from '@cindy/maker-core/agents/codex';
import { Maker, PiAgent } from '@cindy/maker-core';

import { hasClaudeNativeLogin } from '../../../desktop/src/main/maker-host/claude-native-auth.ts';
import { createMakerLogger } from '../../../desktop/src/main/maker-host/logger-adapter.js';
import { readCodexLocalAuthState } from '../../../desktop/src/main/maker-host/codex-local-auth-state.js';
import { createPiAuthAdapter } from '../../../desktop/src/main/maker-host/pi-auth.js';
import { subscriptionAccountKind } from '../../../desktop/src/main/maker-host/subscription-account-kind.js';
import { getActiveCatalog } from '../../../desktop/src/main/maker-host/active-catalog.js';
import { isNativeProviderAuthBound, bindNativeProviderAuth, unbindNativeProviderAuth } from '../../../desktop/src/main/maker-host/nativeProviderAuthBinding.js';

import { GatewayCodexRestartService } from '../../../desktop/src/main/maker-ipc/gatewayCodexRestart.js';
import { createDeferredRestartSettledWake } from '../../../desktop/src/main/maker-ipc/deferredRestartQueueWiring.js';
import { refreshCodexGatewayRuntime } from '../../../desktop/src/main/maker-host/codexGatewayRefresh.js';
import { isLocalSessionBusy } from '../../../desktop/src/main/maker-host/codex-credential-switch.js';
import { getDesktopMcpToolApprovalPolicy } from '../../../desktop/src/main/maker-host/mcp-tool-approval-policy.js';

export const LOGGER = createMakerLogger('maker');

const missingRouteResolver = async () => { throw new Error('Provider credential resolver is unavailable'); };

/** A credential adapter retained by an outgoing task cannot authenticate a new owner. */
function bindAuthOwner(adapter) {
  const owner = activeOwnerScopeKey();
  const current = () => activeOwnerScopeKey() === owner && !isAppSessionBoundaryPending();
  const check = () => { if (!current()) throw new Error('AUTH_OWNER_CHANGED'); };
  return {
    ...adapter,
    async getState(options) {
      if (!current()) return { authenticated: false, errorReason: 'owner_changed' };
      const state = await adapter.getState(options);
      return current() ? state : { authenticated: false, errorReason: 'owner_changed' };
    },
    async getAuthEnv(options) {
      check(); const env = await adapter.getAuthEnv(options); check(); return env;
    },
    async triggerLogin(options) { check(); const state = await adapter.triggerLogin(options); check(); return state; },
    async logout() { check(); await adapter.logout(); check(); },
  };
}


/**
 * Subscription-only view: state comes from the shared verdict, and the lane
 * injects no credentials because the CLI authenticates itself.
 */
export function createClaudeSubscriptionAuth(gateway, resolveRoute = missingRouteResolver, cli) {
  const owner = activeOwnerScopeKey();
  const current = () => owner === activeOwnerScopeKey() && !isAppSessionBoundaryPending();
  return bindAuthOwner({
    async getState(opts) {
      if (opts?.providerId && !['xd', 'cindy', 'anthropic'].includes(opts.providerId)) {
        try { await resolveRoute(opts.providerId, 'claude-code'); return { authenticated: true, authSource: 'api-key', identity: opts.providerId }; }
        catch { return { authenticated: false, errorReason: 'not_connected' }; }
      }
      if (cli && isNativeProviderAuthBound('anthropic')) await cli.readClaudeCliLoginStatus({ maxAgeMs: 30_000 });
      return hasClaudeNativeLogin()
        ? { authenticated: true, authSource: 'oauth', identity: 'Claude subscription' }
        : { authenticated: false, errorReason: 'not_connected' };
    },
    async triggerLogin() {
      if (!cli) throw new Error('Claude CLI is unavailable');
      const signal = cli.beginClaudeCliLogin();
      const result = await cli.runClaudeCliLogin(signal);
      if (!current() || signal.aborted) return { authenticated: false, errorReason: 'login_cancelled' };
      if (!result.ok) return { authenticated: false, errorReason: result.reason };
      bindNativeProviderAuth('anthropic', { sharedSystem: true });
      return { authenticated: true, authSource: 'oauth', identity: result.status.email };
    },
    cancelLogin() { cli?.cancelClaudeCliLogin(); },
    async logout() {
      cli?.cancelClaudeCliLogin();
      unbindNativeProviderAuth('anthropic', { revoked: true });
    },
    async getAuthEnv(opts) {
      const custom = opts?.providerId && !['xd', 'cindy', 'anthropic'].includes(opts.providerId) ? await resolveRoute(opts.providerId, 'claude-code') : null;
      if (custom) {
        return {
          ANTHROPIC_BASE_URL: custom.anthropicBaseUrl,
          ANTHROPIC_API_KEY: custom.apiKey ?? 'cindy-keyless-provider',
        };
      }
      return cli ? cli.claudeCliNetworkEnv() : {};
    },
  });
}

/**
 * @param {{binaryPath: string, storage: unknown, makerMemory?: unknown}} options
 */
/** Gateway-key lane: the key is injected as ANTHROPIC_API_KEY for the CLI spawn. */
export function createClaudeGatewayAuth(gateway, resolveRoute = missingRouteResolver, cli) {
  const native = createClaudeSubscriptionAuth(null, resolveRoute, cli);
  return bindAuthOwner({
    async getState(opts) {
      if (opts?.providerId === 'anthropic' || opts?.credentialMode === 'oauth-bearer') return native.getState(opts);
      if (!opts?.providerId && !opts?.credentialMode && !gateway?.credential) return native.getState(opts);
      if (opts?.providerId && opts.providerId !== 'xd' && opts.providerId !== 'cindy') {
        try { await resolveRoute(opts.providerId, 'claude-code'); return { authenticated: true, authSource: 'api-key', identity: opts.providerId }; }
        catch { return { authenticated: false, errorReason: 'not_connected' }; }
      }
      return gateway?.credential ? { authenticated: true, authSource: 'api-key', identity: 'Cindy gateway' }
        : { authenticated: false, errorReason: 'no_key' };
    },
    triggerLogin: options => native.triggerLogin(options),
    cancelLogin: () => native.cancelLogin(),
    logout: () => native.logout(),
    async getAuthEnv(opts) {
      if (opts?.providerId === 'anthropic' || opts?.credentialMode === 'oauth-bearer') return native.getAuthEnv(opts);
      const custom = opts?.providerId && !['xd', 'cindy'].includes(opts.providerId) ? await resolveRoute(opts.providerId, 'claude-code') : null;
      if (custom) {
        return {
          ANTHROPIC_BASE_URL: custom.anthropicBaseUrl,
          ANTHROPIC_API_KEY: custom.apiKey ?? 'cindy-keyless-provider',
        };
      }
      return gateway?.credential ? { ANTHROPIC_API_KEY: gateway.credential } : {};
    },
  });
}

/**
 * Codex reads the explicitly selected Host profile and the shared durable
 * invalidation rules. It never falls back to the system CLI authentication home.
 */
export function createCodexLocalCliAuth(gateway, resolveRoute, codexHome, accounts, config) {
  if (!codexHome || !path.isAbsolute(codexHome)) throw new Error('Codex requires an explicit isolated profile');
  const owner = activeOwnerScopeKey();
  const current = () => owner === activeOwnerScopeKey() && !isAppSessionBoundaryPending();
  return bindAuthOwner({
    async getState(opts) {
      if (opts?.nativeSubscriptionAccount) return opts.nativeSubscriptionAccount.readState();
      if (opts?.providerId && !['xd', 'cindy', 'openai'].includes(opts.providerId)) {
        if (accounts?.isCodexAccountProvider(opts.providerId)) return accounts.codexAccountState(opts.providerId);
        try {
          if (config) {
            const provider = (await config.publicViews(Boolean(gateway?.credential))).find(item => item.id === opts.providerId);
            if (!provider?.connected || !provider.routing?.codex) throw new Error('Provider requires connection');
          } else await resolveRoute(opts.providerId, 'codex');
          return { authenticated: true, authSource: 'api-key', identity: opts.providerId };
        }
        catch { return { authenticated: false, errorReason: 'not_connected' }; }
      }
      const gatewayState = gateway?.credential
        ? { authenticated: true, authSource: 'api-key', identity: 'Cindy AI' }
        : { authenticated: false, errorReason: 'no_key' };
      if (opts?.credentialMode === 'gateway-key' || ['xd', 'cindy'].includes(opts?.providerId)) return gatewayState;
      const native = isNativeProviderAuthBound('openai') ? await readCodexLocalAuthState(codexHome) : null;
      if (native?.authenticated && native.authSource === 'oauth') return native;
      if (opts?.providerId === 'openai' || opts?.credentialMode === 'oauth-bearer')
        return { authenticated: false, errorReason: native?.errorReason ?? 'oauth_not_bound' };
      return gatewayState;
    },
    async triggerLogin(options) {
      if (!accounts) throw new Error('Codex account service is unavailable');
      const result = await accounts.loginCodexAccount('openai', current, undefined, {
        mode: options?.mode === 'device-code' ? 'device-code' : 'browser', onProgress: options?.onProgress,
      });
      if (!result.ok || !current()) return { authenticated: false, errorReason: result.reason ?? 'owner_changed' };
      try { bindNativeProviderAuth('openai', { instanceIsolated: true }); }
      catch (error) { result.rollbackCredentials?.(); throw error; }
      return accounts.codexAccountState('openai');
    },
    cancelLogin() { accounts?.cancelCodexAccountLogin('openai'); },
    async logout() {
      if (!accounts) throw new Error('Codex account service is unavailable');
      unbindNativeProviderAuth('openai', { revoked: true });
      await accounts.logoutCodexAccount('openai');
    },
    async getAuthEnv(opts) {
      if (opts?.nativeSubscriptionAccount) {
        opts.nativeSubscriptionAccount.assertCurrent();
        return { CODEX_HOME: opts.nativeSubscriptionAccount.configDir };
      }
      await mkdir(codexHome, { recursive: true, mode: 0o700 });
      if (opts?.providerId === 'openai' || opts?.credentialMode === 'oauth-bearer') return { CODEX_HOME: codexHome };
      if (opts?.providerId && !['xd', 'cindy', 'openai'].includes(opts.providerId)) {
        if (accounts?.isCodexAccountProvider(opts.providerId)) {
          if (!accounts.codexAccountState(opts.providerId).authenticated) throw new Error('Codex account requires login');
          return { CODEX_HOME: accounts.codexAccountHome(opts.providerId) };
        }
        // The proxy injects the selected provider's exact credential and headers.
        // Do not place a different provider's key into the shared native process.
        return { CODEX_HOME: codexHome, XDT_CODEX_API_KEY: gateway?.credential || CODEX_PROVIDER_OAUTH_PLACEHOLDER_KEY };
      }
      return { CODEX_HOME: codexHome, ...(gateway?.credential ? { XDT_CODEX_API_KEY: gateway.credential } : {}) };
    },
  });
}


export function createHostAgentGraph(options) {
  const mcpProviders = options.mcpProviders ?? [];
  const codexAuth = createCodexLocalCliAuth(options.gateway, options.resolveProviderRoute, path.join(options.userDataDir, 'codex-home'), options.providerConfig.codexAccounts, options.providerConfig);
  const config = options.providerConfig;
  const piAuth = bindAuthOwner(createPiAuthAdapter({
    subscriptionAccountKind,
    subscriptionAccountState: id => subscriptionAccountKind(id) === 'claude'
      ? { authenticated: false, errorReason: 'claude_account_retired', authSource: 'oauth' }
      : { authenticated: config.grok.hasGrokOAuthLogin(id), identity: config.grok.grokAccountIdentity(id), authSource: 'oauth' },
    isOpenAiSubscriptionProviderId: id => id === 'openai' || getActiveCatalog().providers.some(provider => provider.id === id && provider.auth.native === 'codex'),
    desktopCodexAuthAdapter: codexAuth,
    hasGrokOAuthLogin: config.grok.hasGrokOAuthLogin,
    listCustomProvidersWithSecureHeaders: config.list,
    readCustomProviderKey: config.readKey,
    readCachedGenericOAuthAccessToken: config.oauth.readCachedGenericOAuthAccessToken,
    readClaudeApiKey: () => options.gateway?.credential ?? null,
  }));
  const agent = options.binaryPath ? new ClaudeCodeAgent({
    getMcpToolApprovalPolicy: getDesktopMcpToolApprovalPolicy,
    auth: createClaudeGatewayAuth(options.gateway, options.resolveProviderRoute, config.claudeNative),
    runtimeConfig: {
      get endpoint() { return options.gateway?.endpoint || undefined; },
      // The session flag gates whether cindy_memory is registered at all.
      ...(options.makerMemory ? { makerMemoryEnabled: options.makerMemory.isEnabled() } : {}),
    },
    binaryPath: options.binaryPath,
    logger: LOGGER,
    getMcpToolApprovalPolicy: getDesktopMcpToolApprovalPolicy,
    ...(mcpProviders.length > 0 ? { mcpProviders } : {}),
    ...(options.makerMemory ? { makerMemory: options.makerMemory } : {}),
  }) : null;
  const codex = options.codexBinaryPath
    ? new CodexAgent({
        getMcpToolApprovalPolicy: getDesktopMcpToolApprovalPolicy,
        auth: codexAuth,
        ...options.mcpRuntime.codexDeps,
        ...options.codexRuntime?.deps,
        runtimeConfig: {},
        binaryPath: options.codexBinaryPath,
        logger: LOGGER,
        getMcpToolApprovalPolicy: getDesktopMcpToolApprovalPolicy,
        mcpProviders,
        ...(options.makerMemory ? { makerMemory: options.makerMemory } : {}),
      })
    : null;
  const pi = options.piBinaryPath
    ? new PiAgent({
        getMcpToolApprovalPolicy: getDesktopMcpToolApprovalPolicy,
        auth: piAuth,
        prepareMcpBridge: options.mcpRuntime.preparePiMcpBridge,
        runtimeConfig: {
          get endpoint() { return options.gateway?.endpoint || undefined; },
        },
        binaryPath: options.piBinaryPath,
        logger: LOGGER,
        getMcpToolApprovalPolicy: getDesktopMcpToolApprovalPolicy,
        mcpProviders,
        resolvePiAgentHome: () => path.join(options.userDataDir, 'pi-agent-home'),
        resolvePiNativeProviders: () => options.providerConfig.piNativeProviders(),
        ...(options.makerMemory ? { makerMemory: options.makerMemory } : {}),
      })
    : null;
  const agents = {
    ...(agent ? { 'claude-code': agent } : {}),
    ...(codex ? { codex } : {}),
    ...(pi ? { pi } : {}),
  };
  options.providerConfig.codexAccounts.setCodexAccountRetirement(async id => {
    if (id === 'openai') await codex?.disposeLocalHostForCredentialChange('Host OpenAI credentials changed');
    else await codex?.disposeAccountHosts(id);
  });
  const capabilitiesByAgent = Object.fromEntries(
    Object.entries(agents).map(([kind, instance]) => [kind, instance.capabilities]),
  );
  const maker = new Maker({
    agents,
    storage: options.storage,
    lifecycleHooks: { onClose: async id => {
      try { await options.codexRuntime?.closeSession(id); }
      finally { await options.onSessionClose?.(id); }
    } },
    logger: LOGGER,
    ...(options.makerMemory ? { makerMemory: options.makerMemory } : {}),
  });
  const owner = activeOwnerScopeKey();
  const hostSessions = key => maker.listActiveSessions().filter(session => session.agentKind === 'codex'
    && !session.remoteHostId && (session.codexHostKey ?? 'local') === key);
  const gatewayRestart = new GatewayCodexRestartService({
    listHostKeys: () => codex?.getLocalHostKeysForCredentialMode('gateway-key') ?? [],
    restartHost: async (targetHostKey, stillValid) => {
      if (codex) await refreshCodexGatewayRuntime({ maker, agent: codex, targetHostKey, stillValid,
        isCurrent: () => owner === activeOwnerScopeKey() && !isAppSessionBoundaryPending(),
        isSessionInTurn: options.isSessionInTurn ?? (() => false) });
    },
    hasBusySession: key => hostSessions(key).some(session => isLocalSessionBusy(session, options.isSessionInTurn)),
    listSessionIds: key => hostSessions(key).map(session => session.id),
    onQueueGateReleased: createDeferredRestartSettledWake({ wakeSession: options.wakeSession ?? (() => {}) }),
    logger: LOGGER,
  });
  return { maker, agent, codex, pi, gatewayRestart, capabilitiesByAgent, instances: agents,
    agents: /** @type {import('@cindy/maker-core').AgentKind[]} */ (Object.keys(agents)) };
}
