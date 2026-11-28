/** Desktop account readers shared by provider views and Pi's startup/refresh catalog. */
import type { Catalog } from '@cindy/model-providers';
import { readPool, readProviderBoundAccountIds } from '../subscription-accounts/store.js';
import { accountProviderId, readMergedProviderAccount } from '../subscription-accounts/placement.js';
import { readSubscriptionPoolClaudeModels, readSubscriptionPoolCodexModels } from '../subscription-accounts/runtime.js';
import { getActiveCatalog, getActiveCatalogWithClaudeModels, getActiveCatalogWithCodexModels } from './active-catalog.js';
import { codexAccountState } from './codex-account-auth.desktop.js';
import { projectSubscriptionPoolCatalog as projectWithPorts } from './subscriptionPoolCatalog.js';

export function projectDesktopSubscriptionPoolCatalog(catalog: Catalog, routingCatalog = false,
  include?: (provider: Catalog['providers'][number]) => boolean, includeLastConfirmed = false,
): Catalog {
  return projectWithPorts(catalog, {
    readPool: (...args) => readPool(...args),
    codexAccountState: (...args) => codexAccountState(...args),
    readSubscriptionPoolCodexModels: (...args) => readSubscriptionPoolCodexModels(...args),
    getActiveCatalogWithCodexModels: (...args) => getActiveCatalogWithCodexModels(...args),
    readSubscriptionPoolClaudeModels: (...args) => readSubscriptionPoolClaudeModels(...args),
    getActiveCatalogWithClaudeModels: (...args) => getActiveCatalogWithClaudeModels(...args),
    readMergedProviderAccount: (...args) => readMergedProviderAccount(...args),
    accountProviderId: (...args) => accountProviderId(...args),
    readProviderBoundAccountIds: (...args) => readProviderBoundAccountIds(...args),
  }, routingCatalog, include, includeLastConfirmed);
}

/** Full routing membership retains metadata needed by bound historical tasks. */
export function getDesktopProviderModelAccessCatalog(): Catalog {
  return projectDesktopSubscriptionPoolCatalog(getActiveCatalog(), true);
}
