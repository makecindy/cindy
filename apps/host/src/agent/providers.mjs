import { modelsWithoutStalePaymentUpsell } from '../../../desktop/src/main/model-access/modelsSyncRefresh.js';

const CACHE_MS = 5 * 60_000;

/**
 * The XD model list while the credentials are held, as the desktop's onStatusChange applies it
 * (model-access/index.ts 433–441, applyGatewayModels → setXdGatewayModels): failed clears the list but
 * keeps the last payment refusals, so a task that was refused cannot pass the route guard through the
 * failure; disabled, unsupported and idle clear both and do not fall back to the bundled embedding list.
 */
const HELD_MODELS = Object.freeze({
  failed: Object.freeze({ authoritative: false, preservePaymentRequiredRoutes: true }),
  cleared: Object.freeze({ authoritative: false, suppressEmbeddingFallback: true }),
});

/** Refresh account facts only. The shared catalog owns provider projection.
 * @param {{ readProviders: (connected: boolean) => Promise<import('@cindy/model-providers').ProviderView[]>, fetchModels: (gateway: {endpoint: string, credential: string}) => Promise<any[]>, applyModels: (models: any[], options: {authoritative: boolean, preservePaymentRequiredRoutes?: boolean, suppressEmbeddingFallback?: boolean}) => void, readModels: () => readonly any[], markModelsUnknown?: () => void, readOwner?: () => { dataOwnerId: string | null, generation: number, pending: boolean }, applyPricedModels?: (models: any[], ownerId: string | undefined) => void, trackModelsSync?: (sync: Promise<unknown>) => void, isProfileHeld?: () => boolean }} deps
 *
 * `applyPricedModels` receives the XD price projection's input where the desktop's applyGatewayModels
 * replaces it (model-access/index.ts): a successful /models round and an account boundary (an empty
 * list). `applyModels` also runs on every read between rounds and after a failed round, where the
 * desktop keeps its last prices. `trackModelsSync` gets each round in flight, as the desktop's
 * trackGatewayModelPricingSync does, so billing waits briefly for it.
 *
 * The returned function also takes the account's credential status (`noteCredentialStatus`, fed by
 * the Host model access as the desktop's credential sync feeds model-access/index.ts onStatusChange);
 * while it holds them, reads apply its empty list instead of the cached one and start no round.
 */
export function createProviderCatalog({ readProviders, fetchModels, applyModels, readModels, markModelsUnknown, readOwner, applyPricedModels, trackModelsSync, isProfileHeld }) {
  let cached = null;
  let flight = null;
  let activeIdentity = null;
  let activeKey = null;
  // The account's credentials, as the desktop's onStatusChange reads them (see noteCredentialStatus):
  // null while usable; 'failed' for a temporary sync failure of the same account (it keeps its local
  // key and its last payment refusals); 'cleared' for disabled, unsupported or idle (no model access).
  let credentialHold = null;
  async function listProviders(options) {
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
        applyPricedModels?.([], owner.dataOwnerId ?? undefined);
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
    // No /models round while the credentials are held: the desktop starts one only on ok. Nor while a
    // desktop that opens this profile runs (coexistence plan A): a round writes the price snapshot and
    // ledger currency files the desktop shares, so the read answers from the list already held.
    if (options.gateway && !credentialHold && !isProfileHeld?.()
      && (!cached || Date.now() - cached.at >= CACHE_MS || options.force)) {
      if (flight?.key !== key) {
        // As the desktop's runModelsSync: once a new request starts, the last list still shows but
        // no longer proves that the account lacks a model; only this round's success restores that.
        markModelsUnknown?.();
        const pending = { key, promise: null };
        pending.promise = Promise.resolve().then(() => fetchModels(options.gateway)).then(models => {
          check();
          // A round that ends after the credentials were held proves nothing for them: it is dropped,
          // and the round after ok replaces it.
          if (credentialHold) return;
          cached = { at: Date.now(), models };
          applyPricedModels?.(models, owner.dataOwnerId ?? undefined);
        }).finally(() => { if (flight === pending) flight = null; });
        flight = pending;
        trackModelsSync?.(pending.promise);
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
    if (credentialHold) {
      applyModels([], HELD_MODELS[credentialHold]);
    } else if (error) {
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
  }
  /**
   * As the desktop's credential status handler (model-access/index.ts getSync onStatusChange): failed,
   * disabled, unsupported and idle clear the XD models (HELD_MODELS) and replace the XD prices with an
   * empty list, so a failed account's models and prices no longer show; ok brings them back through the
   * next /models round. Until ok no round starts (the key may be dead: disabled and unsupported never
   * come back without a new sync), and a round already in flight is dropped. The desktop starts the
   * round on ok itself (scheduleModelsSync); the Host's catalog is read on demand, so ok marks the last
   * round stale and the next read fetches. The desktop also clears its account tier here; the Host
   * keeps none (it reads only the models of a /models response).
   * @param {{ state: string }} status
   */
  listProviders.noteCredentialStatus = status => {
    if (status.state === 'ok') {
      if (!credentialHold) return;
      credentialHold = null;
      if (cached) cached = { ...cached, at: -Infinity };
      return;
    }
    const hold = status.state === 'failed' ? 'failed'
      : ['disabled', 'unsupported', 'idle'].includes(status.state) ? 'cleared' : null;
    if (!hold) return;
    credentialHold = hold;
    cached = null;
    applyModels([], HELD_MODELS[hold]);
    applyPricedModels?.([], undefined);
  };
  return listProviders;
}
