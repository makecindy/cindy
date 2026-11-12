import type { Catalog } from '@cindy/model-providers';

import { getActiveCatalog } from '../../../desktop/src/main/maker-host/active-catalog.js';
import { filterLegacyGptContextProfiles } from '../../../desktop/src/main/maker-host/legacy-context-profiles.js';
import { createModelContextProviderResolver } from '../../../desktop/src/main/maker-host/modelContextProvider.js';
import { hasClaudeNativeLogin } from '../../../desktop/src/main/maker-host/claude-native-auth.js';
import type { ModelContextProviderResolver } from '../../../desktop/src/main/maker-host/engineModelResolvers.js';

export interface HostModelContext {
  /** The catalog Host resolves models against; read on every call. */
  getSelectableCatalog(): Catalog;
  resolveContextProviderId: ModelContextProviderResolver;
}

/**
 * One catalog and context-provider resolver for every Host engine, so Claude,
 * Codex and the Codex proxy resolve a model's route the same way.
 */
export function createHostModelContext(ports: {
  readGatewayKey(): string | null;
  hasCodexOAuthLogin(): boolean;
  /** Throws when the owner that created this context is no longer current. */
  check?(): void;
}): HostModelContext {
  const check = ports.check ?? (() => {});
  return {
    getSelectableCatalog: () => { check(); return filterLegacyGptContextProfiles(getActiveCatalog()); },
    resolveContextProviderId: createModelContextProviderResolver({
      readGatewayKey: ports.readGatewayKey, hasClaudeNativeLogin, hasCodexOAuthLogin: ports.hasCodexOAuthLogin,
    }),
  };
}
