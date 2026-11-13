import { modelsWithoutStalePaymentUpsell } from '../../../desktop/src/main/model-access/modelsSyncRefresh.js';

const CACHE_MS = 5 * 60_000;

/** Refresh account facts only. The shared catalog owns provider projection.
 * @param {{ readProviders: (connected: boolean) => Promise<import('@cindy/model-providers').ProviderView[]>, fetchModels: (gateway: {endpoint: string, credential: string}) => Promise<any[]>, applyModels: (models: any[], options: {authoritative: boolean, preservePaymentRequiredRoutes?: boolean, suppressEmbeddingFallback?: boolean}) => void, readModels: () => readonly any[], markModelsUnknown?: () => void, readOwner?: () => { dataOwnerId: string | null, generation: number, pending: boolean } }} deps
 */
export function createProviderCatalog({ readProviders, fetchModels, applyModels, readModels, markModelsUnknown, readOwner }) {
  let cached = null;
  let flight = null;
  let activeIdentity = null;
  let activeKey = null;
  return async function listProviders(options) {
    const initial = readOwner?.();
    const owner = { dataOwnerId: options.ownerId ?? null, ownerGeneration: initial?.generation ?? options.ownerGeneration ?? 0 };
    // In-memory identity of this connection, only ever compared for equality.
    // It is not a stored or verified secret, so it is not hashed.
    const identity = JSON.stringify([owner.dataOwnerId, owner.ownerGeneration, options.gateway?.endpoint]);
    const key = JSON.stringify([identity, options.gateway?.credential]);
    const checkOwner = () => {
      const current = readOwner?.();
      if (current && (current.pending || current.dataOwnerId !== owner.dataOwnerId || current.generation !== owner.ownerGeneration))
        throw new Error('PROVIDER_OWNER_CHANGED');
    };
    checkOwner();
    if (activeIdentity !== identity) {
      // As the desktop's account boundary (model-access noteAuthState): another owner, generation or
      // endpoint must not see this list, so clear it before awaiting the replacement. The first
      // connection of the process has nothing to clear; like the desktop's cold start it keeps the
      // bundled embedding fallback until a round succeeds.
      if (activeIdentity !== null) {
        cached = null;
        applyModels([], { authoritative: false, suppressEmbeddingFallback: true });
      }
      activeIdentity = identity;
    }
    if (activeKey !== key) {
      // Only the gateway key changed: the same account rotated it. The desktop refetches after its
      // credential sync and keeps the last list and payment refusals meanwhile; so does the Host.
      activeKey = key;
      if (cached) cached = { ...cached, at: -Infinity };
    }
    const check = () => {
      checkOwner();
      if (activeKey !== key) throw new Error('PROVIDER_CONNECTION_CHANGED');
    };
    let error;
    if (options.gateway && (!cached || Date.now() - cached.at >= CACHE_MS || options.force)) {
      if (flight?.key !== key) {
        // As the desktop's runModelsSync: once a new request starts, the last list still shows but
        // no longer proves that the account lacks a model; only this round's success restores that.
        markModelsUnknown?.();
        const pending = { key, promise: null };
        pending.promise = Promise.resolve().then(() => fetchModels(options.gateway)).then(models => {
          check();
          cached = { at: Date.now(), models };
        }).finally(() => { if (flight === pending) flight = null; });
        flight = pending;
      }
      try { await flight.promise; }
      catch {
        check();
        // A failed round must not leave the last success fresh: a later read would otherwise restore
        // its authority without a successful round.
        if (cached) cached = { ...cached, at: -Infinity };
        error = 'Model access could not be refreshed. Try again.';
      }
    }
    check();
    if (error) {
      // As the desktop's failed runModelsSync: the current list stays for display without stale
      // payment advertising, non-authoritative, with its payment refusals.
      applyModels(modelsWithoutStalePaymentUpsell(readModels()), { authoritative: false, preservePaymentRequiredRoutes: true });
    } else {
      // Between refreshes the last success stays authoritative, as on the desktop.
      applyModels(cached?.models ?? [], { authoritative: Boolean(cached), suppressEmbeddingFallback: !cached });
    }
    const providers = await readProviders(Boolean(options.gateway));
    check();
    return { ...owner, providers, providerOrder: providers.map(provider => provider.id), ...(error ? { error } : {}) };
  };
}
