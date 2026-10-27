import {
  installedGhostStoragePart,
  knownDeliveryNamespacesDiffer,
} from '../../shared/pluginIdentity.js';
import type { InstalledGhost } from '../../shared/ghost.js';
import type { PluginUsageIdentity } from '../../shared/pluginUsage.js';
import type { PluginMarketInstallationRecord } from '../plugin-market/ledger.js';
import {
  verifyInstalledMarketManifest,
  type InstalledMarketManifestIdentity,
} from '../plugin-market/installedManifestIdentity.js';

/** Distribution identity and trust labels are independent. Custom public scope stays custom. */
export function pluginUsageIdentity(
  ghost: InstalledGhost,
  record: PluginMarketInstallationRecord | null,
  installedIdentity: InstalledMarketManifestIdentity | null,
  serverRoot: string,
): PluginUsageIdentity | null {
  if (ghost.approval.state !== 'approved') return null;
  const base: PluginUsageIdentity = {
    ghostId: installedGhostStoragePart(ghost),
    displayName: ghost.manifest.name,
    revision: ghost.approval.revision,
    sourceKind: 'manual',
    stableKey: null,
    pluginId: null,
    organizationId: null,
    sourceKey: null,
    serverRoot: null,
    version: ghost.manifest.version ?? null,
    releaseId: null,
  };
  if (
    !record?.installed ||
    record.ghostId !== ghost.manifest.id ||
    knownDeliveryNamespacesDiffer(ghost, record) ||
    !installedIdentity ||
    !verifyInstalledMarketManifest(record, installedIdentity)
  )
    return base;
  if (record.source === 'git-market' || record.source === 'local-market') {
    if (!record.sourceKey) return base;
    return {
      ...base,
      sourceKind: record.source,
      sourceKey: record.sourceKey,
      stableKey: JSON.stringify([record.source, record.sourceKey, base.ghostId]),
      releaseId: record.releaseId,
    };
  }
  const verifiedRoot = typeof record.serverRoot === 'string' ? record.serverRoot : undefined;
  if (!verifiedRoot && !serverRoot) return base;
  return {
    ...base,
    sourceKind: 'server',
    reportingScope: record.scope,
    verifiedServerRoot: verifiedRoot,
    pluginId: record.pluginId,
    organizationId: record.organizationId,
    serverRoot: verifiedRoot || serverRoot,
    stableKey: JSON.stringify(['server', verifiedRoot || serverRoot, record.pluginId]),
    releaseId: record.releaseId,
  };
}
