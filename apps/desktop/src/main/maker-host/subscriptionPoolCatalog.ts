/**
 * Subscription-pool projection of the selectable catalog, shared by the desktop
 * and the Node Host. Imported Codex accounts that belong to the OpenAI pool add
 * their models to the `openai` provider. Body moved verbatim from
 * createDesktopProviderService.ts; the pool and account readers are ports.
 * Type-only imports keep this a leaf module.
 */

import type { Catalog } from '@cindy/model-providers';
import type { readPool } from '../subscription-accounts/store.js';

export interface SubscriptionPoolCatalogPorts {
  readPool(provider: 'openai'): ReturnType<typeof readPool>;
  codexAccountState(providerId: string): { authenticated: boolean };
}

/** Apply account membership to both selectable and full routing snapshots. */
export function projectSubscriptionPoolCatalog(catalog: Catalog, ports: SubscriptionPoolCatalogPorts): Catalog {
  const pool = ports.readPool('openai');
  const aliases = pool?.legacyCodexAccounts;
  if (!aliases || pool.disconnected) return catalog;
  const accounts = new Set(pool.accounts.filter(account => !account.paused).map(account => account.id));
  const imported = catalog.providers.filter(provider => provider.auth.native === 'codex'
    && Object.hasOwn(aliases, provider.id) && accounts.has(aliases[provider.id])
    && ports.codexAccountState(provider.id).authenticated);
  if (!imported.length) return catalog;
  // Reuse these accounts' existing membership; do not discover an unrelated default CLI login.
  return { ...catalog, providers: catalog.providers.map(provider => {
    if (provider.id !== 'openai') return provider;
    const models = Object.fromEntries(provider.agents.map(agent => {
      const models = new Map((provider.models[agent] ?? []).map(model => [model.id, model]));
      for (const source of imported) for (const model of source.models[agent] ?? [])
        if (!models.has(model.id)) models.set(model.id, model);
      return [agent, [...models.values()]];
    }));
    return { ...provider, models };
  }) };
}
