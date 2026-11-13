import { setCustomProviderKeyReader, setCustomProviderHeaderReader, setOAuthTokenReader, setProviderOAuthTokenReader, setProviderViewsReader } from '../../../desktop/src/main/maker-host/provider-route.js';
import { createXaiProviderTokenReader } from '../../../desktop/src/main/maker-host/xaiProviderToken.js';
import { isXaiSubscriptionProviderId } from '../../../desktop/src/main/maker-host/subscription-account-kind.js';
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { createCustomProviderHeaderService } from '../../../desktop/src/main/maker-host/customProviderHeaderService.js';
import { listCustomProviders, updateCustomProvider } from '../../../desktop/src/main/maker-host/custom-provider-store.js';
import { UNRECOVERABLE_PROVIDER_CREDENTIAL, parseCustomProviderHeaders } from '../../../desktop/src/main/secrets/providerCredentialState.js';
import { customProviderHeaderStorageKey, customProviderSecretStorageKey, providerOAuthStorageKey, providerSecretStorageKey, isBuiltinApiKeyProviderId, REMOTE_MCP_BRIDGE_TOKEN_STORAGE_KEY } from '../../../desktop/src/shared/providerSecrets.js';
import { getCurrentDbClientSnapshot } from '../../../desktop/src/main/localDb/client/current.js';
import { dataOwnerStorageKey } from '../../../desktop/src/main/dataOwnerPath.js';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../../../desktop/src/main/appSessionState.js';
import { buildPiNativeProvidersFromConfigs } from '../../../desktop/src/main/maker-host/pi-native-catalog.js';
import { createProviderService } from '../../../desktop/src/main/maker-host/provider-service.js';
import { hasCustomProviderCredential } from '../../../desktop/src/main/maker-host/provider-connection-state.js';
import { withoutProviderHeaderCredentials } from '../../../desktop/src/main/maker-host/provider-public-view.js';
import { loadCatalogWithSource, storedCustomProviderId, type CatalogSourceConfig } from '@cindy/model-providers';
import { createGenericOAuthService, type GenericOAuthStorage } from '../../../desktop/src/main/maker-host/generic-oauth.js';
import { createGrokOAuthService } from '../../../desktop/src/main/maker-host/grok-oauth-login.js';
import { hostOutbound, resolveHostOutboundProxy } from '../outbound.mjs';
import { createClaudeNativeCli } from '../../../desktop/src/main/maker-host/claude-native-cli.js';
import { readClaudeCliLoginStatusBySpawn } from '@cindy/maker-core/claude-cli-login-status';
import { setActiveCatalog, setCustomProviderConfigs, setLocalCatalogOverrides, getActiveCatalog } from '../../../desktop/src/main/maker-host/active-catalog.js';
import { createCatalogCache } from '../../../desktop/src/main/maker-host/catalogCache.js';
import { readModelCatalogOverrides } from '../../../desktop/src/main/maker-host/model-catalog-override-store.js';
import { readModelDisableOverrides } from '../../../desktop/src/main/maker-host/model-disable-store.js';
import { hasClaudeNativeLogin } from '../../../desktop/src/main/maker-host/claude-native-auth.js';
import { isNativeProviderAuthBound } from '../../../desktop/src/main/maker-host/nativeProviderAuthBinding.js';
import { readCodexLocalAuthState } from '../../../desktop/src/main/maker-host/codex-local-auth-state.js';
import type { ProviderSecretStore } from '../../../desktop/src/main/secrets/providerSecretStore.js';
import { createCodexAccountAuth } from '../../../desktop/src/main/maker-host/codex-account-auth.js';

/** Owner-bound configuration and the existing encrypted header migration. */
export function createHostProviderConfig(options: { profileDir: string; ownerId: string; openExternal(url: string): Promise<void>;
  gatewayConnected?(): boolean; getCodexBinary?(): string | null; getClaudeBinary?(): string | null; publish?(channel: string, payload: unknown): void; credentials: {
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
  const readStrict = (logical: string): string | null => {
    let encrypted: string;
    try { encrypted = fs.readFileSync(path.join(options.profileDir, 'safe-storage', `${key(logical)}.enc`), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new Error('Provider credential is unreadable'); }
    try { return options.credentials.decrypt(encrypted); }
    catch { throw new Error('Provider credential cannot be decrypted'); }
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
  const oauth = createGenericOAuthService({ fetchImpl: hostOutbound.outboundFetch });
  oauth.configureGenericOAuth({ storage: oauthStorage, openExternal: options.openExternal });
  const grok = createGrokOAuthService({ outboundFetch: hostOutbound.outboundFetch, openExternal: options.openExternal,
    genericOAuthSecretIo: oauthStorage, getProviderSecretStore: () => builtinStore });
  const claudeNative = createClaudeNativeCli({
    binaryPath: () => { check(); return options.getClaudeBinary?.() ?? null; },
    resolveOutboundProxy: resolveHostOutboundProxy,
    readStatus: readClaudeCliLoginStatusBySpawn,
  });
  const codexAccounts = createCodexAccountAuth({
    getUserDataDir: () => { check(); return options.profileDir; },
    getCodexBinary: () => { check(); return options.getCodexBinary?.() ?? null; },
    isProvider: id => { check(); return id === 'openai' || getActiveCatalog().providers.some(provider =>
      provider.id === id && provider.source === 'user' && provider.auth.native === 'codex'); },
    accountHome: id => { check(); return id === 'openai' ? path.join(options.profileDir, 'codex-home') : undefined; },
    broadcastCodexAccountAuthReady: providerId => {
      if (!closed && activeOwnerScopeKey() === owner && !isAppSessionBoundaryPending()) options.publish?.('usage:codex-account-auth-ready', { providerId });
    },
    broadcastCodexAccountAuthStarted: providerId => {
      check(); options.publish?.('usage:codex-account-auth-started', { providerId });
    },
  });
  const headers = createCustomProviderHeaderService({
    getCurrentDbClientUserId: () => { check(); return owner; },
    listCustomProviders: async () => { check(); const rows = await listCustomProviders(); check(); return rows; },
    updateCustomProvider: async (...args) => { check(); const row = await updateCustomProvider(...args); check(); return row; },
    readCustomProviderHeadersForMutation(id, agent) {
      const file = path.join(options.profileDir, 'safe-storage', `${key(customProviderHeaderStorageKey(id, agent))}.enc`);
      let encrypted: string;
      try { encrypted = fs.readFileSync(file, 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new Error('Provider headers are unreadable'); }
      try { return parseCustomProviderHeaders(options.credentials.decrypt(encrypted)); }
      catch { return UNRECOVERABLE_PROVIDER_CREDENTIAL; }
    },
    storeCustomProviderHeaders(id, agent, value) {
      options.credentials.write(key(customProviderHeaderStorageKey(id, agent)), JSON.stringify(value)); return true;
    },
    removeCustomProviderHeaders(id, agent) {
      options.credentials.remove(key(customProviderHeaderStorageKey(id, agent))); return { success: true };
    },
  });
  const readKey = (id: string, agent: string) => options.credentials.read(key(customProviderSecretStorageKey(storedCustomProviderId(id), agent)));
  const list = async () => {
    const configs = await headers.listCustomProvidersWithSecureHeaders(); check();
    setCustomProviderConfigs(configs);
    setLocalCatalogOverrides(readModelCatalogOverrides());
    return configs;
  };
  const cache = createCatalogCache(() => { check(); return options.profileDir; });
  const cancelLogins = async () => {
    claudeNative.cancelClaudeCliLogin();
    oauth.stopGenericOAuth();
    grok.resetGrokOAuthMemoryCache();
    await codexAccounts.close();
  };
  const api = {
    list, readKey, oauth, grok, builtinStore, recipeSecretIo: oauthStorage, codexAccounts, claudeNative, cancelLogins,
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
    async piNativeProviders() {
      const configs = await list();
      // Protocol, endpoint, header isolation and model limits use the exact same
      // projection as Desktop. Unknown capacities are never replaced with guesses.
      return buildPiNativeProvidersFromConfigs(configs, readKey);
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
