import { createEnvOutboundProxyResolver } from '@cindy/anthropic-compat-proxy';
import { isKnownEmbeddingModel } from '@cindy/embedding-client';
import { createOutboundFetch } from '@cindy/app-runtime/outboundFetch';
import { createServerApiClient, ServerApiError, type ServerApiClientHost } from '@cindy/app-runtime/serverApiClient';
import { createGeneratedMedia } from '@cindy/app-runtime/generatedMedia';
import { createCindyGatewayReadiness } from '@cindy/app-runtime/media/cindyGatewayReadiness';
import { createMediaDisplayVisibility } from '@cindy/app-runtime/media/mediaDisplayVisibility';
import { createMediaInvocationService, type MediaInvocationHost } from '@cindy/app-runtime/media/invocationService';
import { createMediaInvocationStore } from '@cindy/app-runtime/media/mediaInvocationStore';
import { createProviderMediaRuntime } from '@cindy/app-runtime/media/providerMediaRuntime';
import { createProviderMediaChannels } from '@cindy/app-runtime/media/providerMediaChannels';
import { createVideoProviderChannels } from '@cindy/app-runtime/media/videoProviderChannels';
import { createCindyMediaPreferences } from '@cindy/app-runtime/media/mediaPreferences';
import { createCindyProxyMediaHost } from '@cindy/app-runtime/media/proxyMediaHost';
import { createMediaModelCatalog, MediaGuideCompatibilityError, MediaModelCatalogError } from '@cindy/app-runtime/media/mediaModels';
import { createMediaDownload, type MediaDownloadContext } from '@cindy/app-runtime/media/mediaDownload';
import { createVideoTaskContent } from '@cindy/app-runtime/media/videoTaskContent';
import { createLegacyVideoCache } from '@cindy/app-runtime/media/legacyVideoCache';
import { withCindyGatewayKeyRejectionReport } from '@cindy/model-providers/model-access/gatewayKeyRejectionFetch';
import { isModelDisabled, isProviderDisabled } from '@cindy/model-providers';
import type { CindyMediaToolRequest } from 'cindy-tools';
import type { Logger } from '@cindy/maker-core';
import type { NodeDatabase } from '../database.js';
import type { TerminalSecrets } from '../contracts.js';
import type { TerminalModelConfig } from '../models/config.js';
import type { TerminalUsage } from './usage.js';
import type { TerminalTaskMedia } from './media.js';
import globalEndpoints from '../../../../config/endpoint.global.json';
import chinaEndpoints from '../../../../config/endpoint.json';

export interface TerminalMediaAccount {
  auth: MediaInvocationHost['authManager'];
  apiAuth: ServerApiClientHost['authManager'];
  endpoint(): string;
}

/** Platform composition only. Invocation, catalogs, credentials checks, storage,
 * billing and provider dispatch are the same services used by Desktop. */
export async function openTerminalMediaRuntime(options: {
  database: NodeDatabase;
  models: TerminalModelConfig;
  usage: TerminalUsage;
  media: TerminalTaskMedia;
  secrets: TerminalSecrets;
  profileDir: string;
  region: 'cn' | 'global';
  logger: Logger;
  assertCurrent(): void;
  locale(): string;
  fetch?: typeof fetch;
}) {
  const { models, database } = options;
  const persisted = await options.media.persisted();
  options.assertCurrent();
  const owner = database.getCurrentDbClientSnapshot();
  if (!owner) throw new Error('MEDIA_DATABASE_OWNER_UNAVAILABLE');
  const abort = new AbortController();
  let cloud: TerminalMediaAccount | undefined;
  const current = () => {
    abort.signal.throwIfAborted();
    options.assertCurrent();
    if (database.getCurrentDbClientSnapshot() !== owner) throw new Error('MEDIA_OWNER_CHANGED');
  };
  const pending = () => { try { current(); return false; } catch { return true; } };
  const activeOwnerScopeKey = () => { current(); return `${owner.userId}:${owner.clientEpoch}`; };
  const network = createOutboundFetch({ logger: options.logger, resolveOutboundProxy: createEnvOutboundProxyResolver() });
  const fetchImpl: typeof fetch = async (url, init) => {
    current();
    return (options.fetch ?? network.outboundFetch)(url, {
      ...init,
      signal: AbortSignal.any([abort.signal, ...(init?.signal ? [init.signal] : [])]),
    });
  };
  const auth: MediaInvocationHost['authManager'] = {
    getAuthState: () => {
      current();
      return cloud?.auth.getAuthState() ?? { mode: 'local', dataOwnerId: owner.userId, ownerGeneration: owner.clientEpoch };
    },
    getActiveAuthRealm: () => { current(); return cloud?.auth.getActiveAuthRealm() ?? options.region; },
  };
  const server = createServerApiClient({
    logger: options.logger, fetch: fetchImpl, getResolvedMainLocale: options.locale,
    // Terminal diagnostics deliberately contain no upstream body or request values.
    requestErrorMessage: error => error instanceof Error ? error.name : 'RequestError',
    authManager: {
      getAccessToken: () => { current(); return cloud?.apiAuth.getAccessToken() ?? null; },
      refresh: async () => { current(); const value = await cloud?.apiAuth.refresh(); current(); return value; },
      invalidateSession: reason => { current(); return cloud?.apiAuth.invalidateSession(reason); },
    },
  });
  const endpoint = () => cloud?.endpoint() ?? (options.region === 'cn' ? chinaEndpoints : globalEndpoints).modelAccessApiBaseUrl;
  let credentials: Awaited<ReturnType<TerminalModelConfig['utilityCredentials']>> | undefined;
  let legacyKeys = new Map<string, string | null>();
  let catalogRevision: number | undefined;
  const getActiveCatalog = () => {
    current();
    return credentials && credentials.revision === models.revision() && !models.isMutating()
      ? credentials.catalog : models.activeCatalog();
  };
  const readCustomProviderKey = (id: string, agent: import('@cindy/model-providers').AgentKind) => {
    current(); return credentials?.readKey(id, agent) ?? null;
  };
  const getProviderSecretStore = () => ({ get: (key: string) => {
    current();
    if (key === 'xd') return models.gatewayCredentials()?.apiKey ?? null;
    return credentials?.revision === models.revision() && !models.isMutating() ? legacyKeys.get(key) ?? null : null;
  } });
  const getAppCapabilities = () => ({ canUseCindyGateway: !pending() && Boolean(models.gatewayCredentials()) });
  const effectiveXdGatewayBaseUrl = () => { current(); return models.gatewayCredentials()?.endpoint ?? ''; };
  const readiness = createCindyGatewayReadiness({ getAppCapabilities, effectiveXdGatewayBaseUrl });
  const visibility = createMediaDisplayVisibility({ getActiveCatalog,
    getModelVisibilityOverride: (...args) => models.visibility.mirror.getModelVisibilityOverride(...args) });
  const providerRuntime = createProviderMediaRuntime();
  const catalog = createMediaModelCatalog({ ...visibility, ...providerRuntime, ...models.disables,
    ...server, ServerApiError, getClientEndpoint: endpoint });
  const generated = createGeneratedMedia(persisted);
  const proxy = createCindyProxyMediaHost({ ...generated, ...options.usage,
    logger: options.logger, fetch: fetchImpl, resolveXdtImage: persisted.imageCacheStore.resolveSafe,
    getProviderSecretStore, effectiveXdGatewayBaseUrl, getAppCapabilities,
    withCindyGatewayKeyRejectionReport: impl => withCindyGatewayKeyRejectionReport(impl, key => models.reportGatewayRejection(key)),
    isProviderModelRouteDisabled: (id, model) => {
      const overrides = models.disables.readModelDisableOverrides();
      return isProviderDisabled(overrides, id) || isModelDisabled(overrides, id, model);
    },
  });
  const grok = () => { current(); return models.grokAccount(); };
  const hasGrokOAuthLogin = () => grok()?.connected() === true;
  const getGrokAccessToken = async () => {
    const account = grok();
    if (!account) throw new Error('PROVIDER_LOGIN_REQUIRED');
    return (await account.credential()).accessToken;
  };
  const getGrokOAuthCredentialGeneration = () => grok()?.generation() ?? -1;
  const invalidateXaiBridgeAuth = async (failure: { status: number; body: string; failedAccessToken: string }) => {
    const account = grok();
    if (!account) throw new Error('PROVIDER_LOGIN_REQUIRED');
    return account.invalidate(failure);
  };
  const preferences = createCindyMediaPreferences({ ...catalog, ...visibility, ...readiness, ...models.disables,
    logger: options.logger, getActiveCatalog, isKnownEmbeddingModel,
    getXdGatewayModels: () => models.catalogRuntime.getXdGatewayModels(),
    getImageChannelRegistry: () => channels.getImageChannelRegistry(),
    getVideoProviderRegistry: () => videos.getVideoProviderRegistry(),
    isVideoCatalogProviderReady: id => videos.isVideoCatalogProviderReady(id),
    listLocalProviderVideoModels: display => channels.listLocalProviderVideoModels(display),
    listProviderMediaModels: providerRuntime.listProviderMediaModels,
  });
  const videos = createVideoProviderChannels({ ...proxy, ...readiness, ...preferences,
    getActiveCatalog, hasGrokOAuthLogin, getGrokAccessToken, getGrokOAuthCredentialGeneration,
    activeOwnerScopeKey, isAppSessionBoundaryPending: pending, outboundFetch: fetchImpl, invalidateXaiBridgeAuth });
  const channels = createProviderMediaChannels({ ...proxy, ...visibility, ...models.disables, ...videos,
    ...preferences, ...providerRuntime, getActiveCatalog, getAppCapabilities, getProviderSecretStore,
    readCustomProviderKey, activeOwnerScopeKey, isGhostBoundaryPending: pending,
    hasGrokOAuthLogin, getGrokAccessToken, getGrokOAuthCredentialGeneration,
    invalidateXaiBridgeAuth, outboundFetch: fetchImpl, logger: options.logger, codexLogger: options.logger,
    hasCodexOAuthLoginReadOnly: () => models.openAiAccount()?.connected() === true,
    getCodexImageAuthBinding: () => ({
      hasAuth: id => models.openAiAccount(id)?.connected() === true,
      getAuth: async id => {
        current(); const account = models.openAiAccount(id);
        if (!account) throw new Error('PROVIDER_LOGIN_REQUIRED');
        const value = await account.credential(); current(); return value;
      },
      onAuthFailure: (failure, id) => {
        current();
        return models.openAiAccount(id)?.invalidateFailure(failure);
      },
    }),
    readByokCredential: id => {
      const provider = getActiveCatalog().providers.find(item => item.id === id);
      for (const agent of provider?.agents ?? []) {
        const key = readCustomProviderKey(id, agent); if (key) return key;
      }
      return null;
    },
    readByokInferenceBase: id => {
      const provider = getActiveCatalog().providers.find(item => item.id === id);
      const endpoint = provider?.agents.map(agent => provider.routing[agent]?.upstream).find(Boolean);
      return typeof endpoint === 'string' ? endpoint.trim().replace(/\/+$/, '').replace(/\/v1$/, '') : null;
    },
  });
  const invocation = createMediaInvocationService({ ...persisted, ...providerRuntime, ...catalog,
    ...createMediaInvocationStore(() => { current(); return database.getDbClient(); }), ...options.usage,
    ...createMediaDownload((url, init, before, approval) => network.guardedOutboundFetch(url, { ...init, signal: AbortSignal.any([abort.signal, ...(init.signal ? [init.signal] : [])]) }, () => { current(); return before(); }, approval)), ...createVideoTaskContent(fetchImpl),
    logger: options.logger, getAppCapabilities, authManager: auth, getProviderSecretStore,
    videoCacheStore: createLegacyVideoCache(() => options.profileDir),
    ServerApiError, MediaGuideCompatibilityError, MediaModelCatalogError,
    getDbClient: () => { current(); return database.getDbClient(); },
    getCurrentDbClientUserId: () => { current(); return database.getCurrentDbClientUserId(); },
    effectiveXdGatewayBaseUrl, reportCindyGatewayKeyRejected: key => models.reportGatewayRejection(key),
    outboundFetch: fetchImpl,
  });
  const refresh = async () => {
    current();
    const snapshot = await models.utilityCredentials({ allProviders: true });
    const keys = await Promise.all(['gemini', 'openai-images'].map(async key => [key, await options.secrets.get(key)] as const));
    await models.waitForModelVisibility();
    current();
    if (snapshot.revision !== models.revision() || models.isMutating()) throw new Error('MODEL_CONFIGURATION_CHANGED');
    if (catalogRevision !== snapshot.revision) catalog.resetExecutableMediaModelCache();
    catalogRevision = snapshot.revision;
    credentials = snapshot;
    legacyKeys = new Map(keys);
  };
  const operations = new Set<Promise<unknown>>();
  return {
    catalog, preferences, channels,
    bindAccount(account: TerminalMediaAccount) { current(); cloud = account; catalog.resetExecutableMediaModelCache(); },
    callCindyMedia(request: CindyMediaToolRequest, context?: MediaDownloadContext, sessionId?: string) {
      const work = (async () => {
        await refresh(); current();
        const result = await invocation.callCindyMedia(request, context, sessionId);
        current(); return result;
      })();
      operations.add(work);
      void work.finally(() => operations.delete(work)).catch(() => {});
      return work;
    },
    async close() {
      abort.abort(new Error('MEDIA_OWNER_CHANGED'));
      await Promise.allSettled([...operations]);
      legacyKeys.clear(); credentials = undefined;
      network.resetOutboundFetchStateForTest();
    },
  };
}
export type TerminalMediaRuntime = Awaited<ReturnType<typeof openTerminalMediaRuntime>>;
