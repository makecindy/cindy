import type { GhostManifest, GhostSetupAssessment } from '../../shared/ghost.js';
import type { GhostOauthAccountManager } from './ghostOauthAccounts.js';
import type { GhostConnectionManager } from './ghostConnections.js';
import type { GhostKvStore } from './ghostKvStore.js';
import { evaluateGhostSetupAssessment, type GhostSetupProbes } from './ghostSetupStatus.js';
import { assessGhostHostSetupRequirements } from './ghostHostSetupRequirementsCore.js';
import { appendReadyGhostOauthReauthSuggest, findGhostOauthReauthSuggest } from './ghostOauthScopeStaleness.js';

export interface PluginSetupStores {
  secretSaved(storeId: string, key: string): boolean;
  oauth: Pick<GhostOauthAccountManager, 'listAccounts' | 'clientConfigured' | 'defaultMissingScopes'>;
  connections: Pick<GhostConnectionManager, 'list'>;
  kv: Pick<GhostKvStore, 'readStrict'>;
}

/** Both launchers inspect the same encrypted records and declared storage keys.
 * A failed read remains an error, never an empty or ready configuration. */
export function pluginSetupProbes(stores: PluginSetupStores, storeId: string, manifest: GhostManifest): GhostSetupProbes {
  let kvSnapshot: Record<string, unknown> | null = null;
  return {
    secretSaved: key => stores.secretSaved(storeId, key),
    oauthStatus: key => {
      const decl = manifest.network?.secrets?.find(secret => secret.key === key)?.oauth;
      const accounts = stores.oauth.listAccounts(storeId, key);
      return {
        clientConfigured: stores.oauth.clientConfigured(storeId, key, decl),
        connected: accounts.filter(account => account.status === 'connected').length,
        expired: accounts.filter(account => account.status === 'expired').length,
      };
    },
    connectionCount: key => stores.connections.list(storeId, key).length,
    kvValue: key => {
      kvSnapshot ??= stores.kv.readStrict(storeId);
      return kvSnapshot[key];
    },
  };
}

export function pluginOauthReauthSuggestion(oauth: PluginSetupStores['oauth'], storeId: string, manifest: GhostManifest) {
  return findGhostOauthReauthSuggest(manifest, (key, decl) => {
    const account = oauth.listAccounts(storeId, key).find(item => item.isDefault);
    return account?.status === 'expired' ? [] : oauth.defaultMissingScopes(storeId, key, decl);
  });
}

export function assessPluginSetup(input: {
  translate(key: string): string;
  manifest: GhostManifest;
  probes: GhostSetupProbes;
  revision: number;
  clientConfigReady(configId: string): boolean;
  reauthSuggestion(): ReturnType<typeof pluginOauthReauthSuggestion>;
}): GhostSetupAssessment {
  const assessment = evaluateGhostSetupAssessment(input.manifest, input.probes, {
    revision: input.revision,
    strict: true,
    additionalGroups: assessGhostHostSetupRequirements(input.manifest, { clientConfigReady: input.clientConfigReady }, input.translate),
  });
  return assessment.state === 'ready'
    ? appendReadyGhostOauthReauthSuggest(assessment, input.reauthSuggestion())
    : assessment;
}
