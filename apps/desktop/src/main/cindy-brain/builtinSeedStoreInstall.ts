import path from 'node:path';
import { hasDeliveryNamespace, installedGhostPhysicalRelId, installedGhostStoragePart } from '../../shared/pluginIdentity.js';
import { GHOST_INSTALL_MANIFEST_MAX_BYTES, type InstalledGhost } from '../../shared/ghost.js';
import { readInstalledGhostManifestSnapshot } from '../installedGhostManifest.js';
import { installedMarketManifestIdentity, verifyInstalledMarketManifest } from '../plugin-market/installedManifestIdentity.js';
import type { PluginMarketLedger, PluginMarketInstallationRecord } from '../plugin-market/ledger.js';
import type { GhostManager } from './GhostManager.js';
import type { BuiltinStoreInstallFact } from './builtinGhostProvisioner.js';

/** Resolve provenance for the physical directory selected by the provisioner, never by bare name. */
export function builtinSeedStoreInstall(
  id: string,
  installedDir: string,
  deps: { rootDir: string; manager: GhostManager; ledger: PluginMarketLedger },
): BuiltinStoreInstallFact | null {
  const relId = path.relative(deps.rootDir, installedDir).split(path.sep).join('/');
  const instance = deps.manager.readInstanceForContent(relId);
  if (instance && (!instance.active || instance.ghostId !== id)) {
    throw new Error('Builtin installation identity changed');
  }
  const receipt = deps.manager.readApprovedInstallReceipt(relId);
  let namespace: string | null;
  if (instance && instance.namespaceState !== 'pending') {
    namespace = instance.namespace;
    if (instance.namespaceState === 'unconfirmed' && namespace === null) {
      throw new Error('Builtin installation namespace is unconfirmed');
    }
  } else if (!instance && receipt && hasDeliveryNamespace(receipt)) {
    namespace = receipt.namespace;
  } else {
    // An old bundled install may predate receipts. The migration lookup only
    // vetoes replacement: it never selects another namespace or grants identity.
    const candidates = deps.ledger.createNamespaceMigrationLookup()(id);
    if (candidates.kind === 'invalid' ||
        (candidates.kind === 'found' && candidates.records.some(record => record.installed))) {
      throw new Error('Builtin installation namespace awaits market evidence');
    }
    return null;
  }
  const lookup = deps.ledger.lookupInstallationForAuthorization({ ghostId: id, namespace });
  if (lookup.kind === 'invalid') throw new Error('Plugin market ledger is unreadable');
  const record = lookup.kind === 'found' ? lookup.record : null;
  if (record && instance?.pluginId && instance.pluginId !== record.pluginId) {
    throw new Error('Builtin installation market resource conflicts with registry');
  }
  if (!record?.installed || record.ghostId !== id ||
      (record.source !== 'market' && record.source !== 'legacy-adopted') ||
      (hasDeliveryNamespace(record) && record.namespace !== namespace)) {
    if (namespace !== null) throw new Error('Non-root installation is not owned by builtin provisioning');
    return null;
  }
  const snapshot = readInstalledGhostManifestSnapshot(installedDir, GHOST_INSTALL_MANIFEST_MAX_BYTES);
  const evidence = deps.manager.approvedInstallEvidence(relId);
  return {
    version: record.version,
    // Bundled publication creates a root receipt. It must never replace an
    // organization/local instance, even if a later bundle has a higher version.
    preserveInstance: namespace !== null,
    ownsInstalledBytes: snapshot.ok &&
      verifyInstalledMarketManifest(record, installedMarketManifestIdentity(snapshot.snapshot)) &&
      evidence?.packageSha256 === record.sha256,
  };
}

/** Retained market identity selects an update target, but never restores authorization. */
export function isRetainedSeedMarketTarget(
  ghost: InstalledGhost,
  record: PluginMarketInstallationRecord,
  manager: GhostManager,
): boolean {
  if (ghost.namespaceState !== 'unconfirmed' || typeof ghost.namespace !== 'string' ||
      ghost.namespace === 'local' || ghost.approval.state !== 'approved' ||
      record.namespace !== ghost.namespace || record.scope !== 'organization' || !record.organizationId ||
      !record.installed || (record.source !== 'market' && record.source !== 'legacy-adopted') ||
      record.ghostId !== ghost.manifest.id || installedGhostPhysicalRelId(ghost) !== ghost.manifest.id) return false;
  const instance = manager.readInstanceForContent(installedGhostPhysicalRelId(ghost));
  const receipt = manager.readApprovedInstallReceipt(installedGhostPhysicalRelId(ghost), ghost.approval.revision);
  return Boolean(instance?.active && instance.source === 'market' && instance.pluginId === record.pluginId &&
    instance.ghostId === record.ghostId && instance.instanceKey === installedGhostStoragePart(ghost) &&
    instance.namespace === record.namespace && instance.namespaceState === 'unconfirmed' &&
    receipt?.namespace === null && receipt.packageSha256);
}
