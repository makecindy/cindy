import { GhostManager } from '../../../desktop/src/main/cindy-brain/GhostManager.js';
import { loadGhostFirstPartyFactsLoader } from '../../../desktop/src/main/cindy-brain/ghostFirstPartyFacts.js';
import { authorizeGhostTokenBroker } from '../../../desktop/src/main/cindy-brain/ghostFirstPartyPrivilege.js';
import { loadConnectionAudienceResolver } from '../../../desktop/src/main/cindy-brain/connectionAudienceResolver.js';
import { PluginMarketLedger } from '../../../desktop/src/main/plugin-market/ledger.js';
import { createOrganizationPrefixStore } from '../../../desktop/src/main/plugin-market/organizationPrefixStore.js';
import { installedMarketManifestIdentity } from '../../../desktop/src/main/plugin-market/installedManifestIdentity.js';
import { readInstalledGhostManifestSnapshot } from '../../../desktop/src/main/installedGhostManifest.js';
import { deliveryNamespaceFields, parsePluginInstanceId } from '../../../desktop/src/shared/pluginIdentity.js';
import { GHOST_INSTALL_MANIFEST_MAX_BYTES, type InstalledGhost } from '../../../desktop/src/shared/ghost.js';
import type { User as AuthUser } from '../../../desktop/src/shared/authUser.js';

/** The same receipt/market/organization evidence used by Desktop. Plugin names
 * and caller-provided namespaces cannot establish a privileged identity. */
export function createHostPluginIdentity(options: {
  manager: GhostManager;
  root(...parts: string[]): string;
  getGhost(id: string): InstalledGhost | null;
  getUser(): AuthUser | null;
  assertCurrent(): void;
}) {
  const { manager, getGhost, root, assertCurrent } = options;
  const ledger = new PluginMarketLedger(() => { assertCurrent(); return root('plugin-market', 'ledger.v1.json'); });
  const target = (id: string) => {
    const ghost = getGhost(id);
    return ghost ? { ghostId: ghost.manifest.id, ...deliveryNamespaceFields(ghost) }
      : parsePluginInstanceId(id) ?? { ghostId: id };
  };
  const common = {
    readApprovedPackageSha256: (id: string) => manager.approvedInstallEvidence(id)?.packageSha256 ?? null,
    readInstallOrigin: (id: string) => manager.readEffectiveInstallOrigin(id),
    readInstallNamespace: (id: string) => manager.readDeliveryNamespace(id),
    readNamespaceState: (id: string) => manager.readNamespaceState(id),
    isPendingLegacyNamespace: (id: string) => manager.isPendingLegacyNamespace(id),
    isPendingLegacyForge: (id: string) => manager.isPendingLegacyForge(id),
    lookupOrganizationPrefix: (orgId: string) => createOrganizationPrefixStore(root('plugin-market', 'organization.v1.json')).lookup(orgId),
  };
  const firstParty = loadGhostFirstPartyFactsLoader({ ...common,
    readInstalledBuiltin: id => getGhost(id)?.builtin === true,
    readMarketInstallation: id => ledger.installationForAuthorization(target(id)),
    readLegacyFirstPartyEligible: id => manager.readLegacyFirstPartyEligible(id),
    readTrustedSource: id => {
      const ghost = getGhost(id);
      const evidence = manager.approvedInstallEvidence(id);
      if (!ghost?.builtin || ghost.trust?.level !== 'cindy-official' || !evidence?.packageSha256) return null;
      return { kind: 'builtin-official', ghostId: ghost.manifest.id, namespace: ghost.namespace ?? null,
        packageSha256: evidence.packageSha256 };
    },
  });
  const audience = loadConnectionAudienceResolver({ ...common,
    readMarketInstallation: id => ledger.lookupInstallationForOidc(target(id)),
    readInstalledManifestIdentity: id => {
      const ghost = getGhost(id); if (!ghost) return null;
      const snapshot = readInstalledGhostManifestSnapshot(ghost.dir, GHOST_INSTALL_MANIFEST_MAX_BYTES);
      return snapshot.ok ? installedMarketManifestIdentity(snapshot.snapshot) : null;
    },
  });
  return {
    brokerAuthorized(id: string) {
      assertCurrent();
      const user = options.getUser();
      return authorizeGhostTokenBroker(id, firstParty.load(id, 'runtime', {
        membershipKind: user?.membershipKind ?? 'personal', orgId: user?.orgId ?? null, orgSlug: user?.orgSlug ?? null,
      }));
    },
    connectionAudience(id: string) {
      assertCurrent();
      const user = options.getUser();
      return user ? audience.resolve(id, { membershipId: user.id, membershipKind: user.membershipKind,
        orgId: user.orgId, orgSlug: user.orgSlug }) : null;
    },
  };
}
