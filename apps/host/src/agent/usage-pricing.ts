import { createAccountCurrencyStore } from '../../../desktop/src/main/usage/accountCurrencyStoreCore.ts';
import { createModelPricing } from '../../../desktop/src/main/usage/modelPricingCore.ts';
import { getReferenceModelPricing } from '../../../desktop/src/main/usage/referenceModelPricingCore.ts';
import { resolveOwnerScopedSecretStorageKey } from '../../../desktop/src/main/secrets/providerSecretOwnerKey.ts';
import { explicitPorts } from './explicit-ports.ts';

/**
 * The Host's XD gateway price projection and reference prices (release table row 13, unit 3a): the
 * desktop's own modelPricing / accountCurrencyStore cores, one instance each per Host process (one
 * account per process, main.ts ensureRuntime).
 *
 * Ports, as the desktop shells bind them (usage/modelPricing.ts, usage/accountCurrencyStore.ts):
 * - app.getPath('userData'): the Host profile, where the desktop keeps the same `cache/` files.
 * - BrowserWindow: no windows. The Host has no push channel for usage yet (row 13, 3f); readers ask
 *   /api/usage/* again.
 * - getClientEndpoint('modelAccessApiBaseUrl'): the account region's Model Access endpoint, the one
 *   main.ts fetches /models from; unavailable throws as main.ts does, as the desktop's endpoint
 *   service throws before it is initialized.
 * - resolveOwnerScopedSecretStorageKey: the desktop's own function. The Host keeps provider keys in the
 *   same `safe-storage/<owner_…_key>.enc` files (credentials/store.mjs, agent/provider-config.ts), so
 *   the key identity in the cache scope is the desktop's.
 *
 * Prices are fed by the provider catalog (providers.mjs applyPricedModels) only where the desktop's
 * applyGatewayModels runs: a successful /models round and an account boundary.
 */
export function createHostUsagePricing(options: {
  profileDir: string;
  /** The Model Access endpoint for the current account region, or nothing when unavailable. */
  modelAccessApiBaseUrl(): string | undefined;
}) {
  const app = { getPath: () => options.profileDir };
  const currency = createAccountCurrencyStore(explicitPorts<Parameters<typeof createAccountCurrencyStore>[0]>({ app }));
  const pricing = createModelPricing(explicitPorts<Parameters<typeof createModelPricing>[0]>({
    app,
    BrowserWindow: { getAllWindows: () => [] },
    getClientEndpoint: () => {
      const baseUrl = options.modelAccessApiBaseUrl();
      if (!baseUrl) throw new Error('Model access endpoint is unavailable');
      return baseUrl;
    },
    resolveOwnerScopedSecretStorageKey,
    hydrateAccountCurrency: (...args) => currency.hydrateAccountCurrency(...args),
    noteActiveAccount: (...args) => currency.noteActiveAccount(...args),
    rememberAccountCurrency: (...args) => currency.rememberAccountCurrency(...args),
  }));
  return {
    ...pricing,
    /** `maker:usage:reference-model-pricing`: the catalog reference prices and user overrides. */
    readReferenceModelPricing: () => getReferenceModelPricing(),
  };
}

export type HostUsagePricing = ReturnType<typeof createHostUsagePricing>;
