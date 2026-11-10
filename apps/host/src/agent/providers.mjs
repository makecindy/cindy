import { modelsWithoutStalePaymentUpsell } from '../../../desktop/src/main/model-access/modelsSyncRefresh.js';

const CACHE_MS = 5 * 60_000;

/** Refresh account facts only. The shared catalog owns provider projection.
 * @param {{ readProviders: (connected: boolean) => Promise<import('@cindy/model-providers').ProviderView[]>, fetchModels: (gateway: {endpoint: string, credential: string}) => Promise<any[]>, applyModels: (models: any[], options: {authoritative: boolean, preservePaymentRequiredRoutes?: boolean, suppressEmbeddingFallback?: boolean}) => void, readOwner?: () => { dataOwnerId: string | null, generation: number, pending: boolean } }} deps
 */
export function createProviderCatalog({ readProviders, fetchModels, applyModels, readOwner }) {
  let cached = null;
  let flight = null;
  let activeKey = null;
  return async function listProviders(options) {
    const initial = readOwner?.();
    const owner = { dataOwnerId: options.ownerId ?? null, ownerGeneration: initial?.generation ?? options.ownerGeneration ?? 0 };
    // In-memory identity of this connection, only ever compared for equality.
    // It is not a stored or verified secret, so it is not hashed.
    const key = JSON.stringify([
      owner.dataOwnerId, owner.ownerGeneration, options.gateway?.endpoint, options.gateway?.credential,
    ]);
    const checkOwner = () => {
      const current = readOwner?.();
      if (current && (current.pending || current.dataOwnerId !== owner.dataOwnerId || current.generation !== owner.ownerGeneration))
        throw new Error('PROVIDER_OWNER_CHANGED');
    };
    checkOwner();
    if (activeKey !== key) {
      activeKey = key;
      cached = null;
      // Clear account facts before awaiting their replacement.
      applyModels([], { authoritative: false, suppressEmbeddingFallback: true });
    }
    const check = () => {
      checkOwner();
      if (activeKey !== key) throw new Error('PROVIDER_CONNECTION_CHANGED');
    };
    let error;
    if (options.gateway && (!cached || Date.now() - cached.at >= CACHE_MS || options.force)) {
      if (flight?.key !== key) {
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
        error = 'Model access could not be refreshed. Try again.';
      }
    }
    check();
    applyModels(error ? modelsWithoutStalePaymentUpsell(cached?.models ?? []) : cached?.models ?? [], {
      authoritative: Boolean(cached),
      preservePaymentRequiredRoutes: Boolean(error && cached),
      suppressEmbeddingFallback: !cached,
    });
    const providers = await readProviders(Boolean(options.gateway));
    check();
    return { ...owner, providers, providerOrder: providers.map(provider => provider.id), ...(error ? { error } : {}) };
  };
}
