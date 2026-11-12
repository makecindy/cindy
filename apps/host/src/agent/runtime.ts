import { getDesktopMcpToolApprovalPolicy } from '../../../desktop/src/main/maker-host/mcp-tool-approval-policy.js';
import { CODEX_PROVIDER_OAUTH_PLACEHOLDER_KEY } from '../../../desktop/src/main/maker-host/codex-gateway-config.js';
/** Node assembly of the shared Maker agents, provider configuration and MCP transports.
 * Native login, settings and platform integrations are assembled by the owning runtime. */

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
import { isAnthropicWireModel } from '../../../desktop/src/main/maker-host/claude-gateway-config.js';
import { createPiAuthAdapter } from '../../../desktop/src/main/maker-host/pi-auth.js';
import { CLAUDE_ACCOUNT_RETIRED_REASON, subscriptionAccountKind } from '../../../desktop/src/main/maker-host/subscription-account-kind.js';
import { getActiveCatalog } from '../../../desktop/src/main/maker-host/active-catalog.js';
import { deriveAvailableModels, refreshCatalogDerivedModels, resolveModelContextProviderId } from '../../../desktop/src/main/maker-host/catalog-to-descriptors.js';
import { DESKTOP_CAPABILITY_ROUTING_POLICY } from '../../../desktop/src/main/maker-host/capability-routing.js';
import { createCodexCapabilityRouting } from '../../../desktop/src/main/maker-host/codexCapabilityRouting.js';
import { createPluginRegistry } from '../../../desktop/src/main/maker-host/plugins/index.js';
import { createClaudeModelResolvers, createCodexModelResolvers, createPiModelResolvers } from '../../../desktop/src/main/maker-host/engineModelResolvers.js';
import { isNativeProviderAuthBound, bindNativeProviderAuth, unbindNativeProviderAuth } from '../../../desktop/src/main/maker-host/nativeProviderAuthBinding.js';

import { GatewayCodexRestartService } from '../../../desktop/src/main/maker-ipc/gatewayCodexRestart.js';
import { createDeferredRestartSettledWake } from '../../../desktop/src/main/maker-ipc/deferredRestartQueueWiring.js';
import { refreshCodexGatewayRuntime } from '../../../desktop/src/main/maker-host/codexGatewayRefresh.js';
import { isLocalSessionBusy } from '../../../desktop/src/main/maker-host/codex-credential-switch.js';
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
type ClaudeProxyAuthView = Pick<ReturnType<typeof createHostClaudeProxyRuntime>, 'isReady' | 'inboundSecret'>;
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
        const apiKey = gatewayKey();
        if (apiKey) env.ANTHROPIC_API_KEY = apiKey;
      } else if (opts?.credentialMode === 'provider-oauth') {
        env.ANTHROPIC_API_KEY = proxy.inboundSecret();
      } else if (opts?.credentialMode === 'oauth-bearer') {
        Object.assign(env, await networkEnv());
      } else {
        const apiKey = gatewayKey();
        if (apiKey) env.ANTHROPIC_API_KEY = apiKey;
        else if (hasClaudeNativeLogin()) {
          if (servesModel(opts?.model)) Object.assign(env, await networkEnv());
          else env.ANTHROPIC_API_KEY = proxy.inboundSecret();
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
    isOpenAiSubscriptionProviderId: id => id === 'openai' || getActiveCatalog().providers.some(provider => provider.id === id && provider.auth.native === 'codex'),
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
    claudeHooks,
    auth: createClaudeGatewayAuth(options.gateway, options.resolveProviderRoute, config.claudeNative, options.claudeProxy, config.grok),
    runtimeConfig: runtimeConfigs.buildClaudeRuntimeConfig(engineEndpoint),
    binaryPath: options.binaryPath,
    logger: LOGGER,
    getMcpToolApprovalPolicy: getDesktopMcpToolApprovalPolicy,
    reviewAutoPermissionAction: autoReview.reviewAutoPermissionAction,
    toolLoopReviewer: autoReview.toolLoopReviewer,
    // Skills the user disabled in Cindy, from the profile's activation preferences.
    getDisabledSkillPaths: readDisabledSkillPaths,
    ...(options.getGhostRosterPrompt ? { getGhostRosterPrompt: options.getGhostRosterPrompt } : {}),
    ...(options.getManagedSkills ? { getManagedSkills: options.getManagedSkills } : {}),
    capabilityRouting: DESKTOP_CAPABILITY_ROUTING_POLICY,
    capabilityAdditions: availableModels('claude-code'),
    // The turn change record the desktop keeps for Claude and Pi (turn-change-set/store.ts).
    turnChangeCapture: { beforeKnownFileWrite: captureKnownFileBefore, noteOpaqueWrite: noteOpaqueTurnChange },
    ...claudeModelResolvers,
    ...(mcpProviders.length > 0 ? { mcpProviders } : {}),
    ...(options.makerMemory ? { makerMemory: options.makerMemory } : {}),
  }) : null;
  const codex = options.codexBinaryPath
    ? new CodexAgent({
        auth: codexAuth,
        ...options.mcpRuntime.codexDeps,
        ...options.codexRuntime?.deps,
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
        getMcpToolApprovalPolicy: getDesktopMcpToolApprovalPolicy,
        reviewAutoPermissionAction: autoReview.reviewAutoPermissionAction,
        mcpProviders,
        ...(options.makerMemory ? { makerMemory: options.makerMemory } : {}),
      })
    : null;
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
        // Pi's loopback requests carry a per-session token the proxy checks (pi-host.ts).
        ...(claudeProxy ? { registerPiProxySession: claudeProxy.registerPiProxySession } : {}),
        resolvePiNativeProviders: () => options.providerConfig.piNativeProviders(),
        ...piModelResolvers,
        getDisabledSkillPaths: readDisabledSkillPaths,
        capabilityAdditions: availableModels('pi'),
        ...(options.getManagedSkills ? { getManagedSkills: options.getManagedSkills } : {}),
        turnChangeCapture: { beforeKnownFileWrite: captureKnownFileBefore, noteOpaqueWrite: noteOpaqueTurnChange },
        ...(options.getGhostRosterPrompt ? { getGhostRosterPrompt: options.getGhostRosterPrompt } : {}),
        ...(options.makerMemory ? { makerMemory: options.makerMemory } : {}),
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
      // Codex product prompt delivery, persisted on the task row as on the desktop.
      getCodexHistoryHasProductPrompt: sessionId => readCodexHistoryHasProductPrompt(sessionId),
      onCodexProductPromptDelivery: async ({ sessionId, historyHasProductPrompt }) => {
        await writeCodexHistoryHasProductPrompt(sessionId, historyHasProductPrompt);
      },
      onClose: async id => {
      startOptions.onClose(id);
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
  return { maker, agent, codex, pi, gatewayRestart, capabilitiesByAgent, instances: agents, autoReview, visionBridge,
    refreshModels: () => refreshCatalogDerivedModels(maker, modelContext.getSelectableCatalog()),
    agents: Object.keys(agents) as AgentKind[] };
}
