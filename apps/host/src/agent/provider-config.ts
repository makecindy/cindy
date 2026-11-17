import { registerProviderHandlers, type ProviderPlatformPorts } from '../../../desktop/src/main/maker-ipc/providerHandlers.js';
import type { IpcHandler } from '../../../desktop/src/main/maker-ipc/ipcHandlerRegistry.js';
import { MAKER_INVOKE, MAKER_PUSH } from '../../../desktop/src/main/maker-ipc/channels.js';
import { fetchProviderModels } from '../../../desktop/src/main/maker-host/provider-model-fetch.js';
import { beginProviderRouteMutation, setCustomProviderKeyReader, setCustomProviderHeaderReader, setOAuthTokenReader, setProviderOAuthTokenReader, setProviderViewsReader } from '../../../desktop/src/main/maker-host/provider-route.js';
import { createXaiProviderTokenReader } from '../../../desktop/src/main/maker-host/xaiProviderToken.js';
import { isXaiSubscriptionProviderId } from '../../../desktop/src/main/maker-host/subscription-account-kind.js';
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { createCustomProviderHeaderService } from '../../../desktop/src/main/maker-host/customProviderHeaderService.js';
import { listCustomProviders, updateCustomProvider } from '../../../desktop/src/main/maker-host/custom-provider-store.js';
import { UNRECOVERABLE_PROVIDER_CREDENTIAL, parseCustomProviderHeaders, type UnrecoverableProviderCredential } from '../../../desktop/src/main/secrets/providerCredentialState.js';
import { customProviderHeaderStorageKey, customProviderSecretStorageKey, providerOAuthStorageKey, providerSecretStorageKey, isBuiltinApiKeyProviderId, REMOTE_MCP_BRIDGE_TOKEN_STORAGE_KEY } from '../../../desktop/src/shared/providerSecrets.js';
import { getCurrentDbClientSnapshot } from '../../../desktop/src/main/localDb/client/current.js';
import { dataOwnerStorageKey } from '../../../desktop/src/main/dataOwnerPath.js';
import { activeOwnerScopeKey, getActiveAppSession, isAppSessionBoundaryPending } from '../../../desktop/src/main/appSessionState.js';
import { createProviderService } from '../../../desktop/src/main/maker-host/provider-service.js';
import { hasCustomProviderCredential } from '../../../desktop/src/main/maker-host/provider-connection-state.js';
import { withoutProviderHeaderCredentials } from '../../../desktop/src/main/maker-host/provider-public-view.js';
import { loadCatalogWithSource, storedCustomProviderId, isOrganizationManagedProvider, type CatalogSourceConfig } from '@cindy/model-providers';
import { createGenericOAuthService, type GenericOAuthStorage } from '../../../desktop/src/main/maker-host/generic-oauth.js';
import { createGrokOAuthService } from '../../../desktop/src/main/maker-host/grok-oauth-login.js';
import { holdGrokLoginWrites } from './xai-held-login.js';
import { holdCredentialFetch, holdRecipeSecrets } from './held-credentials.js';
import { hostOutbound, resolveHostOutboundProxy } from '../outbound.mjs';
import { createClaudeNativeCli } from '../../../desktop/src/main/maker-host/claude-native-cli.js';
import { readClaudeCliLoginStatusBySpawn } from '@cindy/maker-core/claude-cli-login-status';
import { setActiveCatalog, setCustomProviders, setCustomProviderConfigs, setSubscriptionPoolProviders, setLocalCatalogOverrides, getActiveCatalog } from '../../../desktop/src/main/maker-host/active-catalog.js';
import { publishSubscriptionPoolProviders } from '../../../desktop/src/main/maker-host/subscriptionPoolCatalog.js';
import { readCreatedSubscriptionProvidersIfReadable } from '../../../desktop/src/main/subscription-accounts/placement.js';
import { createLogger } from '../../../desktop/src/main/logger.js';
import { createCatalogCache } from '../../../desktop/src/main/maker-host/catalogCache.js';
import { readModelCatalogOverrides } from '../../../desktop/src/main/maker-host/model-catalog-override-store.js';
import { readModelDisableOverrides } from '../../../desktop/src/main/maker-host/model-disable-store.js';
import { hasClaudeNativeLogin } from '../../../desktop/src/main/maker-host/claude-native-auth.js';
import { isNativeProviderAuthBound } from '../../../desktop/src/main/maker-host/nativeProviderAuthBinding.js';
import { readCodexLocalAuthState } from '../../../desktop/src/main/maker-host/codex-local-auth-state.js';
import type { ProviderSecretStore } from '../../../desktop/src/main/secrets/providerSecretStore.js';
import { createCodexAccountAuth } from '../../../desktop/src/main/maker-host/codex-account-auth.js';

/**
 * The profile's Codex account service (createCodexAccountAuth), with the provider config's
 * scope: its owner, its check and whether it is closed. Also used by the parity tests, so they
 * run the Host's own login and logout.
 */
export function createHostCodexAccounts(
  options: { profileDir: string; getCodexBinary?(): string | null; publish?(channel: string, payload: unknown): void },
  scope: { owner: string; check(): void; closed(): boolean },
) {
  return createCodexAccountAuth({
    getUserDataDir: () => { scope.check(); return options.profileDir; },
    getCodexBinary: () => { scope.check(); return options.getCodexBinary?.() ?? null; },
    isProvider: id => { scope.check(); return id === 'openai' || getActiveCatalog().providers.some(provider =>
      provider.id === id && provider.source === 'user' && provider.auth.native === 'codex'); },
    accountHome: id => { scope.check(); return id === 'openai' ? path.join(options.profileDir, 'codex-home') : undefined; },
    broadcastCodexAccountAuthReady: providerId => {
      if (!scope.closed() && activeOwnerScopeKey() === scope.owner && !isAppSessionBoundaryPending()) options.publish?.('usage:codex-account-auth-ready', { providerId });
    },
    broadcastCodexAccountAuthStarted: providerId => {
      scope.check(); options.publish?.('usage:codex-account-auth-started', { providerId });
    },
  });
}

/** Owner-bound configuration and the existing encrypted header migration. */
export function createHostProviderConfig(options: { profileDir: string; ownerId: string; openExternal(url: string): Promise<void>;
  withAvailabilityPolicyMutation?: ProviderPlatformPorts['withAvailabilityPolicyMutation'];
  gatewayConnected?(): boolean; getCodexBinary?(): string | null; getClaudeBinary?(): string | null; publish?(channel: string, payload: unknown): void;
  /** Coexistence plan A: whether a Cindy desktop app running on its own uses this profile (xai-held-login.ts). */
  isProfileHeld?(): boolean; credentials: {
  decrypt(value: string): string; read(key: string): string | null;
  write(key: string, value: string): void; remove(key: string): void;
} }) {
  const owner = activeOwnerScopeKey();
  const database = getCurrentDbClientSnapshot();
  const prefix = `owner_${dataOwnerStorageKey(options.ownerId)}_`;
  let closed = false;
  const check = () => {
    if (closed || !database || database !== getCurrentDbClientSnapshot() || activeOwnerScopeKey() !== owner || isAppSessionBoundaryPending())
      throw new Error('PROVIDER_OWNER_CHANGED');
  };
  const key = (logical: string) => { check(); return prefix + logical; };
  const readCredentialForMutation = (logical: string): string | null | UnrecoverableProviderCredential => {
    let encrypted: string;
    try { encrypted = fs.readFileSync(path.join(options.profileDir, 'safe-storage', `${key(logical)}.enc`), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new Error('Provider credential is unreadable'); }
    try { return options.credentials.decrypt(encrypted); }
    catch { return UNRECOVERABLE_PROVIDER_CREDENTIAL; }
  };
  const readStrict = (logical: string): string | null => {
    const value = readCredentialForMutation(logical);
    if (typeof value === 'symbol') throw new Error('Provider credential cannot be decrypted');
    return value;
  };
  const oauthStorage: GenericOAuthStorage = {
    read: id => { check(); try { return readStrict(providerOAuthStorageKey(id)); } catch { return null; } },
    readStrict: id => readStrict(providerOAuthStorageKey(id)),
    write: (id, value) => { options.credentials.write(key(providerOAuthStorageKey(id)), value); return true; },
    remove: id => { options.credentials.remove(key(providerOAuthStorageKey(id))); return true; },
  };
  const builtinStore: Pick<ProviderSecretStore, 'get' | 'set' | 'remove'> = {
    get: id => { check(); return options.credentials.read(key(providerSecretStorageKey(id))); },
    set: (id, value) => { options.credentials.write(key(providerSecretStorageKey(id)), value); return true; },
    remove: id => { options.credentials.remove(key(providerSecretStorageKey(id))); return { success: true }; },
  };
  // Custom provider OAuth renews through this fetch; while a desktop uses the profile it sends
  // nothing, so no refresh token is spent and nothing is written back (held-credentials.ts).
  const oauth = createGenericOAuthService({ fetchImpl: holdCredentialFetch(hostOutbound.outboundFetch,
    () => options.isProfileHeld?.() === true, 'this provider sign-in is not renewed') });
  oauth.configureGenericOAuth({ storage: oauthStorage, openExternal: options.openExternal });
  // Every Host consumer of the xAI login reads it through this one service; while a desktop uses
  // the profile it neither renews nor signs out (xai-held-login.ts).
  const grok = holdGrokLoginWrites(createGrokOAuthService({ outboundFetch: hostOutbound.outboundFetch, openExternal: options.openExternal,
    genericOAuthSecretIo: oauthStorage, getProviderSecretStore: () => builtinStore }), {
    isProfileHeld: () => options.isProfileHeld?.() === true,
    readStoredLogin: id => (id === 'xai' ? builtinStore.get('xai') : oauthStorage.read(id)),
  });
  const claudeNative = createClaudeNativeCli({
    binaryPath: () => { check(); return options.getClaudeBinary?.() ?? null; },
    resolveOutboundProxy: resolveHostOutboundProxy,
    readStatus: readClaudeCliLoginStatusBySpawn,
  });
  const codexAccounts = createHostCodexAccounts(options, { owner, check, closed: () => closed });
  const headerPorts: Parameters<typeof createCustomProviderHeaderService>[0] = {
    getCurrentDbClientUserId: () => { check(); return owner; },
    listCustomProviders: async () => { check(); const rows = await listCustomProviders(); check(); return rows; },
    updateCustomProvider: async (...args) => { check(); const row = await updateCustomProvider(...args); check(); return row; },
    readCustomProviderHeadersForMutation(id, agent) {
      const value = readCredentialForMutation(customProviderHeaderStorageKey(id, agent));
      if (typeof value !== 'string') return value;
      try { return parseCustomProviderHeaders(value); }
      catch { return UNRECOVERABLE_PROVIDER_CREDENTIAL; }
    },
    storeCustomProviderHeaders(id, agent, value) {
      options.credentials.write(key(customProviderHeaderStorageKey(id, agent)), JSON.stringify(value)); return true;
    },
    removeCustomProviderHeaders(id, agent) {
      options.credentials.remove(key(customProviderHeaderStorageKey(id, agent))); return { success: true };
    },
  };
  const headers = createCustomProviderHeaderService(headerPorts);
  const readKey = (id: string, agent: string) => options.credentials.read(key(customProviderSecretStorageKey(storedCustomProviderId(id), agent)));
  const log = createLogger('host-provider-config');
  let listGeneration = 0;
  const list = async () => {
    check();
    const generation = ++listGeneration;
    try {
      const configs = await headers.listCustomProvidersWithSecureHeaders(); check();
      if (generation !== listGeneration) return configs;
      setCustomProviderConfigs(configs);
      publishSubscriptionPoolProviders({ readCreatedSubscriptionProvidersIfReadable, setSubscriptionPoolProviders, log });
      setLocalCatalogOverrides(readModelCatalogOverrides());
      return configs;
    } catch (err) {
      check();
      if (generation === listGeneration) {
        // Desktop's failed refresh clears both ordinary and subscription providers.
        setCustomProviders([]);
        log.warn('failed to load custom providers; cleared current owner catalog snapshot', { err: String(err) });
      }
      throw err;
    }
  };
  const cache = createCatalogCache(() => { check(); return options.profileDir; });
  const cancelLogins = async () => {
    claudeNative.cancelClaudeCliLogin();
    oauth.stopGenericOAuth();
    grok.resetGrokOAuthMemoryCache();
    await codexAccounts.close();
  };
  const handlers = new Map<string, IpcHandler>();
  const unsupported = (): never => { throw new Error('[UNSUPPORTED_CAPABILITY] Host provider operation is not exposed'); };
  registerProviderHandlers({ handle: (channel, handler) => {
    if (channel === MAKER_INVOKE.PROVIDER_CUSTOM_CREATE || channel === MAKER_INVOKE.PROVIDER_MODELS_FETCH)
      handlers.set(channel, handler);
  } }, {
    isOrganizationManagedProviderId: id => getActiveCatalog().providers.some(provider =>
      provider.id === id && isOrganizationManagedProvider(provider)),
    refreshCatalog: async () => { await list(); },
    beginRouteMutation: id => beginProviderRouteMutation(id),
    broadcastChanged: () => { check(); options.publish?.(MAKER_PUSH.PROVIDER_CHANGED, undefined); },
    listPresets: () => getActiveCatalog().presets ?? [],
    getModelCatalog: getActiveCatalog,
    fetchModels: spec => fetchProviderModels(spec, hostOutbound.outboundFetch),
    assertTrustedSender: caller => { check(); if (typeof caller !== 'string' || !caller) throw new Error('Authenticated provider controller is required'); },
    currentOwnerSession: () => { check(); return getActiveAppSession(); },
    readCustomProviderKeyForMutation: (id, agent) => readCredentialForMutation(customProviderSecretStorageKey(id, agent)),
    storeCustomProviderKey: (id, agent, value) => {
      options.credentials.write(key(customProviderSecretStorageKey(id, agent)), value); return true;
    },
    removeCustomProviderKey: (id, agent) => {
      options.credentials.remove(key(customProviderSecretStorageKey(id, agent))); return { success: true };
    },
    readCustomProviderHeadersForMutation: headerPorts.readCustomProviderHeadersForMutation,
    storeCustomProviderHeaders: headerPorts.storeCustomProviderHeaders,
    removeCustomProviderHeaders: headerPorts.removeCustomProviderHeaders,
    readSavedProviderRoute: (id, agent) => {
      check();
      const provider = getActiveCatalog().providers.find(provider => provider.id === id && provider.source === 'user');
      const route = provider?.routing[agent];
      return route && !route.disabled ? { baseUrl: route.upstream, modelsUrl: route.modelsUrl ?? null } : null;
    },
    withAvailabilityPolicyMutation: (id, work) => {
      if (!options.withAvailabilityPolicyMutation) return unsupported();
      return options.withAvailabilityPolicyMutation(id, work);
    },
    writeProviderGroup: unsupported, pruneProviderGroupBindings: unsupported,
    notifyManagedOllamaRemoved: unsupported, stopManagedLlamaCppService: unsupported,
    listProviders: unsupported, getModelVisibilityOverrides: unsupported,
    listProviderIds: unsupported, setProviderOrder: unsupported, getProviderOrder: unsupported,
    testConnection: unsupported, accountUsage: unsupported, refreshBuiltinModels: unsupported,
    requestModelsAutoRefresh: unsupported, rediscoverModels: unsupported,
    oauthLogin: unsupported, oauthLogout: unsupported, oauthCancel: unsupported, removeOAuthCredentials: unsupported,
    scanLocalCli: unsupported, setModelsDisabled: unsupported, setProviderDisabled: unsupported,
    getLedgerCurrency: unsupported, readModelPriceOverride: unsupported, writeModelPriceOverride: unsupported,
    clearModelPriceOverride: unsupported, broadcastPricingChanged: unsupported,
  });
  const api = {
    async invoke(channel: string, args: unknown[], caller: string) {
      check();
      if (!caller) throw new Error('Authenticated provider controller is required');
      const handler = handlers.get(channel);
      if (!handler) throw new Error('[UNSUPPORTED_CAPABILITY] Unknown Host provider operation');
      const result = await handler(caller, ...args); check(); return result;
    },
    list, readKey, oauth, grok, builtinStore,
    // Browser recipes whose renewal rotates the refresh token are not read while held (held-credentials.ts).
    recipeSecretIo: holdRecipeSecrets(oauthStorage, () => options.isProfileHeld?.() === true), codexAccounts, claudeNative, cancelLogins,
    async close() {
      closed = true;
      await cancelLogins();
    },
    remoteBridgeToken() {
      const physical = key(REMOTE_MCP_BRIDGE_TOKEN_STORAGE_KEY);
      const existing = options.credentials.read(physical);
      if (existing) return existing;
      const token = randomBytes(32).toString('hex');
      options.credentials.write(physical, token);
      return token;
    },
    async loadCatalog(source: CatalogSourceConfig) {
      check();
      const result = await loadCatalogWithSource(source, {
        readCache: cache.readCatalogLkg, writeCache: cache.writeCatalogLkg,
        readFile: async file => { try { return await fs.promises.readFile(file, 'utf8'); }
          catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; } },
        fetchText: async (url, timeoutMs) => {
          check();
          const response = await hostOutbound.outboundFetch(url, { headers: { 'cache-control': 'no-cache' },
            redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
          if (!response.ok) throw new Error(`Catalog HTTP ${response.status}`);
          const text = await response.text(); check(); return text;
        },
      });
      check();
      setActiveCatalog(result.catalog, { authorityCatalog: result.authorityCatalog,
        capabilityEvidence: result.capabilityEvidence, unverifiedXdMediaKinds: result.unverifiedXdMediaKinds });
      await list();
    },
    async publicViews(gatewayConnected = false) {
      await list();
      const service = createProviderService({
        getCatalog: getActiveCatalog,
        getModelAccess: readModelDisableOverrides,
        connection: { xd: () => gatewayConnected, anthropic: hasClaudeNativeLogin,
          openai: async () => {
            const state = await readCodexLocalAuthState(path.join(options.profileDir, 'codex-home'));
            return isNativeProviderAuthBound('openai') && state.authenticated && state.authSource === 'oauth';
          },
          xai: () => grok.hasGrokOAuthLogin() },
        customApiKeyConnected: provider => hasCustomProviderCredential(provider, readKey),
        genericOAuthConnected: id => oauth.hasGenericOAuthLogin(storedCustomProviderId(id)),
        codexAccountConnected: id => codexAccounts.codexAccountState(id).authenticated,
        subscriptionAccountConnected: id => getActiveCatalog().providers.find(p => p.id === id)?.auth.native === 'xai'
          && grok.hasGrokOAuthLogin(id),
        builtinApiKeyConnected: id => isBuiltinApiKeyProviderId(id) && Boolean(builtinStore.get(id)?.trim()),
      });
      const views = await service.listProviders({ allowSideEffects: false }); check();
      return views.map(withoutProviderHeaderCredentials);
    },
  };
  setCustomProviderKeyReader(readKey);
  setCustomProviderHeaderReader((id, agent) => {
    const value = readStrict(customProviderHeaderStorageKey(storedCustomProviderId(id), agent));
    return value === null ? null : parseCustomProviderHeaders(value);
  });
  setOAuthTokenReader(id => {
    check();
    const provider = getActiveCatalog().providers.find(p => p.id === id);
    return oauth.readGenericOAuthAccessToken(provider?.source === 'user' ? storedCustomProviderId(id) : id, provider?.auth.oauth);
  });
  const readXaiToken = createXaiProviderTokenReader(grok);
  setProviderOAuthTokenReader(async (id, _agent, request) => {
    check();
    if (!isXaiSubscriptionProviderId(id)) return null;
    const value = await readXaiToken(request, id); check(); return value;
  });
  setProviderViewsReader(() => api.publicViews(options.gatewayConnected?.() ?? false));
  return api;
}
