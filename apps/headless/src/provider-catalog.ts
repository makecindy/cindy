import {
  BUNDLED_CATALOG,
  buildRegistry,
  buildUserProvider,
  providersForAgent,
  type AgentKind,
  type Catalog,
  type CatalogModel,
  type ProviderView,
} from '@cindy/model-providers';
import type { HeadlessConfig, HeadlessManagedModel, HeadlessProviderProfile } from './config.js';

export interface HeadlessProviderSummary {
  id: string;
  name: string;
  source: 'builtin' | 'user';
  agents: AgentKind[];
  authMethod: 'oauth' | 'apiKey' | 'managed';
  enabled: boolean;
  credentialConfigured: boolean;
}

export interface HeadlessCatalogModel extends Pick<CatalogModel, 'id' | 'name' | 'description' | 'contextWindow' | 'efforts' | 'defaultEffort' | 'supportsFastMode'> {
  providerId: string;
}

/**
 * Projects the shared provider catalog into a safe Linux-host control surface.
 * Routing descriptors and secret references stay daemon-private, so the same
 * projection is safe to reuse for CLI and Device Link read calls.
 */
export class HeadlessProviderCatalog {
  listProviders(config: HeadlessConfig, agent?: AgentKind): HeadlessProviderSummary[] {
    const profiles = profileById(config.providerProfiles ?? []);
    const views = this.views(config);
    const candidates = agent ? providersForAgent(views, agent) : views;
    return candidates.map((provider) => this.toSummary(provider, profiles.get(provider.id)));
  }

  listModels(config: HeadlessConfig, agent: AgentKind, providerId?: string): HeadlessCatalogModel[] {
    const providers = providerId
      ? this.views(config).filter((provider) => provider.id === providerId && provider.agents.includes(agent))
      : providersForAgent(this.views(config), agent);
    return providers.flatMap((provider) => (provider.models[agent] ?? []).map((model) => ({
      id: model.id,
      name: model.name,
      description: model.description,
      contextWindow: model.contextWindow,
      efforts: [...model.efforts],
      defaultEffort: model.defaultEffort,
      supportsFastMode: model.supportsFastMode,
      providerId: provider.id,
    })));
  }

  /**
   * Mobile only needs a presentation catalog.  Keep every routing and secret
   * detail daemon-private while preserving the ProviderView fields consumed by
   * the shared model selector (connected, agent model lists and branding).
   */
  listDisplayProviders(config: HeadlessConfig, connectedOverride?: ReadonlyMap<string, boolean>): unknown[] {
    return this.views(config).map((provider) => ({
      id: provider.id,
      name: provider.name,
      source: provider.source,
      agents: [...provider.agents],
      auth: { method: provider.auth.method },
      access: provider.access,
      models: provider.models,
      connected: connectedOverride?.get(provider.id) ?? provider.connected,
      logoKind: provider.logoKind,
      // Keep the public shape compatible without leaking endpoint, headers,
      // auth strategy, or model rewrite information.
      routing: Object.fromEntries(provider.agents.map((agent) => [agent, {}])),
    }));
  }

  assertSelection(config: HeadlessConfig, agent: AgentKind, providerId: string | undefined, model: string): void {
    if (!providerId) return;
    const provider = this.views(config).find((entry) => entry.id === providerId);
    if (!provider) throw new Error(`Unknown provider: ${providerId}`);
    if (!provider.agents.includes(agent)) throw new Error(`Provider ${providerId} does not support ${agent}`);
    const models = provider.models[agent] ?? [];
    // Several builtin providers discover their current model list at runtime.
    // An empty list therefore means "not discovered yet", not "no model".
    if (models.length > 0 && !models.some((entry) => entry.id === model)) {
      throw new Error(`Model ${model} is not offered by provider ${providerId} for ${agent}`);
    }
  }

  private views(config: HeadlessConfig): ProviderView[] {
    const builtins = BUNDLED_CATALOG.providers.map((provider) => provider.id === 'xd'
      ? { ...provider, models: managedModelsByAgent(config.managedModels ?? []) }
      : provider);
    const catalog: Catalog = {
      ...BUNDLED_CATALOG,
      providers: [
        ...builtins,
        ...(config.providerProfiles ?? []).flatMap((profile) => profile.custom ? [buildUserProvider(profile.custom)] : []),
      ],
    };
    const profiles = profileById(config.providerProfiles ?? []);
    const connected = Object.fromEntries(catalog.providers.map((provider) => {
      const profile = profiles.get(provider.id);
      // Cindy AI is account-managed: its ephemeral gateway key is obtained by
      // the daemon from the Cindy account, never supplied as an Agent login.
      const managedReady = provider.id === 'xd' && Boolean(config.account) && (config.managedModels?.length ?? 0) > 0;
      return [provider.id, managedReady || (profile?.enabled === true && credentialConfigured(profile, provider.auth.method))];
    }));
    return buildRegistry(catalog, connected);
  }

  private toSummary(provider: ProviderView, profile: HeadlessProviderProfile | undefined): HeadlessProviderSummary {
    return {
      id: provider.id,
      name: provider.name,
      source: provider.source,
      agents: [...provider.agents],
      authMethod: provider.auth.method,
      enabled: profile?.enabled ?? false,
      credentialConfigured: provider.connected,
    };
  }
}

function managedModelsByAgent(models: HeadlessManagedModel[]) {
  const out: Record<string, import('@cindy/model-providers').CatalogModel[]> = {};
  for (const agent of ['claude-code', 'codex'] as const) {
    out[agent] = models.filter((model) => model.agents?.includes(agent) ?? agent === 'claude-code').map((model) => ({
      id: model.id,
      name: model.name ?? model.id,
      description: model.description,
      contextWindow: model.contextWindow ?? 128_000,
      efforts: model.efforts ?? ['low', 'medium', 'high'],
      defaultEffort: model.defaultEffort ?? 'high',
      supportsFastMode: model.supportsFastMode ?? true,
    }));
  }
  return out;
}

function profileById(profiles: HeadlessProviderProfile[]): Map<string, HeadlessProviderProfile> {
  return new Map(profiles.map((profile) => [profile.id, profile]));
}

function credentialConfigured(profile: HeadlessProviderProfile | undefined, authMethod: HeadlessProviderSummary['authMethod']): boolean {
  if (!profile?.enabled) return false;
  // Managed providers have no per-host credential, but are never silently
  // treated as available unless the user explicitly enabled the profile.
  return authMethod === 'managed' || typeof profile.secretRef === 'string';
}
