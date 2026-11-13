import { getDesktopClaudeReadOnlyAllowedTools, getDesktopMcpToolApprovalPolicy } from '../../../desktop/src/main/maker-host/mcp-tool-approval-policy.js';
import { claudeSubagentUsageBridge } from '../../../desktop/src/main/maker-host/claude-subagent-usage-bridge.js';
import { createHostClaudeSubagentModelAccess } from './subagent-model-access.js';
import { createHostCodexAuthTokenReader } from './codex-token-reader.js';
import { CODEX_PROVIDER_OAUTH_PLACEHOLDER_KEY } from '../../../desktop/src/main/maker-host/codex-gateway-config.js';
/** Node assembly of the shared Maker agents, provider configuration and MCP transports.
 * Native login, settings and platform integrations are assembled by the owning runtime. */

import os from 'node:os';
import path from 'node:path';
import { mkdir, rm } from 'node:fs/promises';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../../../desktop/src/main/appSessionState.js';
import { ClaudeCodeAgent } from '@cindy/maker-core/agents/claude-code';
import { CodexAgent } from '@cindy/maker-core/agents/codex';
import { Maker, PiAgent } from '@cindy/maker-core';
import type { AgentDeps, AgentKind, AuthAdapter, AuthAdapterOptions, AuthLoginOptions, AuthState, MakerDeps, MakerMemoryManager } from '@cindy/maker-core';

import { hasClaudeNativeLogin } from '../../../desktop/src/main/maker-host/claude-native-auth.ts';
import { createMakerLogger } from '../../../desktop/src/main/maker-host/logger-adapter.js';
import { readCodexLocalAuthState } from '../../../desktop/src/main/maker-host/codex-local-auth-state.js';
import { commitHostCodexDisconnectBoundary, readHostCodexInvalidation, readHostCodexRecoveryRequirement } from './codex-invalidation.js';
import { createHostCodexSystemLogin, detectHostCodexCredentialScope, resolveHostSystemCodexAuthPath } from './codex-system-login.js';
import { CLAUDE_PROVIDER_AUTH_PLACEHOLDER_KEY, isAnthropicWireModel } from '../../../desktop/src/main/maker-host/claude-gateway-config.js';
import { createPiAuthAdapter } from '../../../desktop/src/main/maker-host/pi-auth.js';
import { createPiNativeCompatOverridesStore } from '../../../desktop/src/main/maker-host/piNativeCompatOverridesStoreCore.js';
import { createMainI18n } from '../../../desktop/src/main/i18n.js';
import { CLAUDE_ACCOUNT_RETIRED_REASON, subscriptionAccountKind } from '../../../desktop/src/main/maker-host/subscription-account-kind.js';
import { getActiveCatalog, getLocalCatalogOverridesSnapshot } from '../../../desktop/src/main/maker-host/active-catalog.js';
import { resolvePiCindyGatewayModelApi, resolvePiCindyGatewayModelSpec } from '../../../desktop/src/main/maker-host/piNativeProvidersCore.js';
import { createHostPiNativeProviders } from './pi-native-providers.js';
import { spawnHostPiSubagentRunner } from './pi-subagent-runner.js';
import { createHostPiPackages } from './pi-packages.js';
import { deriveAvailableModels, refreshCatalogDerivedModels, resolveModelContextProviderId, resolvePiGatewayDescriptorProviderId, resolvePiRuntimeModelDescriptor } from '../../../desktop/src/main/maker-host/catalog-to-descriptors.js';
import { DESKTOP_CAPABILITY_ROUTING_POLICY } from '../../../desktop/src/main/maker-host/capability-routing.js';
import { createCodexCapabilityRouting } from '../../../desktop/src/main/maker-host/codexCapabilityRouting.js';
import { createPluginRegistry } from '../../../desktop/src/main/maker-host/plugins/index.js';
import { createClaudeModelResolvers, createCodexModelResolvers, createPiModelResolvers } from '../../../desktop/src/main/maker-host/engineModelResolvers.js';
import { isNativeProviderAuthBound, bindNativeProviderAuth, unbindNativeProviderAuth } from '../../../desktop/src/main/maker-host/nativeProviderAuthBinding.js';

import { GatewayCodexRestartService } from '../../../desktop/src/main/maker-ipc/gatewayCodexRestart.js';
import { createDeferredRestartSettledWake } from '../../../desktop/src/main/maker-ipc/deferredRestartQueueWiring.js';
import { refreshCodexGatewayRuntime } from '../../../desktop/src/main/maker-host/codexGatewayRefresh.js';
import { isLocalSessionBusy, prepareLocalCodexCredentialModeSwitch } from '../../../desktop/src/main/maker-host/codex-credential-switch.js';
import type { createHostProviderConfig } from './provider-config.js';
import type { createHostMcpRuntime } from './mcp-runtime.js';
import type { createHostCodexRuntime } from './codex-runtime.js';
import type { createHostClaudeProxyRuntime } from './claude-proxy-runtime.js';
import { createHostModelContext } from './model-context.js';
import { readDisabledSkillPaths } from '../../../desktop/src/main/skillhub/activationPreferences.js';
import { createHostStartOptions } from './start-options.js';
import { createBashConcurrencyHooks, mergeClaudeHooks } from '../../../desktop/src/main/maker-host/claude-hooks/bash-concurrency-hook.js';
import { createReadImageHook } from '../../../desktop/src/main/maker-host/claude-hooks/read-image-hook.js';
import { createDesktopInputShellGuardHooks } from '../../../desktop/src/main/maker-host/claude-hooks/desktop-input-shell-guard-hook.js';
import { readAgentResourceSettings } from '../../../desktop/src/main/maker-host/agent-resource-settings-store.js';
import { createCommandConcurrencyGate } from '../../../desktop/src/main/maker-host/command-concurrency-gate.js';
import { createHostVisionBridge, type VisionBridgeNotice } from './vision-bridge.js';
import { captureKnownFileBefore, noteOpaqueTurnChange } from '../../../desktop/src/main/turn-change-set/store.js';
import { readCodexHistoryHasProductPrompt, writeCodexHistoryHasProductPrompt } from '../../../desktop/src/main/maker-host/session-storage.js';
import { buildPiRuntimeConfig, claudeUpstreamEndpoint, createAgentRuntimeConfigs } from '../../../desktop/src/main/maker-host/runtimeConfigsCore.js';
import { hostRuntimeLayout } from '../runtime-layout.mjs';
import { createHostAutoReview } from './auto-review.js';
import { createClaudeAutoPermissionFallbackCoordinator, setClaudeAutoClassifierUnavailableListener } from '../../../desktop/src/main/maker-host/claude-auto-permission-fallback.js';
import { registerAgentProcess, registerCodexProcessRole } from '../../../desktop/src/main/process-monitor/codex-process-registry.js';
import { resolveSessionCcDebugFile, trackSessionCcDebugFile } from '../../../desktop/src/main/logger.js';

type HostProviderConfig = ReturnType<typeof createHostProviderConfig>;

/** The live gateway view from model-access.ts; it never retains a replaced key. */
export interface HostGateway { readonly endpoint?: string; readonly credential?: string | null }

/** A selected custom provider's route (provider-credentials.mjs). */
export interface HostProviderRoute { anthropicBaseUrl: string; apiKey?: string | null }
export type HostProviderRouteResolver = (providerId: string, agent: AgentKind) => Promise<HostProviderRoute | null>;

export interface HostAgentGraphOptions {
  userDataDir: string;
  providerConfig: HostProviderConfig;
  mcpRuntime: ReturnType<typeof createHostMcpRuntime>;
  codexRuntime?: ReturnType<typeof createHostCodexRuntime> | null;
  /** The Claude and Pi loopback proxy (claude-proxy-runtime.ts). Without it the engines reach the gateway directly. */
  claudeProxy?: ReturnType<typeof createHostClaudeProxyRuntime> | null;
  storage: MakerDeps['storage'];
  gateway?: HostGateway | null;
  resolveProviderRoute?: HostProviderRouteResolver;
  binaryPath?: string | null;
  codexBinaryPath?: string;
  piBinaryPath?: string;
  makerMemory?: MakerMemoryManager;
  mcpProviders?: NonNullable<AgentDeps['mcpProviders']>;
  onSessionClose?: (id: string) => unknown;
  isSessionInTurn?: (id: string) => boolean;
  /** The window's MCP duplicate choices for Claude (mcp-duplicate-choices.ts), as the desktop constructor. */
  resolveLocalMcpDuplicateChoices?: AgentDeps['resolveLocalMcpDuplicateChoices'];
  wakeSession?: (id: string, reason: string) => void;
  /** Applies the account's provider models to the active catalog before a task starts. */
  ensureProviderCatalog?: () => Promise<unknown>;
  /** The plugin roster section from the Host plugin gateway. */
  getGhostRosterPrompt?: AgentDeps['getGhostRosterPrompt'];
  /** Built-in and approved plugin Skills (Desktop listCindyManagedSkills). All three engines get
   * it as on the desktop; Codex only reads it to switch off its own copy when the computer that
   * runs the task supplies managed Skills. Codex's Skill projection itself is release row 25. */
  getManagedSkills?: AgentDeps['getManagedSkills'];
  /** Directory holding the bundled harnesses, including `ripgrep-bin`. Defaults to the Host layout. */
  harnessRoot?: string;
  /** The Host event hub, for the vision-bridge notices the desktop sends its windows. */
  publishVisionBridgeNotice?: (notice: VisionBridgeNotice) => void;
  /** The account gateway's rejected-key report (model-access.ts), for the one-shot review requests. */
  reportGatewayKeyRejected?: (key: string) => void;
  /** The account realm (main.ts), as the desktop's getActiveAuthRealm for the Codex token reader. */
  readAuthRealm?: () => string | null;
}

export const LOGGER = createMakerLogger('maker');

const missingRouteResolver: HostProviderRouteResolver = async () => { throw new Error('Provider credential resolver is unavailable'); };

/** A credential adapter retained by an outgoing task cannot authenticate a new owner. */
function bindAuthOwner<T extends AuthAdapter>(adapter: T): T {
  const owner = activeOwnerScopeKey();
  const current = () => activeOwnerScopeKey() === owner && !isAppSessionBoundaryPending();
  const check = () => { if (!current()) throw new Error('AUTH_OWNER_CHANGED'); };
  return {
    ...adapter,
    async getState(options?: AuthAdapterOptions) {
      if (!current()) return { authenticated: false, errorReason: 'owner_changed' };
      const state = await adapter.getState(options);
      return current() ? state : { authenticated: false, errorReason: 'owner_changed' };
    },
    async getAuthEnv(options?: AuthAdapterOptions) {
      check(); const env = await adapter.getAuthEnv(options); check(); return env;
    },
    async triggerLogin(options?: AuthLoginOptions) { check(); const state = await adapter.triggerLogin(options); check(); return state; },
    async logout() { check(); await adapter.logout(); check(); },
  };
}


/**
 * Subscription-only view: state comes from the shared verdict, and the lane
 * injects no credentials because the CLI authenticates itself.
 */
export function createClaudeSubscriptionAuth(gateway: HostGateway | null | undefined, resolveRoute: HostProviderRouteResolver = missingRouteResolver, cli?: HostProviderConfig['claudeNative']) {
  const owner = activeOwnerScopeKey();
  const current = () => owner === activeOwnerScopeKey() && !isAppSessionBoundaryPending();
  return bindAuthOwner({
    async getState(opts?: AuthAdapterOptions) {
      if (opts?.providerId && !['xd', 'cindy', 'anthropic'].includes(opts.providerId)) {
        try { await resolveRoute(opts.providerId, 'claude-code'); return { authenticated: true, authSource: 'api-key', identity: opts.providerId }; }
        catch { return { authenticated: false, errorReason: 'not_connected' }; }
      }
      if (cli && isNativeProviderAuthBound('anthropic')) await cli.readClaudeCliLoginStatus({ maxAgeMs: 30_000 });
      return hasClaudeNativeLogin()
        ? { authenticated: true, authSource: 'oauth', identity: 'Claude subscription' }
        : { authenticated: false, errorReason: 'not_connected' };
    },
    async triggerLogin(_options?: AuthLoginOptions) {
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
    async getAuthEnv(opts?: AuthAdapterOptions) {
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

/** The loopback proxy facts the Claude adapter reads (claude-proxy-runtime.ts). */
type ClaudeProxyAuthView = Pick<ReturnType<typeof createHostClaudeProxyRuntime>, 'isReady' | 'endpoint' | 'inboundSecret' | 'gatewayInboundSecret'>;
/** SuperGrok connection state, read for subscription accounts (desktop subscriptionAccountState). */
type GrokLoginView = Pick<HostProviderConfig['grok'], 'hasGrokOAuthLogin' | 'grokAccountIdentity'>;

/**
 * Claude through the loopback proxy, branch for branch the desktop Claude adapter
 * (auth-adapters.ts DesktopClaudeAuthAdapter getState/getAuthEnv): gateway sessions carry
 * the gateway key; an explicit non-gateway source carries only a placeholder, and the
 * proxy routes it with that source's credential. The Host's placeholder is the proxy
 * runtime's secret. Claude subscription sessions use the CLI's own login. Subscription
 * accounts route through the responses bridge (claude-proxy-runtime.ts).
 * Not here, by design: the desktop's safeStorage check (the Host keeps its own
 * credential store), shared Skill projection (release row 25) and the desktop-only
 * legacy config migration.
 */
function createClaudeProxyAuth(gateway: HostGateway | null | undefined, native: ReturnType<typeof createClaudeSubscriptionAuth>,
  proxy: ClaudeProxyAuthView, cli?: HostProviderConfig['claudeNative'], grok?: GrokLoginView) {
  const gatewayKey = () => gateway?.credential || null;
  // A proxy secret travels only with the loopback address it was read with, so it can never be
  // sent to the upstream. While the proxy is not ready (getClaudeEndpoint falls back to the
  // upstream) the CLI carries what the desktop CLI carries.
  const viaProxy = (secret: string): Record<string, string> | null =>
    (proxy.isReady() ? { ANTHROPIC_API_KEY: secret, ANTHROPIC_BASE_URL: proxy.endpoint() } : null);
  // Gateway sessions: the proxy swaps the secret for the key current when each request arrives.
  const gatewayEnv = () => viaProxy(proxy.gatewayInboundSecret()) ?? { ANTHROPIC_API_KEY: gatewayKey()! };
  // Explicit sources: the proxy routes the secret as the desktop routes the provider placeholder.
  const providerEnv = () => viaProxy(proxy.inboundSecret()) ?? { ANTHROPIC_API_KEY: CLAUDE_PROVIDER_AUTH_PLACEHOLDER_KEY };
  // The desktop's claudeNativeLoginState (CLAUDE_CLI_STATUS_MAX_AGE_MS = 60 s).
  const nativeLoginState = async (): Promise<AuthState> => {
    const login = cli && isNativeProviderAuthBound('anthropic') ? await cli.readClaudeCliLoginStatus({ maxAgeMs: 60_000 }) : null;
    return login?.loggedIn
      ? { authenticated: true, identity: 'Claude.ai · OAuth', authSource: 'oauth' }
      : { authenticated: false, errorReason: 'no_oauth' };
  };
  const networkEnv = async () => (cli ? cli.claudeCliNetworkEnv() : {});
  const servesModel = (model: string | undefined) => model === undefined || isAnthropicWireModel(model);
  return bindAuthOwner({
    async getState(opts?: AuthAdapterOptions): Promise<AuthState> {
      if (opts?.nativeSubscriptionAccount && opts.providerId === 'openai' && !proxy.isReady())
        return { authenticated: false, errorReason: 'proxy_not_ready' };
      if (opts?.nativeSubscriptionAccount) return opts.nativeSubscriptionAccount.readState();
      const kind = opts?.providerId ? subscriptionAccountKind(opts.providerId) : null;
      if (opts?.providerId && kind) {
        if (!proxy.isReady()) return { authenticated: false, errorReason: 'proxy_not_ready' };
        // The desktop's subscriptionAccountState: SuperGrok accounts read their own login;
        // independently added Claude accounts are retired.
        if (kind === 'claude') return { authenticated: false, errorReason: CLAUDE_ACCOUNT_RETIRED_REASON, authSource: 'oauth' };
        return { authenticated: grok?.hasGrokOAuthLogin(opts.providerId) ?? false,
          identity: grok?.grokAccountIdentity(opts.providerId), authSource: 'oauth' };
      }
      if (opts?.credentialMode === 'gateway-key') {
        return gatewayKey() ? { authenticated: true, identity: 'API Key · Cindy AI', authSource: 'api-key' }
          : { authenticated: false, errorReason: 'no_key' };
      }
      if (opts?.credentialMode === 'provider-oauth') {
        return proxy.isReady() ? { authenticated: true, identity: 'Provider · Proxy', authSource: 'api-key' }
          : { authenticated: false, errorReason: 'proxy_not_ready' };
      }
      if (opts?.credentialMode === 'oauth-bearer') return nativeLoginState();
      if (gatewayKey()) return { authenticated: true };
      const login = await nativeLoginState();
      if (!login.authenticated) return { authenticated: false, errorReason: 'no_key' };
      return servesModel(opts?.model) ? login : { authenticated: true };
    },
    triggerLogin: (options?: AuthLoginOptions) => native.triggerLogin(options),
    cancelLogin: () => native.cancelLogin(),
    logout: () => native.logout(),
    // As the desktop's DesktopClaudeAuthAdapter.getOneShotAuth: with a Claude Code login connected,
    // the Host's own one-shot requests use the gateway key on the gateway endpoint, never the
    // subscription and not through the loopback proxy's routing.
    async getOneShotAuth(): Promise<{ apiKey: string; baseURL?: string } | null> {
      const apiKey = gatewayKey();
      if (!apiKey) return null;
      if (hasClaudeNativeLogin()) return { apiKey, baseURL: claudeUpstreamEndpoint() };
      // Without a login the desktop's one-shot request takes the gateway key from getAuthEnv and
      // the engine endpoint (the proxy). Here the secret and its address come as one pair; while
      // the proxy is not ready, null leaves the desktop's own fallback (the key, the upstream).
      const route = viaProxy(proxy.gatewayInboundSecret());
      return route ? { apiKey: route.ANTHROPIC_API_KEY, baseURL: route.ANTHROPIC_BASE_URL } : null;
    },
    async getAuthEnv(opts?: AuthAdapterOptions): Promise<Record<string, string>> {
      if (opts?.nativeSubscriptionAccount) {
        const account = opts.nativeSubscriptionAccount;
        account.assertCurrent();
        return { ...(await networkEnv()), ...(!account.defaultProfile ? { CLAUDE_CONFIG_DIR: account.configDir } : {}) };
      }
      const env: Record<string, string> = {};
      if (opts?.providerId && subscriptionAccountKind(opts.providerId) === 'claude') {
        // A retired independent Claude account carries no credential.
      } else if (opts?.credentialMode === 'gateway-key') {
        if (gatewayKey()) Object.assign(env, gatewayEnv());
      } else if (opts?.credentialMode === 'provider-oauth') {
        Object.assign(env, providerEnv());
      } else if (opts?.credentialMode === 'oauth-bearer') {
        Object.assign(env, await networkEnv());
      } else {
        if (gatewayKey()) Object.assign(env, gatewayEnv());
        else if (hasClaudeNativeLogin()) {
          if (servesModel(opts?.model)) Object.assign(env, await networkEnv());
          else Object.assign(env, providerEnv());
        }
      }
      return env;
    },
  });
}

/** Gateway-key lane: the key is injected as ANTHROPIC_API_KEY for the CLI spawn. */
export function createClaudeGatewayAuth(gateway: HostGateway | null | undefined, resolveRoute: HostProviderRouteResolver = missingRouteResolver, cli?: HostProviderConfig['claudeNative'], proxy?: ClaudeProxyAuthView | null,
  grok?: GrokLoginView) {
  const native = createClaudeSubscriptionAuth(null, resolveRoute, cli);
  if (proxy) return createClaudeProxyAuth(gateway, native, proxy, cli, grok);
  return bindAuthOwner({
    async getState(opts?: AuthAdapterOptions) {
      if (opts?.providerId === 'anthropic' || opts?.credentialMode === 'oauth-bearer') return native.getState(opts);
      if (!opts?.providerId && !opts?.credentialMode && !gateway?.credential) return native.getState(opts);
      if (opts?.providerId && opts.providerId !== 'xd' && opts.providerId !== 'cindy') {
        try { await resolveRoute(opts.providerId, 'claude-code'); return { authenticated: true, authSource: 'api-key', identity: opts.providerId }; }
        catch { return { authenticated: false, errorReason: 'not_connected' }; }
      }
      return gateway?.credential ? { authenticated: true, authSource: 'api-key', identity: 'Cindy gateway' }
        : { authenticated: false, errorReason: 'no_key' };
    },
    triggerLogin: (options?: AuthLoginOptions) => native.triggerLogin(options),
    cancelLogin: () => native.cancelLogin(),
    logout: () => native.logout(),
    async getAuthEnv(opts?: AuthAdapterOptions) {
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
export function createCodexLocalCliAuth(gateway: HostGateway | null | undefined, resolveRoute: HostProviderRouteResolver | undefined, codexHome: string,
  accounts?: HostProviderConfig['codexAccounts'], config?: HostProviderConfig,
  native?: {
    /** Server-side invalidation of the native login (codex-runtime.ts invalidateNative). */
    invalidate?: NonNullable<AuthAdapter['invalidate']>;
    /** After every login and logout, as the desktop's auth handler (maker-ipc/auth.ts). */
    onAuthBoundary?: () => void;
    /** The desktop adapter's onLoginSuccess and onLogoutSuccess (codex-auth-boundary.ts). */
    afterLogin?: () => Promise<void>;
    afterLogout?: () => Promise<void>;
    /** The runtime's reconciliation with the system Codex login (codex-system-login.ts). */
    systemLogin?: ReturnType<typeof createHostCodexSystemLogin>;
  }) {
  const invalidate = native?.invalidate;
  if (!codexHome || !path.isAbsolute(codexHome)) throw new Error('Codex requires an explicit isolated profile');
  const owner = activeOwnerScopeKey();
  const current = () => owner === activeOwnerScopeKey() && !isAppSessionBoundaryPending();
  // The desktop adapter's reconciliation with the system Codex login (codex-system-login.ts);
  // without the Codex runtime there is none.
  const systemLogin = native?.systemLogin ?? createHostCodexSystemLogin({ codexHome, systemAuthPath: null, loginActive: () => false });
  const systemAuthPath = systemLogin.systemAuthPath;
  // The desktop's explicit logout (auth-adapters.ts logout, runLogout, disconnectCodexOAuth), one
  // operation at a time: a later logout joins the running one, and a login waits for it.
  let logoutOperation: Promise<void> | null = null;
  let logoutsStarted = 0;
  const runLogout = async (accountService: NonNullable<typeof accounts>) => {
    try {
      // Stop the login in progress; it settles below, before the local host is retired.
      accountService.cancelCodexAccountLogin('openai');
      if (!current()) return;
      // The durable disconnect marker over the current file. auth.json stays: an explicit
      // disconnect only stops Cindy's use of it (a shared login's link stays in place too).
      commitHostCodexDisconnectBoundary(codexHome, systemAuthPath);
      // Waits for the cancelled login and retires the local Codex host (the account service).
      await accountService.retireCodexAccount('openai');
      if (!current()) return;
      // The desktop's onLogoutSuccess.
      await native?.afterLogout?.();
      if (!current()) return;
      // The account-less models cache goes with the login, as on the desktop.
      try { await rm(path.join(codexHome, 'models_cache.json'), { force: true }); } catch (error) {
        LOGGER.warn('remove stale Codex models_cache.json failed', { error: error instanceof Error ? error.message : String(error) });
      }
      if (!current()) return;
      // Again at the end: an invalidation in between may have rewritten the marker.
      commitHostCodexDisconnectBoundary(codexHome, systemAuthPath);
      // Last, as on the desktop: the marker already disconnects if a step above fails.
      unbindNativeProviderAuth('openai', { revoked: true });
    } finally { if (current()) native?.onAuthBoundary?.(); }
  };
  const adapter = bindAuthOwner({
    // maker-core reports a server-rejected login here (codex/index.ts), as on the desktop.
    ...(invalidate ? { invalidate } : {}),
    async getState(opts?: AuthAdapterOptions) {
      if (opts?.nativeSubscriptionAccount) return opts.nativeSubscriptionAccount.readState();
      if (opts?.providerId && !['xd', 'cindy', 'openai'].includes(opts.providerId)) {
        if (accounts?.isCodexAccountProvider(opts.providerId)) return accounts.codexAccountState(opts.providerId);
        try {
          if (config) {
            const provider = (await config.publicViews(Boolean(gateway?.credential))).find(item => item.id === opts.providerId);
            if (!provider?.connected || !provider.routing?.codex) throw new Error('Provider requires connection');
          } else await resolveRoute!(opts.providerId, 'codex');
          return { authenticated: true, authSource: 'api-key', identity: opts.providerId };
        }
        catch { return { authenticated: false, errorReason: 'not_connected' }; }
      }
      const gatewayState: AuthState = gateway?.credential
        ? { authenticated: true, authSource: 'api-key', identity: 'Cindy AI' }
        : { authenticated: false, errorReason: 'no_key' };
      if (opts?.credentialMode === 'gateway-key' || (['xd', 'cindy'] as Array<string | null | undefined>).includes(opts?.providerId)) return gatewayState;
      // As the desktop's readState: a server-invalidated login reports why until it is replaced.
      const invalidated = readHostCodexInvalidation(codexHome, systemAuthPath);
      if (invalidated) return { authenticated: false, errorReason: invalidated.reason, credentialScope: invalidated.credentialScope };
      // Then the reconciliation with the system login, as readState does before reading auth.json.
      await systemLogin.reconcile();
      const recovery = readHostCodexRecoveryRequirement(codexHome, systemAuthPath);
      const local = await readCodexLocalAuthState(codexHome);
      // The desktop reads the token through getAccessToken, which reconciles again before its
      // binding check, so a claim the first pass abandoned is made for the current session.
      if (local.authenticated && local.authSource === 'oauth') await systemLogin.reconcile();
      const native = isNativeProviderAuthBound('openai') ? local : null;
      if (native?.authenticated && native.authSource === 'oauth') {
        const scoped = { ...native, credentialScope: detectHostCodexCredentialScope(codexHome, systemAuthPath) };
        // The desktop's withCodexRecoveryRequirement.
        return recovery ? { ...scoped, recoveryRequiredReason: recovery.reason, credentialScope: recovery.credentialScope } : scoped;
      }
      if (opts?.providerId === 'openai' || opts?.credentialMode === 'oauth-bearer') {
        // The desktop's codexRecoveryRequiredErrorState.
        if (recovery) return { authenticated: false, errorReason: recovery.reason, credentialScope: recovery.credentialScope };
        if (opts?.credentialMode === 'oauth-bearer') {
          // As the desktop's oauth-bearer readState: the local file's own reason, else no_oauth.
          const local = native ?? await readCodexLocalAuthState(codexHome);
          return { authenticated: false, errorReason: (local.authenticated ? undefined : local.errorReason) ?? 'no_oauth' };
        }
        return { authenticated: false, errorReason: native?.errorReason ?? 'oauth_not_bound' };
      }
      return gatewayState;
    },
    async triggerLogin(options?: AuthLoginOptions) {
      if (!accounts) throw new Error('Codex account service is unavailable');
      // As the desktop: a login started during a logout waits for it.
      if (logoutOperation) await logoutOperation.catch(() => undefined);
      const logoutsAtStart = logoutsStarted;
      try {
        const result = await accounts.loginCodexAccount('openai', current, undefined, {
          mode: options?.mode === 'device-code' ? 'device-code' : 'browser', onProgress: options?.onProgress,
        });
        if (!result.ok || !current()) return { authenticated: false, errorReason: result.reason ?? 'owner_changed' };
        // As the desktop's late cancel: a logout that started during this login wins; its marker
        // covers the file this login wrote.
        if (logoutsStarted !== logoutsAtStart) return { authenticated: false, errorReason: 'login_cancelled' };
        try { bindNativeProviderAuth('openai', { instanceIsolated: true }); }
        catch (error) { result.rollbackCredentials?.(); throw error; }
        // The desktop's reconcileWithSystemCodexAfterLogin.
        if (current()) await systemLogin.reconcileAfterLogin();
        if (current()) await native?.afterLogin?.();
        return accounts.codexAccountState('openai');
      } finally { if (current()) native?.onAuthBoundary?.(); }
    },
    cancelLogin() { accounts?.cancelCodexAccountLogin('openai'); },
    async logout() {
      if (!accounts) throw new Error('Codex account service is unavailable');
      if (!logoutOperation) {
        logoutsStarted += 1;
        const operation = runLogout(accounts).finally(() => { if (logoutOperation === operation) logoutOperation = null; });
        logoutOperation = operation;
      }
      return logoutOperation;
    },
    async getAuthEnv(opts?: AuthAdapterOptions) {
      if (opts?.nativeSubscriptionAccount) {
        opts.nativeSubscriptionAccount.assertCurrent();
        return { CODEX_HOME: opts.nativeSubscriptionAccount.configDir };
      }
      await mkdir(codexHome, { recursive: true, mode: 0o700 });
      // As the desktop's getAuthEnv: reconcile unless the login is invalidated, except for the
      // gateway-key and provider-oauth spawns and independent accounts, which it never reconciles for.
      const reconcileForSpawn = opts?.credentialMode !== 'gateway-key' && opts?.credentialMode !== 'provider-oauth'
        && !(opts?.providerId && accounts?.isCodexAccountProvider(opts.providerId));
      if (reconcileForSpawn && !readHostCodexInvalidation(codexHome, systemAuthPath)) await systemLogin.reconcile();
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
  return adapter;
}


export function createHostAgentGraph(options: HostAgentGraphOptions) {
  const mcpProviders = options.mcpProviders ?? [];
  const codexAuth = createCodexLocalCliAuth(options.gateway, options.resolveProviderRoute, path.join(options.userDataDir, 'codex-home'), options.providerConfig.codexAccounts, options.providerConfig,
    options.codexRuntime ? {
      invalidate: (reason, context) => options.codexRuntime!.invalidateNative(reason, context),
      onAuthBoundary: () => options.codexRuntime!.subscriptions.bridge.clearChatgptBridgeCredentialCache(),
      afterLogin: () => options.codexRuntime!.authBoundary.afterLogin(),
      afterLogout: () => options.codexRuntime!.authBoundary.afterLogout(),
      systemLogin: options.codexRuntime!.systemLogin,
    } : undefined);
  // The desktop retires every local Codex host at an auth boundary (maker-host/index.ts).
  options.codexRuntime?.setLocalHostRetirement(async reason => {
    await codex?.forceDisposeLocalHostForAuthChange(reason, { preserveExternalAuth: true });
  });
  const config = options.providerConfig;
  // The desktop's Auto-review and tool-loop review (maker-host/index.ts), handed to the same
  // engines under the same keys (auto-review.ts).
  const autoReview = createHostAutoReview({
    userDataDir: options.userDataDir, getMaker: () => maker, gateway: options.gateway,
    reportGatewayKeyRejected: options.reportGatewayKeyRejected, providerConfig: config,
    bridge: () => options.codexRuntime?.subscriptions.bridge ?? null, logger: LOGGER,
  });
  const piAuth = bindAuthOwner(createPiAuthAdapter({
    subscriptionAccountKind,
    subscriptionAccountState: id => subscriptionAccountKind(id) === 'claude'
      ? { authenticated: false, errorReason: 'claude_account_retired', authSource: 'oauth' }
      : { authenticated: config.grok.hasGrokOAuthLogin(id), identity: config.grok.grokAccountIdentity(id), authSource: 'oauth' },
    // The desktop's predicate (codex-account-auth.ts): openai, or a user-added provider with a native Codex login.
    isOpenAiSubscriptionProviderId: id => config.codexAccounts.isOpenAiSubscriptionProviderId(id),
    desktopCodexAuthAdapter: codexAuth,
    hasGrokOAuthLogin: config.grok.hasGrokOAuthLogin,
    listCustomProvidersWithSecureHeaders: config.list,
    readCustomProviderKey: config.readKey,
    readCachedGenericOAuthAccessToken: config.oauth.readCachedGenericOAuthAccessToken,
    readClaudeApiKey: () => options.gateway?.credential ?? null,
  }));
  // The same per-model resolvers the desktop gives each engine (engineModelResolvers.ts).
  const modelContext = options.codexRuntime?.modelContext ?? createHostModelContext({
    readGatewayKey: () => options.gateway?.credential || null, hasCodexOAuthLogin: () => false,
    codexAccountState: id => options.providerConfig.codexAccounts.codexAccountState(id),
  });
  // The desktop start hook's steps that apply to a task the Host runs (start-options.ts).
  const startOptions = createHostStartOptions({
    modelContext, fastPolicies: options.codexRuntime?.fastPolicies ?? null, logger: LOGGER,
    ensureProviderCatalog: options.ensureProviderCatalog,
    // Engines read these lists at start; refresh them against the catalog just applied.
    refreshModels: () => refreshCatalogDerivedModels(maker, modelContext.getSelectableCatalog()),
    reloadCodexSkills: workingDir => codex ? codex.listAgentSkills({ workingDir, forceReload: true }) : Promise.resolve(),
  });
  // Model lists derived from the selectable catalog, as the desktop injects them.
  const availableModels = (agent: AgentKind) => ({ availableModels: deriveAvailableModels(modelContext.getSelectableCatalog(), agent) });
  const codexCapabilityRouting = createCodexCapabilityRouting({
    getBridgeServerNames: () => options.mcpRuntime.getActiveCodexBridgeServerNames(),
    getDisabledRuntimePluginIds: workingDir => createPluginRegistry().getDisabledRuntimePluginIds(workingDir),
  });
  const claudeModelResolvers = createClaudeModelResolvers({
    getCatalog: modelContext.getSelectableCatalog, resolveContextProviderId: modelContext.resolveContextProviderId,
  });
  const codexBinaryPath = options.codexBinaryPath;
  // The desktop runtime configs (runtimeConfigsCore.ts): product system prompt, answer
  // delivery prompt, behavior flags, memory settings, compaction and subagent model.
  const harnessRoot = options.harnessRoot ?? hostRuntimeLayout().harnessRoot;
  const runtimeConfigs = createAgentRuntimeConfigs({
    userDataPath: () => options.userDataDir,
    ripgrepCandidates: key => [path.join(harnessRoot, 'ripgrep-bin', key)],
    codexBinaryPath: () => codexBinaryPath,
  });
  // Without an account gateway the Host keeps the endpoint unset, as before.
  const hostEndpoint = (() => options.gateway?.endpoint || undefined) as () => string;
  // Claude and Pi reach the account through the loopback proxy, as on the desktop
  // (getClaudeEndpoint: the proxy once ready, else the upstream).
  const claudeProxy = options.claudeProxy;
  const engineEndpoint = claudeProxy ? () => claudeProxy.endpoint() : hostEndpoint;
  const codexModelResolvers = codexBinaryPath ? createCodexModelResolvers({
    getCatalog: modelContext.getSelectableCatalog, resolveContextProviderId: modelContext.resolveContextProviderId,
    getCodexHome: () => path.join(options.userDataDir, 'codex-home'), getCodexBinaryPath: () => codexBinaryPath,
  }) : null;
  // Pi resolves against the full active catalog with the plain route resolver, as on the desktop.
  const piModelResolvers = createPiModelResolvers({ getCatalog: getActiveCatalog, resolveContextProviderId: resolveModelContextProviderId });
  // The desktop's Claude hooks (maker-host/index.ts claudeHooks), from the same modules: the
  // read-image resize, the Bash concurrency gate (one per runtime, as the desktop has one per
  // Maker; its limit read from the agent resource settings at every admission) and the
  // desktop-input shell guard while the computer plugin is enabled.
  const commandConcurrencyGate = createCommandConcurrencyGate({
    readMaxConcurrent: () => readAgentResourceSettings().maxConcurrentCommands,
    log: LOGGER.child('command-gate'),
  });
  const claudeHooks = mergeClaudeHooks(
    { PreToolUse: [{ matcher: 'Read', hooks: [createReadImageHook(LOGGER)] }] },
    createBashConcurrencyHooks(commandConcurrencyGate, LOGGER),
    // As the desktop's getPluginRegistry(): the owner's registry, read at each check.
    createDesktopInputShellGuardHooks(() => createPluginRegistry().isEnabled('computer'), LOGGER),
  );
  // The desktop's vision bridge (maker-host/index.ts): the Maker hook, the Pi env and, once Maker
  // exists, the process-wide controller the loopback proxies read (vision-bridge.ts).
  const visionBridge = createHostVisionBridge({
    userDataDir: options.userDataDir,
    getMaker: () => maker,
    readCustomProviderKey: config.readKey,
    readGatewayKey: () => options.gateway?.credential ?? null,
    publish: notice => options.publishVisionBridgeNotice?.(notice),
    logger: LOGGER,
  });
  const agent = options.binaryPath ? new ClaudeCodeAgent({
    ...(options.resolveLocalMcpDuplicateChoices ? { resolveLocalMcpDuplicateChoices: options.resolveLocalMcpDuplicateChoices } : {}),
    claudeHooks,
    auth: createClaudeGatewayAuth(options.gateway, options.resolveProviderRoute, config.claudeNative, options.claudeProxy, config.grok),
    runtimeConfig: runtimeConfigs.buildClaudeRuntimeConfig(engineEndpoint),
    binaryPath: options.binaryPath,
    logger: LOGGER,
    getMcpToolApprovalPolicy: getDesktopMcpToolApprovalPolicy,
    // As the desktop: first-party read-only tools go through the SDK allowedTools.
    claudeAllowedTools: getDesktopClaudeReadOnlyAllowedTools(),
    reviewAutoPermissionAction: autoReview.reviewAutoPermissionAction,
    toolLoopReviewer: autoReview.toolLoopReviewer,
    // The process-wide usage bridge the loopback proxy (anthropicCompatProxyHostCore) fills, as on
    // the desktop: concurrent external-model subagents report their real usage.
    registerClaudeSubagentTask: (task) => claudeSubagentUsageBridge.registerTask(task),
    getClaudeSubagentTaskUsage: (taskId) => claudeSubagentUsageBridge.getTaskUsage(taskId),
    // As the desktop: an explicit Agent/Task model is checked against the live account facts at
    // each call; only an authoritative XD snapshot can deny it.
    resolveClaudeSubagentModelAccess: createHostClaudeSubagentModelAccess({
      readGatewayKey: () => options.gateway?.credential ?? null,
      listProviderViews: () => config.publicViews(Boolean(options.gateway?.credential)),
    }),
    // Skills the user disabled in Cindy, from the profile's activation preferences.
    getDisabledSkillPaths: readDisabledSkillPaths,
    ...(options.getGhostRosterPrompt ? { getGhostRosterPrompt: options.getGhostRosterPrompt } : {}),
    ...(options.getManagedSkills ? { getManagedSkills: options.getManagedSkills } : {}),
    capabilityRouting: DESKTOP_CAPABILITY_ROUTING_POLICY,
    capabilityAdditions: availableModels('claude-code'),
    // The turn change record the desktop keeps for Claude and Pi (turn-change-set/store.ts).
    turnChangeCapture: { beforeKnownFileWrite: captureKnownFileBefore, noteOpaqueWrite: noteOpaqueTurnChange },
    // As the desktop: the process registry (read by the quit-time Codex reaper and, from M2, the
    // process monitor) and each session's cc-debug raw file under the profile's logs directory.
    registerLocalAgentProcess: ({ pid, kind, role, sessionId }) =>
      registerAgentProcess(pid, kind, role, sessionId),
    resolveCcDebugFile: resolveSessionCcDebugFile,
    trackCcDebugFile: trackSessionCcDebugFile,
    ...claudeModelResolvers,
    ...(mcpProviders.length > 0 ? { mcpProviders } : {}),
    ...(options.makerMemory ? { makerMemory: options.makerMemory } : {}),
  }) : null;
  const codex = options.codexBinaryPath
    ? new CodexAgent({
        auth: codexAuth,
        ...options.mcpRuntime.codexDeps,
        ...options.codexRuntime?.deps,
        // As the desktop (maker-host/index.ts): each read is fenced to the owner, the realm and
        // this agent's runtime, and takes the login's own credentials only from an authenticated
        // oauth-bearer state of this agent's auth adapter.
        createCodexAuthTokenReader: createHostCodexAuthTokenReader({
          codexAuthAdapter: codexAuth,
          readOneShotCreds: providerId => options.codexRuntime?.native.readOneShotCreds(providerId) ?? null,
          isCodexAgentCurrent: () => options.codexRuntime?.isCurrent() ?? false,
          readAuthRealm: () => options.readAuthRealm?.() ?? null,
        }),
        ...codexModelResolvers,
        getDisabledSkillPaths: readDisabledSkillPaths,
        ...(options.getManagedSkills ? { getManagedSkills: options.getManagedSkills } : {}),
        // A getter, as on the desktop: evaluated after the MCP bridge is prepared.
        get capabilityRouting() { return codexCapabilityRouting.capabilityRouting(); },
        resolveCapabilityRouting: codexCapabilityRouting.resolveCapabilityRouting,
        capabilityAdditions: availableModels('codex'),
        ...(options.getGhostRosterPrompt ? { getGhostRosterPrompt: options.getGhostRosterPrompt } : {}),
        runtimeConfig: runtimeConfigs.buildCodexRuntimeConfig(),
        binaryPath: options.codexBinaryPath,
        logger: LOGGER,
        // As the desktop: Host exit reaps the tool trees below these app-servers (main.ts stop).
        registerLocalCodexAppServerProcess: ({ pid, role }) => registerCodexProcessRole(pid, role),
        getMcpToolApprovalPolicy: getDesktopMcpToolApprovalPolicy,
        // As the desktop: a credential-mode switch of the shared local app-server refuses busy
        // sessions and soft-closes idle ones first.
        prepareCodexLocalCredentialModeSwitch: async (ctx) => {
          await prepareLocalCodexCredentialModeSwitch({
            maker,
            isSessionInTurn: options.isSessionInTurn,
            hostKey: ctx.hostKey,
            fromMode: ctx.fromMode,
            fromModeEffective: ctx.fromModeEffective,
            toMode: ctx.toMode,
          });
        },
        reviewAutoPermissionAction: autoReview.reviewAutoPermissionAction,
        mcpProviders,
        ...(options.makerMemory ? { makerMemory: options.makerMemory } : {}),
      })
    : null;
  // The desktop's learned Pi cache compatibility (pi-native-compat-overrides-store.ts), on this
  // profile; the Pi bridge writes the file and the runtime reads it back.
  const piNativeCompatOverrides = createPiNativeCompatOverridesStore({ app: { getPath: () => options.userDataDir } });
  // As the desktop (pi-host.ts, maker-host/index.ts): Pi packages from this profile's pi-package-home.
  const piPackages = createHostPiPackages({ userDataDir: options.userDataDir, piBinaryPath: options.piBinaryPath ?? null });
  const piNativeProviders = createHostPiNativeProviders({
    userDataDir: options.userDataDir, piBinaryPath: options.piBinaryPath ?? null, endpoint: engineEndpoint,
    claudeProxy, providerConfig: config,
  });
  // The desktop's main-process strings (i18n.desktop.ts) in the system language, as
  // plugins/authorization.ts does; the window's language choice does not reach the Host.
  const { t } = createMainI18n(() => [Intl.DateTimeFormat().resolvedOptions().locale]);
  const pi = options.piBinaryPath
    ? new PiAgent({
        auth: piAuth,
        ...options.mcpRuntime.piDeps,
        runtimeConfig: buildPiRuntimeConfig({
          ripgrepPath: runtimeConfigs.getRipgrepBinaryPath(),
          userDataPath: options.userDataDir,
          endpoint: engineEndpoint,
          remoteEndpoint: () => claudeUpstreamEndpoint(),
        }),
        binaryPath: options.piBinaryPath,
        logger: LOGGER,
        getMcpToolApprovalPolicy: getDesktopMcpToolApprovalPolicy,
        reviewAutoPermissionAction: autoReview.reviewAutoPermissionAction,
        mcpProviders,
        resolvePiAgentHome: () => path.join(options.userDataDir, 'pi-agent-home'),
        // As the desktop (pi-host.ts): the user's own Pi context root (AGENTS.md and the like),
        // separate from Cindy's models and auth runtime home.
        resolvePiGlobalContextHome: (remoteHostId) => {
          if (remoteHostId) return '$HOME/.pi/agent';
          const override = process.env.PI_CODING_AGENT_DIR;
          return override
            ? path.resolve(override.replace(/^~(?=$|[\\/])/, () => os.homedir()))
            : path.join(os.homedir(), '.pi', 'agent');
        },
        // As the desktop (maker-host/index.ts buildPiAgentForDesktop), over the Host's selectable
        // catalog: the live model list, and the descriptors for a resumed retired model and the gateway block.
        resolvePiRuntimeModels: () => deriveAvailableModels(modelContext.getSelectableCatalog(), 'pi'),
        resolvePiRuntimeModelDescriptor: (providerId, modelId) =>
          resolvePiRuntimeModelDescriptor(modelContext.getSelectableCatalog(), providerId, modelId, {
            localOverrides: getLocalCatalogOverridesSnapshot(),
          }),
        resolvePiGatewayModelDescriptor: (providerId, modelId) => {
          // `cindy` 始终是 XD Gateway 路由；其成员、能力与显式 API 都由 Model Access
          // 决定，不能随当前订阅/BYOM provider 命中同 id 的另一条目录记录。
          return resolvePiRuntimeModelDescriptor(
            modelContext.getSelectableCatalog(),
            resolvePiGatewayDescriptorProviderId(providerId),
            modelId,
            { localOverrides: getLocalCatalogOverridesSnapshot() },
          );
        },
        // Pi's loopback requests carry a per-session token the proxy checks (pi-host.ts).
        ...(claudeProxy ? { registerPiProxySession: claudeProxy.registerPiProxySession } : {}),
        // As the desktop (pi-host.ts): 执行端动态学习；SSH 独立存储，避免把本机线路结论带到远端。
        resolvePiNativeCompatStorePath: remoteHostId => remoteHostId
          ? '$HOME/.xdt-server/v1/pi-agent-home/pi-native-compat-overrides.json'
          : path.join(options.userDataDir, 'pi-native-compat-overrides.json'),
        resolvePiNativeCompatOverride: (providerId, modelId, routeKey) =>
          piNativeCompatOverrides.readPiNativeCompatOverride(providerId, modelId, routeKey),
        // As the desktop (pi-host.ts): the shared resolver with the Host's ports (pi-native-providers.ts),
        // and the Cindy gateway block's API and compat from the same probe state.
        resolvePiNativeProviders: (ctx) => piNativeProviders.resolvePiNativeProviders(ctx),
        // As the desktop (pi-host.ts): durable Subagent runners, forked as Node child processes (pi-subagent-runner.ts).
        spawnPiSubagentRunner: (request) => spawnHostPiSubagentRunner(request),
        resolvePiManagedPackageResources: piPackages.deps.resolvePiManagedPackageResources,
        resolvePiNativePackagePaths: piPackages.deps.resolvePiNativePackagePaths,
        mutatePiManagedPackage: piPackages.deps.mutatePiManagedPackage,
        onPiManagedPackageMutationSettled: piPackages.deps.onPiManagedPackageMutationSettled,
        resolvePiGatewayModelApi: resolvePiCindyGatewayModelApi,
        resolvePiGatewayModelSpec: resolvePiCindyGatewayModelSpec,
        ...piModelResolvers,
        getDisabledSkillPaths: readDisabledSkillPaths,
        capabilityAdditions: availableModels('pi'),
        ...(options.getManagedSkills ? { getManagedSkills: options.getManagedSkills } : {}),
        turnChangeCapture: { beforeKnownFileWrite: captureKnownFileBefore, noteOpaqueWrite: noteOpaqueTurnChange },
        registerLocalAgentProcess: ({ pid, kind, role, sessionId }) =>
          registerAgentProcess(pid, kind, role, sessionId),
        ...(options.getGhostRosterPrompt ? { getGhostRosterPrompt: options.getGhostRosterPrompt } : {}),
        ...(options.makerMemory ? { makerMemory: options.makerMemory } : {}),
        // As the desktop (pi-host.ts): the cloud-file startup hint and the extension dialog strings.
        formatPiStartupCloudFileHint: (file) => t('logic.errors.piStartupCloudFile').replace('{{path}}', () => file),
        getPiExtensionUiStrings: () => ({
          confirm: t('settings.piPackages.extensionDialogConfirm'),
          cancel: t('settings.piPackages.cancel'),
          mutationFailed: t('settings.piPackages.operationFailed'),
          mutationFailure: {
            'source-unavailable': t('settings.piPackages.failure.sourceUnavailable'),
            'package-not-found': t('settings.piPackages.failure.packageNotFound'),
            'version-not-found': t('settings.piPackages.failure.versionNotFound'),
            'state-unavailable': t('settings.piPackages.failure.stateUnavailable'),
            'native-command-failed': t('settings.piPackages.failure.nativeCommandFailed'),
          },
          mutationSuccess: {
            install: t('settings.piPackages.success.install'),
            installEnabled: t('settings.piPackages.success.installEnabled'),
            update: t('settings.piPackages.success.update'),
            remove: t('settings.piPackages.success.remove'),
          },
        }),
        // Only for Pi models the vision bridge targets (layer C), as on the desktop.
        resolvePiVisionBridgeEnv: visionBridge.resolvePiVisionBridgeEnv,
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
    lifecycleHooks: {
      prepareStartOptions: startOptions.prepareStartOptions,
      onBeforeStart: startOptions.onBeforeStart,
      onStartFailed: startOptions.onStartFailed,
      onStartCleanupSucceeded: startOptions.onStartCleanupSucceeded,
      // Codex product prompt delivery, persisted on the task row as on the desktop.
      getCodexHistoryHasProductPrompt: sessionId => readCodexHistoryHasProductPrompt(sessionId),
      onCodexProductPromptDelivery: async ({ sessionId, historyHasProductPrompt }) => {
        await writeCodexHistoryHasProductPrompt(sessionId, historyHasProductPrompt);
      },
      onClose: async (id, closeOptions) => {
      await startOptions.onClose(id, closeOptions);
      options.claudeProxy?.closeSession(id);
      try { await options.codexRuntime?.closeSession(id); }
      finally { await options.onSessionClose?.(id); }
    } },
    logger: LOGGER,
    // Pi and Codex sessions read the tool-loop reviewer from Maker, as on the desktop.
    toolLoopReviewer: autoReview.toolLoopReviewer,
    ...(options.makerMemory ? { makerMemory: options.makerMemory } : {}),
    visionBridge: visionBridge.hook,
  });
  visionBridge.activate();
  // As the desktop (register.ts): when the loopback proxy sees Claude's native Auto classifier
  // fail, the task stays on Auto and its later approvals go to the Cindy reviewer above.
  // The latest graph owns the process-wide listener.
  const handleClassifierUnavailable = createClaudeAutoPermissionFallbackCoordinator({
    getSession: sessionId => maker.getSession(sessionId),
    getSessionMeta: sessionId => maker.getSessionMeta(sessionId),
    logger: LOGGER,
  });
  setClaudeAutoClassifierUnavailableListener(signal => { void handleClassifierUnavailable(signal); });
  const owner = activeOwnerScopeKey();
  const hostSessions = (key: string) => maker.listActiveSessions().filter(session => session.agentKind === 'codex'
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
  piPackages.attachMaker(maker);
  return { maker, agent, codex, pi, gatewayRestart, capabilitiesByAgent, instances: agents, autoReview, visionBridge, piPackages,
    refreshModels: () => refreshCatalogDerivedModels(maker, modelContext.getSelectableCatalog()),
    agents: Object.keys(agents) as AgentKind[] };
}
