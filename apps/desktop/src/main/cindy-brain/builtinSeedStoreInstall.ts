import path from 'node:path';
import { hasDeliveryNamespace, installedGhostPhysicalRelId, installedGhostStoragePart } from '../../shared/pluginIdentity.js';
import { GHOST_INSTALL_MANIFEST_MAX_BYTES, type InstalledGhost } from '../../shared/ghost.js';
import { readInstalledGhostManifestSnapshot } from '../installedGhostManifest.js';
import { installedMarketManifestIdentity, verifyInstalledMarketManifest } from '../plugin-market/installedManifestIdentity.js';
import type { PluginMarketLedger, PluginMarketInstallationRecord } from '../plugin-market/ledger.js';
import type { GhostManager } from './GhostManager.js';
import { fingerprintDirContent, type BuiltinStoreInstallFact } from './builtinGhostProvisioner.js';

/** Resolve provenance for the physical directory selected by the provisioner, never by bare name. */
export async function builtinSeedStoreInstall(
  id: string,
  installedDir: string,
  deps: { rootDir: string; manager: GhostManager; ledger: PluginMarketLedger; seedDir?: string },
): Promise<BuiltinStoreInstallFact | null> {
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
    // Pre-receipt seeds used this provisioning pass to obtain their first
    // receipt. Missing namespace alone must not deadlock that recovery. Only
    // exact current seed bytes with no retained market identity may proceed;
    // a name, a tombstone, or a newly backfilled directory is not provenance.
    const legacyIdentity = !instance || (instance.namespaceState === 'pending' &&
      instance.pluginId === null && (instance.source === 'legacy' ||
        (instance.source === 'manual' && deps.manager.approvedInstallEvidence(relId)?.legacyMigrated === true)));
    if (legacyIdentity && deps.seedDir && (!receipt ||
        (!hasDeliveryNamespace(receipt) && !receipt.packageSha256 && receipt.installOrigin !== 'agent-forge'))) {
      const market = deps.ledger.lookupInstallationsForNamespaceMigration(id);
      if (market.kind === 'invalid') throw new Error('Plugin market ledger is unreadable');
      if (market.kind !== 'found' || market.records.length === 0) {
        const seed = await fingerprintDirContent(deps.seedDir);
        const installed = await fingerprintDirContent(installedDir);
        if (!seed.hasNonRegularEntry && !installed.hasNonRegularEntry && seed.hash === installed.hash) return null;
      }
    }
    // Missing market records cannot establish root identity. Leave old pending
    // installations to the namespace migration instead of replacing their bytes
    // or publishing a root receipt (including audience/orphan reclamation).
    throw new Error('Builtin installation namespace awaits trusted evidence');
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
