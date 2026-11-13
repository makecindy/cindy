import type { Catalog } from '@cindy/model-providers';

import { getActiveCatalog, getActiveCatalogWithCodexModels } from '../../../desktop/src/main/maker-host/active-catalog.js';
import { filterLegacyGptContextProfiles } from '../../../desktop/src/main/maker-host/legacy-context-profiles.js';
import { createModelContextProviderResolver } from '../../../desktop/src/main/maker-host/modelContextProvider.js';
import { hasClaudeNativeLogin } from '../../../desktop/src/main/maker-host/claude-native-auth.js';
import type { ModelContextProviderResolver } from '../../../desktop/src/main/maker-host/engineModelResolvers.js';
import { filterProviderCatalogForAccount } from '../../../desktop/src/main/maker-host/provider-access-policy.js';
import { projectSubscriptionPoolCatalog } from '../../../desktop/src/main/maker-host/subscriptionPoolCatalog.js';
import { readMergedProviderAccount, accountProviderId } from '../../../desktop/src/main/subscription-accounts/placement.js';
import { readPool, readProviderBoundAccountIds } from '../../../desktop/src/main/subscription-accounts/store.js';
import { getAppCapabilities } from '../../../desktop/src/main/appCapabilities.js';

export interface HostModelContext {
  /** The catalog Host resolves models against; read on every call. */
  getSelectableCatalog(): Catalog;
  resolveContextProviderId: ModelContextProviderResolver;
}

/**
 * One catalog and context-provider resolver for every Host engine, so Claude,
 * Codex and the Codex proxy resolve a model's route the same way.
 *
 * The catalog is the desktop's user-selectable catalog (getDesktopSelectableCatalog
 * in createDesktopProviderService.ts): the account filter, then the subscription
 * pool projection. Tasks resolve against what the user can select, so the desktop
 * definition is the reference; that module needs Electron, so the one-line base
 * is repeated here and the projection is shared (subscriptionPoolCatalog.ts).
 */
export function createHostModelContext(ports: {
  readGatewayKey(): string | null;
  hasCodexOAuthLogin(): boolean;
  /** The Host's Codex account state, for the subscription pool projection. */
  codexAccountState(providerId: string): { authenticated: boolean };
  /** Throws when the owner that created this context is no longer current. */
  check?(): void;
}): HostModelContext {
  const check = ports.check ?? (() => {});
  return {
    getSelectableCatalog: () => {
      check();
      const base = filterProviderCatalogForAccount(getActiveCatalog(), {
        canUseCindyGateway: getAppCapabilities().canUseCindyGateway,
      });
      return filterLegacyGptContextProfiles(
        projectSubscriptionPoolCatalog(base, { readPool, codexAccountState: ports.codexAccountState,
          getActiveCatalogWithCodexModels, readMergedProviderAccount, accountProviderId, readProviderBoundAccountIds,
          // M2: subscription-pool Codex discovery is still a desktop runtime; see the release table.
          readSubscriptionPoolCodexModels: () => null }, false),
      );
    },
    resolveContextProviderId: createModelContextProviderResolver({
      readGatewayKey: ports.readGatewayKey, hasClaudeNativeLogin, hasCodexOAuthLogin: ports.hasCodexOAuthLogin,
    }),
  };
}
