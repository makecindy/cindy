import { modelProviderCandidates } from '@cindy/app-runtime/modelProviderCandidates';
import {openTerminalModelDefaults,type TerminalModelDefaults} from './defaults.js';
import { createProviderService, type ConnectionReadOptions, type ProviderListOptions } from '@cindy/app-runtime/providerService';
import { openTerminalModelVisibility } from './visibility.js';
import { createProviderOrderStore } from '@cindy/app-runtime/providerOrderStore';
import { projectProviderList } from '@cindy/app-runtime/providerViewProjection';
import { hasCustomProviderCredential } from '@cindy/app-runtime/providerConnectionState';
import { createModelDisableStore } from '@cindy/app-runtime/modelDisableStore';
import { existsSync } from 'node:fs';
import { createCustomProviderStore, validateCustomProviderConfig } from '@cindy/app-runtime/customProviderStore';
import type { NodeDatabase } from '../database.js';
import { createProviderConfigMutations } from '@cindy/app-runtime/providerConfigMutations';
import { createProviderRouteMutations } from '@cindy/app-runtime/providerRouteMutations';
import { createModelRouteVerdict } from '@cindy/app-runtime/modelRouteVerdict';
import { providerRoutingForModel } from '@cindy/model-providers';
import { createModelContextLimitStore } from '@cindy/app-runtime/modelContextLimitStore';
import { createConfiguredContextWindowResolver } from '@cindy/app-runtime/modelContextSettings';
import { resolveModelContextProviderId, resolveModelDefaultContextWindow } from '@cindy/model-providers/modelContext';
import type { Logger } from '@cindy/maker-core';
import { checkModelRoute } from '@cindy/model-providers/model-route-guard';
import { isRegistryTombstoneForConsumer, MODEL_PLANE_POLICIES } from '@cindy/model-providers/model-plane/modelPlanePolicy';


import path from 'node:path';
import { BUNDLED_CATALOG, buildRegistry, buildUserProvider, resolveRoute, type AgentKind, type Catalog, type CustomProviderConfig, type Effort, type ProviderView, type ResolvedRoute, type CatalogModel, type ModelDisableOverrides, storedCustomProviderId } from '@cindy/model-providers';
import type { TerminalSecrets } from '../contracts.js';
import { atomicPrivateWrite, privateDirectory, readPrivateFile } from '../platform.js';
import { createActiveCatalog } from '@cindy/model-providers/model-plane/activeCatalog';
import type { TerminalSubscriptions } from './subscriptions.js';
import type { TerminalGrokLogin } from './grok-login.js';
import type { TerminalClaudeLogin } from './claude-login.js';
import type { TerminalNativeAccounts } from './native-accounts.js';


export interface ModelOAuthConnection {
  connected(id: string): boolean;
  cancelProvider?(id: string): void;
  credential(id: string): Promise<string | null>;
  disconnect(id: string): void;
  removeReversibly(id: string): () => void;
  refresh(id: string): Promise<void>;
}

export const ENGINES = ['claude-code', 'codex', 'pi'] as const;
export type ModelSelection = { agentKind: AgentKind; providerId: string; model: string; effort?: Effort };
type ModelState = { version: 1; providers: CustomProviderConfig[]; defaultSelection?: ModelSelection; disabled?: ModelDisableOverrides };
export type NativeStatus = (agent: AgentKind) => Promise<{ authenticated: boolean }>;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_MODEL_CONFIGURATION');
  return value as Record<string, unknown>;
}
export function parseSelection(value: unknown): ModelSelection {
  const item = object(value);
  if (!ENGINES.includes(item.agentKind as AgentKind) || typeof item.providerId !== 'string' || !item.providerId || typeof item.model !== 'string' || !item.model) throw new Error('INVALID_MODEL_SELECTION');
  if (item.effort !== undefined && !['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(String(item.effort))) throw new Error('INVALID_MODEL_EFFORT');
  return { agentKind: item.agentKind as AgentKind, providerId: item.providerId, model: item.model, ...(item.effort !== undefined ? { effort: item.effort as Effort } : {}) };
}

/** Non-secret user overrides; provider metadata continues to come from the shared catalog. */
export class TerminalModelConfig {
  private defaultPreferences?:TerminalModelDefaults;
  get defaults(){if(!this.defaultPreferences)throw new Error('MODEL_DEFAULTS_NOT_READY');return this.defaultPreferences;}
  readonly providerOrder:ReturnType<typeof createProviderOrderStore>;
  readonly disables: ReturnType<typeof createModelDisableStore>;
  readonly routeMutations: ReturnType<typeof createProviderRouteMutations>;
  readonly configMutations: ReturnType<typeof createProviderConfigMutations>;
  readonly routeVerdict: ReturnType<typeof createModelRouteVerdict>;
  readonly contextLimits: ReturnType<typeof createModelContextLimitStore>;
  readonly configuredContextWindow: ReturnType<typeof createConfiguredContextWindowResolver>;
  private readonly providerStore: Promise<ReturnType<typeof createCustomProviderStore>>;
  private readonly ownerDatabase: Promise<Pick<NodeDatabase, 'getDbClient' | 'dbPath' | 'getCurrentDbClientUserId'>>;
  private visibilityService?: Awaited<ReturnType<typeof openTerminalModelVisibility>>;
  private readonly visibilityListeners=new Set<()=>void>();
  get visibility(){if(!this.visibilityService)throw new Error('MODEL_VISIBILITY_NOT_READY');return this.visibilityService;}
  onVisibilityChanged(listener:()=>void){this.visibilityListeners.add(listener);return ()=>this.visibilityListeners.delete(listener);}
  async visibilityOverrides(providers:readonly ProviderView[]){await this.visibility.synchronize(providers);return this.visibility.mirror.getModelVisibilityMirrorSnapshot(providers);}
  async waitForModelVisibility(){
    await this.visibility.synchronize(await this.views({allowSideEffects:false,snapshotOnly:true}));
    await this.visibility.mirror.waitForModelVisibilityMirror();
  }
  async providerListSnapshot(providers:ProviderView[],owner:{dataOwnerId:string|null;generation:number}){
    return projectProviderList({providers,dataOwnerId:owner.dataOwnerId,ownerGeneration:owner.generation,
      providerOrder:this.providerOrder.readProviderOrder(),modelVisibilityOverrides:await this.visibilityOverrides(providers)});
  }
  async setVisibility(agent:AgentKind,providerId:string,modelIds:string[],enabled:boolean){
    const providers=await this.views({allowSideEffects:false});await this.visibility.synchronize(providers);
    if(!await this.visibility.preferences.setManyVisibility(agent,providerId,modelIds,enabled))throw new Error('MODEL_VISIBILITY_WRITE_FAILED');
  }
  private state: ModelState = { version: 1, providers: [] };
  readonly catalogRuntime: ReturnType<typeof createActiveCatalog>;
  private readonly nativeConnectionSnapshot = new Map<AgentKind, boolean>();
  private readonly discovery = new Map<AgentKind, Promise<void>>();
  private pending: Promise<unknown> = Promise.resolve();
  private readonly file: string;
  private gateway: (() => { apiKey: string; endpoint: string } | null) | undefined;
  private refreshGateway?: () => Promise<void>;
  private rejectGateway?: (key: string | null | undefined) => void;
  private mutations = 0;
  private oauth?: ModelOAuthConnection;
  nativeAccounts?: TerminalNativeAccounts;
  nativeClaude?: TerminalClaudeLogin;
  nativeGrok?: TerminalGrokLogin;
  private readonly nativeModels = new Map<string, CatalogModel[]>();
  private subscriptions?: TerminalSubscriptions;
  private localRuntime?: { prepare(id: string): Promise<void>; removed(id: string): void; remove?(id: string, remove: () => Promise<void>): Promise<void> };
  connectLocalRuntime(runtime: NonNullable<TerminalModelConfig['localRuntime']>) { this.localRuntime = runtime; }
  async prepareLocalModel(id: string) { await this.localRuntime?.prepare(id); }
  localCatalog() { return this.catalogRuntime.getActiveLocalModelCatalog(); }
  connectSubscriptions(accounts: TerminalSubscriptions) { this.subscriptions = accounts; this.generation++; }
  openAiAccount(id = 'openai') { return this.subscriptions?.openAiAccount(id) ?? (id === 'openai' ? this.nativeAccounts : undefined); }
  grokAccount(id = 'xai') { return this.subscriptions?.grokAccount(id) ?? (id === 'xai' ? this.nativeGrok : undefined); }
  private async discoverOpenAi(id: string, force = false) {
    const account = this.openAiAccount(id);
    if (!account?.connected()) return;
    const models = await account.models(force);
    if (models === this.nativeModels.get(id)) return;
    if (id === 'openai') this.catalogRuntime.setDiscoveredCodexModels(models);
    else this.catalogRuntime.setDiscoveredProviderModels(id, 'codex', models);
    this.nativeModels.set(id, models);
  }
  connectNative(connection: TerminalNativeAccounts) { this.nativeAccounts = connection; this.generation++; }

  connectOAuth(connection: ModelOAuthConnection) { this.oauth = connection; this.generation++; }
  constructor(private readonly profileDir: string, private readonly secrets: TerminalSecrets, private readonly nativeStatus: NativeStatus, private readonly catalog: Catalog = BUNDLED_CATALOG, private readonly discover?: (kind: AgentKind) => Promise<CatalogModel[]>, region: 'cn' | 'global' = 'global', private readonly logger: Pick<Logger, 'debug' | 'info' | 'warn'> = console, database?: Promise<Pick<NodeDatabase, 'getDbClient' | 'dbPath' | 'getCurrentDbClientUserId'>>) {
    this.disables = createModelDisableStore(() => path.join(profileDir, 'model-disable-prefs.json'), logger);
    this.providerOrder=createProviderOrderStore(()=>path.join(profileDir,'provider-order-prefs.json'),logger);
    if (!database) throw new Error('MODEL_OWNER_DATABASE_REQUIRED');
    this.ownerDatabase=database;
    this.providerStore = database.then(db => createCustomProviderStore(db.getDbClient));
    this.contextLimits = createModelContextLimitStore(() => path.join(profileDir, 'model-context-limit-prefs.json'), logger);
    this.configuredContextWindow = createConfiguredContextWindowResolver({
      readModelContextLimit: this.contextLimits.readModelContextLimit,
      resolveDesktopModelContextProviderId: (catalog, kind, provider, model) => this.contextProvider(kind, provider, model, catalog),
    });
    this.file = path.join(profileDir, 'models.json');
    this.catalogRuntime = createActiveCatalog(region);
    this.catalogRuntime.setActiveCatalog(catalog, { capabilityEvidence: catalog === BUNDLED_CATALOG ? 'fallback' : 'current' });
    this.routeMutations = createProviderRouteMutations({
      inferProviderIdForModel: (model, agent) => this.contextProvider(agent, null, model),
      getProviderRoutingDescriptor: (id, agent, model) => {
        if (!id || this.routeMutations.isProviderRouteMutationInProgress(id)) return null;
        const provider = this.activeCatalog().providers.find(provider => provider.id === id);
        return provider ? providerRoutingForModel(provider, agent, model) ?? null : null;
      },
    });
    this.configMutations = createProviderConfigMutations({beginRouteMutation: this.routeMutations.beginProviderRouteMutation});
    this.routeVerdict = createModelRouteVerdict({
      getActiveCatalog: () => this.activeCatalog(), getDesktopProviderService: () => ({listProviders: opts => this.views(opts)}),
      isXdGatewayPaymentRequiredRoute: this.catalogRuntime.isXdGatewayPaymentRequiredRoute,
      readModelDisableOverrides: this.disables.readModelDisableOverrides,
    });
  }
  contextProvider(kind: AgentKind, provider: string | null | undefined, model: string, catalog: Pick<Catalog, 'providers'> = this.activeCatalog()) {
    return resolveModelContextProviderId(catalog, kind, provider, model,
      this.state.defaultSelection?.agentKind === kind ? this.state.defaultSelection.providerId : null);
  }
  inferProviderIdForModel(model: string, kind: AgentKind): string | null {
    const candidates = modelProviderCandidates(this.activeCatalog(), model, kind, id =>
      !this.routeMutations.isProviderRouteMutationInProgress(id) && (id !== 'xd' || Boolean(this.gateway?.())),
    );
    return candidates.length === 1 ? candidates[0]!.id : null;
  }
  nativeContextLimit(kind: AgentKind, provider: string | null | undefined, model: string, includeDefault = kind !== 'codex') {
    const catalog = this.activeCatalog();
    const source = this.contextProvider(kind, provider, model, catalog);
    return source ? this.contextLimits.readModelContextLimit(kind, source, model)
      ?? (includeDefault ? resolveModelDefaultContextWindow(catalog, kind, source, model) : null) : null;
  }
  async open(): Promise<void> {
    await privateDirectory(this.profileDir);
    const store = await this.providerStore;
    const raw = await readPrivateFile(this.file);
    const parsed = raw ? object(JSON.parse(raw.toString())) : {version: 1};
    if (parsed.version !== 1) throw new Error('MODEL_CONFIGURATION_VERSION_UNSUPPORTED');
    // Import pre-release terminal profiles once. The original owner DB wins
    // existing rows; interrupted imports retry without replacing saved data.
    if (Array.isArray(parsed.providers)) for (const value of parsed.providers) {
      const legacy = object(value);
      if (typeof legacy.id !== 'string' || typeof legacy.name !== 'string' || !legacy.runtimes) throw new Error('INVALID_MODEL_CONFIGURATION');
      if (!(await store.customProviderExists(legacy.id))) await store.createCustomProvider(legacy as unknown as CustomProviderConfig);
    }
    if (parsed.disabled && !existsSync(path.join(this.profileDir, 'model-disable-prefs.json'))) this.disables.importLegacyOverrides(parsed.disabled);
    this.state = {version: 1, providers: await store.listCustomProviders(),
      ...(parsed.defaultSelection ? {defaultSelection: parseSelection(parsed.defaultSelection)} : {})};
    this.catalogRuntime.setCustomProviderConfigs(this.state.providers);
    this.defaultPreferences?.close();
    this.defaultPreferences=await openTerminalModelDefaults({profileDir:this.profileDir,database:await this.ownerDatabase,legacy:this.state.defaultSelection});
    this.state.defaultSelection=this.defaultPreferences.selection();
    if (!raw || Array.isArray(parsed.providers) || parsed.disabled) await this.persist(this.state);
    this.visibilityService?.close();
    this.visibilityService=await openTerminalModelVisibility({profileDir:this.profileDir,database:await this.ownerDatabase,
      hasModelPreferenceHistory:()=>!!this.state.defaultSelection,
      changed:()=>{for(const listener of this.visibilityListeners)listener();},log:this.logger});
  }
  private parseProvider(value: unknown): CustomProviderConfig {
    // Keep the terminal's pre-extraction provider file contract readable: older
    // Pi entries omitted wireProtocol and used the native OpenAI-compatible route.
    // Normalize that legacy shape before applying the shared strict validator.
    const input = structuredClone(value) as Record<string, unknown>;
    const runtimes = input.runtimes;
    if (runtimes && typeof runtimes === 'object' && !Array.isArray(runtimes)) {
      for (const [agent, raw] of Object.entries(runtimes as Record<string, unknown>)) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
        const runtime = raw as Record<string, unknown>;
        if (runtime.wireProtocol !== undefined) continue;
        runtime.wireProtocol = agent === 'claude-code' ? 'anthropic-messages' : agent === 'codex' ? 'openai-responses' : 'openai-chat';
      }
    }
    const result = validateCustomProviderConfig(input);
    if (!result.ok) throw new Error(`INVALID_MODEL_CONFIGURATION: ${result.message}`);
    const config = input as unknown as CustomProviderConfig;
    for (const runtime of Object.values(config.runtimes)) if (runtime) delete runtime.headers;
    return config;
  }
  previewProvider(input:unknown) {
    const provider=this.parseProvider(input);const kind=Object.keys(provider.runtimes)[0] as AgentKind;
    const view=buildRegistry({...this.activeCatalog(),providers:[buildUserProvider(provider)]},{[provider.id]:true});
    const model=provider.runtimes[kind]!.models[0].id;const route=resolveRoute(view,provider.id,model,kind);
    if(!route)throw new Error('MODEL_ROUTE_UNAVAILABLE');return {route,selection:{agentKind:kind,providerId:provider.id,model}};
  }
  presets() { return structuredClone(this.activeCatalog().presets ?? []); }
  async refresh(providerId:string) {
    if (this.oauth && this.activeCatalog().providers.find(p => p.id === providerId)?.auth.oauth) { await this.oauth.refresh(providerId); return { ok: true as const, providerId }; }
    if (this.grokAccount(providerId)) { await this.grokAccount(providerId)!.models(true); this.generation++; return { ok: true as const, providerId }; }
    if (this.openAiAccount(providerId)) { await this.discoverOpenAi(providerId, true); this.generation++; return { ok: true as const, providerId }; }
    if (providerId === 'xd' && this.refreshGateway) { await this.refreshGateway(); return { ok: true as const, providerId }; }
    const kind=providerId==='openai'?'codex':providerId==='anthropic'?'claude-code':null;
    if(!kind||!this.discover)throw new Error('PROVIDER_DISCOVERY_UNAVAILABLE');
    this.discovery.delete(kind);await this.views();
    if(!this.discovery.has(kind))throw new Error('PROVIDER_DISCOVERY_FAILED');
    return {ok:true as const,providerId};
  }
  setDisabled(input:unknown,guard:()=>void) {
    const patch=object(input);const id=patch.providerId;
    if(typeof id!=='string'||!id||id.length>256||!['model','provider','reset'].includes(String(patch.kind)))throw new Error('INVALID_MODEL_DISABLE');
    if(patch.kind!=='reset'&&typeof patch.disabled!=='boolean')throw new Error('INVALID_MODEL_DISABLE');
    const ids=patch.modelIds;
    if(patch.kind==='model'&&(!Array.isArray(ids)||ids.length<1||ids.length>512||ids.some(id=>typeof id!=='string'||!id||id.length>256)))throw new Error('INVALID_MODEL_DISABLE');
    return this.providerChange(id, async()=>{
      guard();const provider=buildRegistry(this.activeCatalog(),{}).find(p=>p.id===id);
      if(patch.disabled&&!provider)throw new Error('PROVIDER_NOT_FOUND');
      if(patch.kind==='model'&&patch.disabled&&(ids as string[]).some(id=>!Object.values(provider!.models).some(models=>models?.some(m=>m.id===id))))throw new Error('MODEL_NOT_FOUND');
      guard();
      if (patch.kind === 'reset') this.disables.clearProviderDisableOverrides(id);
      else if (patch.kind === 'provider') this.disables.setProviderDisabled(id, patch.disabled as boolean);
      else this.disables.setModelsDisabled(id, ids as string[], patch.disabled as boolean);
    });
  }
  disconnect(id:string,guard:()=>void) {return this.providerChange(id, async()=>{guard();this.oauth?.cancelProvider?.(id);if(id==='anthropic'&&this.nativeClaude){this.nativeClaude.disconnect();return;}if(this.grokAccount(id)){this.grokAccount(id)!.disconnect();return;}if(this.openAiAccount(id)){this.openAiAccount(id)!.disconnect();return;}if(!this.state.providers.some(p=>p.id===id))throw new Error('PROVIDER_NOT_FOUND');if(this.activeCatalog().providers.find(p=>p.id===id)?.auth.oauth){if(!this.oauth)throw new Error('PROVIDER_CONNECTION_UNAVAILABLE');this.oauth.disconnect(id);}for(const kind of ENGINES){guard();await this.secrets.delete(this.key(id,kind));}});}
  connectGateway(read: () => { apiKey: string; endpoint: string } | null, refresh?: () => Promise<void>, rejected?: (key: string | null | undefined) => void) { this.gateway = read; this.refreshGateway = refresh; this.rejectGateway = rejected; }
  gatewayCredentials() { return this.gateway?.() ?? null; }
  reportGatewayRejection(key: string | null | undefined) { this.rejectGateway?.(key); }
  isMutating() { return this.mutations > 0 || this.configMutations.providerConfigMutationCounts.size > 0; }
  gatewayChanged() { this.generation += 1; }
  activeCatalog(): Catalog {
    const catalog = this.catalogRuntime.getActiveCatalog(), gateway = this.gateway?.();
    if (!gateway) return catalog;
    return { ...catalog, providers: catalog.providers.map(provider => provider.id !== 'xd' ? provider : {
      ...provider, routing: Object.fromEntries(Object.entries(provider.routing).map(([kind, route]) => [kind, { ...route, upstream: gateway.endpoint, authStrategy: 'api-key-header' }])),
    }) };
  }
  async views(opts: Partial<ProviderListOptions> = {allowSideEffects: true}): Promise<ProviderView[]> {
    await this.pending;
    const read: ConnectionReadOptions = {
      allowSideEffects: opts.allowSideEffects === true && opts.snapshotOnly !== true,
      snapshotOnly: opts.snapshotOnly === true,
      waitForDiscovery: opts.waitForDiscovery === true,
    };
    const native = async (kind: AgentKind) => {
      if (kind === 'codex' && this.openAiAccount()) return this.openAiAccount()!.connected();
      if (read.snapshotOnly) return kind === 'claude-code' && this.nativeClaude
        ? this.nativeClaude.snapshot().authenticated : this.nativeConnectionSnapshot.get(kind) ?? false;
      const status = kind === 'claude-code' && this.nativeClaude
        ? await this.nativeClaude.state() : await this.nativeStatus(kind);
      this.nativeConnectionSnapshot.set(kind, status.authenticated);
      return status.authenticated;
    };
    const [anthropic, openai] = await Promise.all([native('claude-code'), native('codex')]);
    if (read.allowSideEffects) {
      for (const provider of this.activeCatalog().providers) {
        if (this.grokAccount(provider.id)?.connected()) await this.grokAccount(provider.id)!.models().catch(() => {});
        if (this.openAiAccount(provider.id)?.connected()) await this.discoverOpenAi(provider.id).catch(() => {});
      }
      if (this.discover) await Promise.all(([['claude-code', anthropic], ['codex', openai]] as const)
        .filter(([kind, connected]) => connected && !(kind === 'codex' && this.openAiAccount()))
        .map(async ([kind]) => {
          let pending = this.discovery.get(kind);
          if (!pending) {
            pending = this.discover!(kind).then(models => {
              if (kind === 'codex') this.catalogRuntime.setDiscoveredCodexModels(models, {source: 'list'});
              else this.catalogRuntime.setAnthropicDiscoveredModels(models);
            }).catch(() => { this.discovery.delete(kind); });
            this.discovery.set(kind, pending);
          }
          await pending;
        }));
    }
    const catalog = opts.getCatalog?.() ?? opts.catalog ?? this.activeCatalog();
    const keys = new Map<string, string | null>();
    await Promise.all(catalog.providers.flatMap(provider => provider.agents.map(async kind => {
      keys.set(`${provider.id}:${kind}`, await this.secrets.get(this.key(storedCustomProviderId(provider.id), kind)));
    })));
    return createProviderService({
      getCatalog: () => catalog,
      connection: {xd: () => Boolean(this.gateway?.()), anthropic: () => anthropic,
        openai: () => openai, xai: () => Boolean(this.grokAccount()?.connected())},
      genericOAuthConnected: id => Boolean(this.oauth?.connected(storedCustomProviderId(id))),
      codexAccountConnected: id => Boolean(this.openAiAccount(id)?.connected()),
      subscriptionAccountConnected: id => id === 'anthropic' ? anthropic : Boolean(this.grokAccount(id)?.connected()),
      customApiKeyConnected: provider => hasCustomProviderCredential(provider, (id, kind) => keys.get(`${id}:${kind}`) ?? null),
      builtinApiKeyConnected: id => ENGINES.some(kind => Boolean(keys.get(`${id}:${kind}`)?.trim())),
      openAiAccountInfo: async id => ({source: 'oauth', identity: this.openAiAccount(id)?.accountIdentity().email ?? undefined}),
      getModelAccess: this.disables.readModelDisableOverrides,
    }).listProviders(read);
  }

  snapshot() { return structuredClone({...this.state, defaultSelection:this.defaultPreferences?this.defaultPreferences.selection():this.state.defaultSelection, disabled: this.disables.readModelDisableOverrides()}); }
  providerSources() { return this.activeCatalog().providers.map(({ id, source }) => ({ id, source })); }
  private generation = 0;
  revision() { return this.generation + this.catalogRuntime.getActiveCatalogRevision(); }
  async verdict(agent: AgentKind, model: string, providerId: string | null) {
    const catalog = this.activeCatalog();
    return checkModelRoute(await this.views(), agent, model, providerId, {
      isPaymentRequiredTombstone: (id, modelId, kind) => (id === null || id === 'xd') && this.catalogRuntime.isXdGatewayPaymentRequiredRoute(modelId, kind),
      isRetiredTombstone: (id, modelId, kind) => [...(id ? [id] : MODEL_PLANE_POLICIES.keys())]
        .some(provider => isRegistryTombstoneForConsumer(catalog.modelRegistry, provider, modelId, kind)),
    });
  }
  async select(input?: unknown): Promise<{ selection: ModelSelection; route: ResolvedRoute; modelRevision: number }> {
    await this.pending;
    const views = await this.views();
    await this.visibility.synchronize(views);
    const modelRevision = this.revision();
    let selection = input ? parseSelection(input) : this.defaults.selection();
    if (!selection) {
      for (const kind of ENGINES) {
        const provider = views.find(p => p.connected && !p.suspended && (p.source === 'user' || p.id === 'xd' || p.id === 'xai' || kind === 'claude-code' && p.id === 'anthropic' || kind === 'codex' && p.id === 'openai') && p.models[kind]?.some(m => !m.disabled && this.visibility.preferences.isModelEnabled(kind,p.id,m)));
        const model = provider?.models[kind]?.find(m => !m.disabled && this.visibility.preferences.isModelEnabled(kind,provider.id,m));
        if (provider && model) { selection = { agentKind: kind, providerId: provider.id, model: model.id }; break; }
      }
    }
    if (!selection) throw new Error('MODEL_CONFIGURATION_REQUIRED');
    const route = resolveRoute(views, selection.providerId, selection.model, selection.agentKind);
    if (!route || !route.provider.connected || route.provider.suspended || route.model.disabled) throw new Error('MODEL_ROUTE_UNAVAILABLE');
    // Built-in subscriptions use the original vendor CLI. Cross-harness OAuth
    // needs a separately authorized credential bridge, never a copied login.
    if (selection.providerId === 'xd' && this.catalogRuntime.isXdGatewayPaymentRequiredRoute(selection.model, selection.agentKind)) throw new Error('MODEL_PAYMENT_REQUIRED');
    if (route.provider.source !== 'user' && !(selection.providerId === 'xd' && this.gateway?.()) && !(route.provider.auth.oauth && this.oauth?.connected(selection.providerId)) && !(this.openAiAccount(selection.providerId)?.connected()) && !(this.grokAccount(selection.providerId)?.connected()) && !((selection.agentKind === 'claude-code' && selection.providerId === 'anthropic') || (selection.agentKind === 'codex' && selection.providerId === 'openai'))) throw new Error('MODEL_ROUTE_REQUIRES_SUPPORTED_CONNECTION');
    const custom = this.state.providers.find(p => p.id === selection.providerId);
    if (custom && !custom.auth?.native && custom.auth?.method !== 'none' && !await this.credential(selection.providerId, selection.agentKind)) throw new Error('MODEL_CREDENTIAL_REQUIRED');
    if (modelRevision !== this.revision() || this.isMutating()) throw new Error('MODEL_CONFIGURATION_CHANGED');
    return { selection: structuredClone(selection), route, modelRevision };
  }
  private change<T>(operation: () => Promise<T>): Promise<T> {
    this.mutations += 1;
    const result = this.pending.then(async () => { try { return await operation(); } finally { this.generation += 1; this.mutations -= 1; } });
    this.pending = result.catch(() => undefined);
    return result;
  }
  serializeSettings<T>(provider: string, operation: () => Promise<T>): Promise<T> {
    return this.configMutations.withProviderConfigMutation(provider, operation);
  }
  private providerChange<T>(provider: string, operation: () => Promise<T>): Promise<T> {
    return this.configMutations.withProviderConfigMutation(provider, async commit => {
      const result = await this.change(operation); commit(); return result;
    });
  }
  private localContext?: {
    validate(targets: readonly import('@cindy/app-runtime/modelPriceOverride').ModelPriceOverrideTarget[], limit: number): Promise<void>;
    configure(run: () => Promise<void>): Promise<void>;
  };
  connectLocalContext(service: NonNullable<TerminalModelConfig['localContext']>) {this.localContext = service;}
  async validateLocalContext(targets: readonly import('@cindy/app-runtime/modelPriceOverride').ModelPriceOverrideTarget[], limit: number) {
    if (!this.localContext) throw new Error('Local model runtime is unavailable');
    return this.localContext.validate(targets, limit);
  }
  async configureLocalContext(run: () => Promise<void>) {
    if (!this.localContext) throw new Error('Local model runtime is unavailable');
    return this.localContext.configure(run);
  }
  private async persist(state: ModelState): Promise<void> { const {providers: _, disabled: _legacyDisabled, ...preferences} = state; await atomicPrivateWrite(this.file, JSON.stringify(preferences)); this.state = state; this.catalogRuntime.setCustomProviderConfigs(state.providers); }
  setDefault(input: unknown, guard: () => void = () => {}): Promise<void> {
    const selection = parseSelection(input);
    return this.change(async () => {
      guard();
      const route = resolveRoute(buildRegistry(this.activeCatalog(), {}), selection.providerId, selection.model, selection.agentKind);
      if (!route) throw new Error('MODEL_ROUTE_UNAVAILABLE');
      await this.defaults.setSelection(selection,guard);
      this.state={...this.state,defaultSelection:selection};
    });
  }
  applyDefaultModelSelection(selection:import('@cindy/companion-core/appDefaultModelSelection').AppDefaultModelSelection,guard:()=>void) {
    return this.change(async()=>{guard();const saved=await this.defaults.applySelection(selection);if(saved)this.state={...this.state,defaultSelection:this.defaults.selection()};return saved;});
  }
  resetDefault(guard: () => void = () => {}): Promise<void> { return this.change(async () => { guard();await this.defaults.clear(guard);const {defaultSelection:_,...state}=this.state;this.state=state; }); }
  saveProvider(input: unknown, runtimeKeys: unknown = {}, createOnly = false, guard: () => void = () => {}): Promise<void> {
    const config = this.parseProvider(input);
    const keys = object(runtimeKeys);
    const headers = Object.entries(object(object(input).runtimes)).filter(([, runtime]) => Object.prototype.hasOwnProperty.call(object(runtime), 'headers')).map(([kind, runtime]) => [kind, JSON.stringify(this.validateHeaders(object(runtime).headers))] as const);
    if (Object.entries(keys).some(([kind, value]) => !ENGINES.includes(kind as AgentKind) || typeof value !== 'string')) throw new Error('INVALID_PROVIDER_KEYS');
    return this.providerChange(config.id, async () => {
      guard();
      const exists = this.state.providers.some(p => p.id === config.id);
      if (createOnly && exists) throw new Error('PROVIDER_ALREADY_EXISTS');
      if (!createOnly && !exists) throw new Error('PROVIDER_NOT_FOUND');
      const oldAuth = this.state.providers.find(p => p.id === config.id)?.auth;
      const previous = new Map<string, string | null>();
      let restoreOAuth: (() => void) | undefined;
      try {
        if (oldAuth?.method === 'oauth' && JSON.stringify(oldAuth) !== JSON.stringify(config.auth)) restoreOAuth = this.oauth?.removeReversibly(config.id);
        for (const [kind, value] of [...Object.entries(keys), ...headers.map(([kind, value]) => [`${kind}:headers`, value])]) {
          const key = `terminal:provider:${config.id}:${kind}`;
          previous.set(key, await this.secrets.get(key));
          guard();
          if (value) await this.secrets.set(key, value as string); else await this.secrets.delete(key);
        }
        guard();
        const store = await this.providerStore;
        const saved = createOnly ? await store.createCustomProvider(config) : await store.updateCustomProvider(config.id, config);
 if (!saved) throw new Error('PROVIDER_NOT_FOUND');
        this.state = {...this.state, providers: exists ? this.state.providers.map(provider => provider.id === saved.id ? saved : provider) : [...this.state.providers, saved]};
        this.catalogRuntime.setCustomProviderConfigs(this.state.providers);
      } catch (error) {
        restoreOAuth?.();
        for (const [key, value] of previous) { if (value === null) await this.secrets.delete(key); else await this.secrets.set(key, value); }
        throw error;
      }
    });
  }
  deleteProvider(id: string, guard: () => void = () => {}): Promise<void> {
    const remove = () => this.providerChange(id, async () => {
      guard();
      if (!this.state.providers.some(p => p.id === id)) throw new Error('PROVIDER_NOT_FOUND');
      const oauth = this.state.providers.find(p => p.id === id)?.auth?.method === 'oauth';
      const before = this.state;
      const state = { ...before, providers: before.providers.filter(p => p.id !== id) };
      if (state.defaultSelection?.providerId === id) delete state.defaultSelection;
      const restoreDisabled = this.disables.stageProviderDisableOverridesClear(id);
      let restoreOAuth: (() => void) | undefined;
      let restoreDefault:(()=>Promise<void>)|undefined;
      try {
        if(this.defaults.selection()?.providerId===id)restoreDefault=await this.defaults.stageClear();
        restoreOAuth = oauth ? this.oauth?.removeReversibly(id) : undefined;
        await this.persist({...state, providers: this.state.providers});
        await (await this.providerStore).deleteCustomProvider(id);
        this.state = state;
        this.catalogRuntime.setCustomProviderConfigs(this.state.providers);
      } catch (error) { await restoreDefault?.();restoreOAuth?.(); if (!restoreDisabled()) throw new AggregateError([error], 'Provider disable settings could not be restored'); if (this.state !== before) await this.persist(before); throw error; }
      this.localRuntime?.removed(id);
      for (const kind of ENGINES) { await this.secrets.delete(this.key(id, kind)); await this.secrets.delete(`${this.key(id, kind)}:headers`); }
    });
    return this.localRuntime?.remove ? this.localRuntime.remove(id, remove) : remove();
  }
  private validateHeaders(value: unknown): Record<string, string> {
    const headers = object(value);
    const clean: Record<string, string> = {};
    for (const [name, value] of Object.entries(headers)) {
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || typeof value !== 'string' || /[\r\n]/.test(value) || ['host', 'connection', 'content-length', 'transfer-encoding', 'upgrade'].includes(name.toLowerCase())) throw new Error('INVALID_PROVIDER_HEADER');
      clean[name.toLowerCase()] = value;
    }
    return clean;
  }
  async headers(providerId: string, agent: AgentKind): Promise<Record<string, string>> {
    const value = await this.secrets.get(`${this.key(providerId, agent)}:headers`);
    return value ? this.validateHeaders(JSON.parse(value)) : {};
  }
  credential(providerId: string, agent: AgentKind): Promise<string | null> {
    if (this.activeCatalog().providers.find(p=>p.id===providerId)?.auth.oauth) return this.oauth?.credential(providerId) ?? Promise.resolve(null);
    return providerId === 'xd' ? Promise.resolve(this.gateway?.()?.apiKey ?? null) : this.secrets.get(this.key(providerId, agent));
  }
  private key(id: string, agent: AgentKind) { return `terminal:provider:${id}:${agent}`; }
  /** Private request snapshot. Credentials and headers never enter model views. */
  async utilityCredentials(options: { allProviders?: boolean } = {}) {
    await this.views();
    const revision = this.revision();
    const keys = new Map<string, string | null>();
    const catalog = structuredClone(this.activeCatalog());
    for (const provider of catalog.providers) {
      if ((!options.allProviders && provider.source !== 'user') || provider.auth.native) continue;
      for (const kind of provider.agents) {
        keys.set(`${provider.id}:${kind}`, await this.credential(provider.id, kind));
        const routing = provider.routing[kind];
        if (routing) routing.headerOverride = { ...routing.headerOverride, ...await this.headers(provider.id, kind) };
      }
    }
    if (revision !== this.revision() || this.isMutating()) throw new Error('MODEL_CONFIGURATION_CHANGED');
    return { revision, catalog, readKey: (id: string, kind: string) => revision === this.revision() && !this.isMutating() ? keys.get(`${id}:${kind}`) ?? null : null };
  }
  async flush() { await this.pending; }
  async close(){await this.flush();this.defaultPreferences?.close();this.visibilityService?.close();this.visibilityListeners.clear();}
}
