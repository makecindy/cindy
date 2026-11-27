import { isOrganizationPluginNamespace } from '../../shared/pluginIdentity.js';
import type { InstalledGhost } from '../../shared/ghost.js';
import type { PluginMarketAuthorizationLookup } from '../plugin-market/ledger.js';
import type { PluginInstanceRecord, PluginInstanceReceiptFact } from './pluginInstanceRegistry.js';

/** Rebuilt from existing Host facts; never grants authorship or changes installation state. */
export function projectPluginPublishingSource(
  record: PluginInstanceRecord,
  receipt: PluginInstanceReceiptFact | null | undefined,
  lookup: PluginMarketAuthorizationLookup,
): NonNullable<InstalledGhost['publishingSource']> {
  const unavailable = { kind: 'unavailable' } as const;
  if (!record.active || record.namespaceState !== 'confirmed' || isOrganizationPluginNamespace(record.namespace) ||
    !receipt || !receipt.hasNamespace || receipt.namespace !== record.namespace || receipt.ghostId !== record.ghostId ||
    receipt.revision !== record.receiptRevision || receipt.packageSha256 !== record.packageSha256 ||
    lookup.kind === 'invalid') return unavailable;
  const market = lookup.kind === 'found' ? lookup.record : null;
  if (market && (market.scope !== 'public' || market.organizationId !== null)) return unavailable;
  if (market?.installed && market.source !== 'market' && market.source !== 'legacy-adopted') return unavailable;
  if (record.source === 'manual' || record.source === 'agent-forge')
    return { kind: 'local', source: record.source };
  if (record.source === 'market' && market?.installed && market.namespace === null &&
    market.pluginId === record.pluginId && market.sha256 === receipt.packageSha256)
    return { kind: 'public-market', pluginId: market.pluginId };
  return unavailable;
}

/** Display only. A stale source record must not hide an exception warning. */
export function projectPluginInstallationSource(
  record: PluginInstanceRecord, receipt: PluginInstanceReceiptFact | null | undefined,
  lookup: PluginMarketAuthorizationLookup,
): NonNullable<InstalledGhost['installationSource']> {
  const unknown = { kind: 'unknown' } as const;
  if (!record.active || record.namespaceState !== 'confirmed' || !receipt || !receipt.hasNamespace ||
      receipt.namespace !== record.namespace || receipt.ghostId !== record.ghostId ||
      receipt.revision !== record.receiptRevision || !receipt.packageSha256 || receipt.packageSha256 !== record.packageSha256) return unknown;
  if (record.namespace === 'local' || record.source === 'manual' || record.source === 'agent-forge' ||
      receipt.installOrigin === 'manual' || receipt.installOrigin === 'agent-forge') return { kind: 'local' };
  if (record.source !== 'market' || lookup.kind !== 'found') return unknown;
  const market = lookup.record;
  if (!market.installed || market.ghostId !== record.ghostId || market.namespace !== record.namespace ||
      (record.pluginId !== null && record.pluginId !== market.pluginId)) return unknown;
  // Custom installs have no server package hash. The current registry/receipt
  // and exact source ledger identify them, but never confer market trust.
  if (market.source === 'git-market' || market.source === 'local-market')
    return market.sourceKey ? { kind: 'third-party' } : unknown;
  if (!['market', 'legacy-adopted'].includes(market.source) || market.sha256 !== receipt.packageSha256) return unknown;
  if (isOrganizationPluginNamespace(record.namespace)) return market.scope === 'organization' && market.organizationId
    ? { kind: 'organization', namespace: record.namespace! } : unknown;
  return record.namespace === null && market.scope === 'public' && market.organizationId === null && record.pluginId === market.pluginId
    ? { kind: 'market' } : unknown;
}
