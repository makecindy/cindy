import path from 'node:path';
import { createHash } from 'node:crypto';
import { createLedgerCurrency } from '@cindy/app-runtime/ledgerCurrency';
import { createAccountCurrencyStore } from '@cindy/app-runtime/accountCurrencyStore';
import { createGatewayModelPricing } from '@cindy/app-runtime/modelPricing';
import { createByokPricing } from '@cindy/app-runtime/byokPricing';
import { createAccountReferencePrice } from '@cindy/app-runtime/accountReferencePrice';
import { createModelPriceOverrideStore } from '@cindy/app-runtime/modelPriceOverrideStore';
import { createReferenceModelPricing } from '@cindy/app-runtime/referenceModelPricing';
import { createSubscriptionValuePrice } from '@cindy/app-runtime/subscriptionValuePrice';
import type { DbLogger } from '@cindy/runtime-db/logging';
import type { TerminalModelConfig } from './config.js';

/** Only storage, owner identity and transport differ from the graphical host. */
export function createTerminalPricing(options: {
  profileDir: string;
  region: 'cn' | 'global';
  models: TerminalModelConfig;
  logger: DbLogger;
  getOwnerId(): string | null;
  assertCurrent(): void;
  emit(channel: string, payload: unknown): void;
}) {
  let endpoint: () => string = () => '';
  let accountId = options.getOwnerId;
  const userDataDirectory = () => { options.assertCurrent(); return options.profileDir; };
  const getCurrentDbClientUserId = () => { options.assertCurrent(); return accountId(); };
  const createLogger = () => options.logger;
  const getActiveCatalog = () => { options.assertCurrent(); return options.models.catalogRuntime.getActiveCatalog(); };
  const broadcast = (channel: string, payload: unknown) => { options.assertCurrent(); options.emit(channel, payload); };
  const ledger = createLedgerCurrency();
  const account = createAccountCurrencyStore({ ...ledger, userDataDirectory, getCurrentDbClientUserId, createLogger });
  const gateway = createGatewayModelPricing({ ...ledger, ...account, userDataDirectory, getCurrentDbClientUserId, createLogger,
    CURRENT_CINDY_REGION: options.region,
    getClientEndpoint: () => endpoint(),
    currentKeyCacheIdentity: () => {
      options.assertCurrent();
      const key = options.models.gatewayCredentials()?.apiKey;
      // Scope compares credential identity; the secret itself never enters the cache.
      return key ? 'key=' + createHash('sha256').update(key).digest('hex') : 'key=missing';
    }, broadcast,
  });
  const byok = createByokPricing();
  const reference = createAccountReferencePrice({ getActiveCatalog });
  const overrides = createModelPriceOverrideStore({
    providerReferencePriceQuote: reference.accountReferencePriceQuote,
    ownerScopedUserDataPath: (...parts) => path.join(userDataDirectory(), ...parts),
    log: options.logger, currentLedgerCurrency: ledger.currentLedgerCurrency,
  });
  const prices = createReferenceModelPricing({ ...overrides, ...byok, getActiveCatalog,
    providerReferencePriceQuote: reference.accountReferencePriceQuote, broadcast });
  return { ...ledger, ...account, ...gateway, ...byok, ...overrides, ...prices, ...createSubscriptionValuePrice(prices),
    bindGatewayEndpoint(readEndpoint: () => string, readAccountId: () => string | null) { endpoint = readEndpoint; accountId = readAccountId; },
  };
}
export type TerminalPricing = ReturnType<typeof createTerminalPricing>;
