/**
 * Subscription provider publication and catalog projection shared by Desktop and
 * Node Host. Bodies moved from createDesktopProviderService.ts; platform readers
 * and the in-memory catalog publisher are ports. Runtime imports stay in bindings.
 */
import type { Catalog } from '@cindy/model-providers';
import type { readPool, readProviderBoundAccountIds } from '../subscription-accounts/store.js';
import type { readMergedProviderAccount, accountProviderId, readCreatedSubscriptionProvidersIfReadable } from '../subscription-accounts/placement.js';
import type { readSubscriptionPoolCodexModels } from '../subscription-accounts/runtime.js';
import type { getActiveCatalogWithCodexModels, setSubscriptionPoolProviders } from './active-catalog.js';

export interface SubscriptionPoolCatalogPorts {
  readPool: typeof readPool;
  codexAccountState(providerId: string): { authenticated: boolean };
  readSubscriptionPoolCodexModels: typeof readSubscriptionPoolCodexModels;
  getActiveCatalogWithCodexModels: typeof getActiveCatalogWithCodexModels;
  readMergedProviderAccount: typeof readMergedProviderAccount;
  accountProviderId: typeof accountProviderId;
  readProviderBoundAccountIds: typeof readProviderBoundAccountIds;
}

export interface SubscriptionPoolPublisherPorts {
  readCreatedSubscriptionProvidersIfReadable: typeof readCreatedSubscriptionProvidersIfReadable;
  setSubscriptionPoolProviders: typeof setSubscriptionPoolProviders;
  log: { warn(message: string, data: Record<string, unknown>): void };
}

/** Preserve the published list when the placement file is unreadable or the reader throws. */
export function publishSubscriptionPoolProviders(ports: SubscriptionPoolPublisherPorts): void {
  try {
    const created = ports.readCreatedSubscriptionProvidersIfReadable();
    if (created === null) return;
    ports.setSubscriptionPoolProviders(Object.entries(created)
      .map(([id, entry]) => ({ id, kind: entry.kind, name: entry.name })));
  } catch (err) {
    // A thrown read also keeps the previous list; the next refresh retries.
    ports.log.warn('publishing subscription providers failed', { err: String(err) });
  }
}

/** Apply account membership to both selectable and full routing snapshots. */
export function projectSubscriptionPoolCatalog(catalog: Catalog, ports: SubscriptionPoolCatalogPorts, routingCatalog = false): Catalog {
  const pool = ports.readPool('openai');
  const aliases = pool?.legacyCodexAccounts;
  const originalProviders = catalog.providers;
  catalog = { ...catalog, providers: catalog.providers.map(provider => {
    const legacy = provider.auth.native === 'codex' && aliases && Object.hasOwn(aliases, provider.id);
    if (provider.id !== 'openai' && provider.subscriptionPool !== 'openai' && !legacy) return provider;
    const pooledModels = ports.readSubscriptionPoolCodexModels(provider.id, routingCatalog ? { includeBoundAccounts: true } : undefined);
    if (pooledModels === null) return provider;
    const openai = ports.getActiveCatalogWithCodexModels(pooledModels).providers.find(entry => entry.id === 'openai');
    if (!openai) return provider;
    if (provider.id === 'openai') return openai;
    if (provider.subscriptionPool === 'openai') return { ...provider, models: openai.models };
    // Preserve the imported login's configured membership only while it belongs here,
    // or while this old id is a compatibility route for that login after a merge.
    const originalAccount = pool?.accounts.find(account => account.id === aliases![provider.id]);
    const keepOriginal = !!ports.readMergedProviderAccount(provider.id) || (
      ports.accountProviderId('openai', aliases![provider.id]) === provider.id
      && (routingCatalog || (!!originalAccount && !originalAccount.paused && ports.codexAccountState(provider.id).authenticated))
    );
    return { ...provider, models: Object.fromEntries(provider.agents.map(agent => {
      const models = new Map((keepOriginal ? provider.models[agent] ?? [] : []).map(model => [model.id, model]));
      for (const model of openai.models[agent] ?? []) if (!models.has(model.id)) models.set(model.id, model);
      return [agent, [...models.values()]];
    })) };
  }) };
  if (!aliases) return catalog;
  // A merged legacy connection lends its model membership to the provider its account belongs to
  // now (OpenAI or another provider of the user's choice), while that provider can use it.
  const lenders = new Map<string, Catalog['providers']>();
  const historicalAccounts = routingCatalog ? new Map(catalog.providers
    .filter(provider => provider.id === 'openai' || provider.subscriptionPool === 'openai' || Object.hasOwn(aliases, provider.id))
    .map(provider => [provider.id, ports.readProviderBoundAccountIds('openai', provider.id)])) : null;
  for (const provider of originalProviders) {
    const accountId = provider.auth.native === 'codex' && Object.hasOwn(aliases, provider.id) ? aliases[provider.id] : undefined;
    const account = accountId ? pool.accounts.find(entry => entry.id === accountId) : undefined;
    if (!account) continue;
    const owner = ports.accountProviderId('openai', account.id);
    if (owner === 'openai' && pool.disconnected) continue;
    if (!ports.codexAccountState(provider.id).authenticated) continue;
    if (!account.paused && owner !== provider.id) lenders.set(owner, [...(lenders.get(owner) ?? []), provider]);
    // Full routing keeps bound model metadata even while paused, so saved routes
    // can reach the pre-send handoff. Allocation still rejects paused accounts;
    // only the bound imported account lends membership, never the destination's pool.
    for (const [target, bound] of historicalAccounts ?? []) {
      if (target !== provider.id && target !== owner && bound.has(account.id))
        lenders.set(target, [...(lenders.get(target) ?? []), provider]);
    }
  }
  if (!lenders.size) return catalog;
  // Reuse these accounts' existing membership; do not discover an unrelated default CLI login.
  return { ...catalog, providers: catalog.providers.map(provider => {
    const imported = lenders.get(provider.id);
    if (!imported) return provider;
    const models = Object.fromEntries(provider.agents.map(agent => {
      const models = new Map((provider.models[agent] ?? []).map(model => [model.id, model]));
      for (const source of imported) for (const model of source.models[agent] ?? [])
        if (!models.has(model.id)) models.set(model.id, model);
      return [agent, [...models.values()]];
    }));
    return { ...provider, models };
  }) };
}
