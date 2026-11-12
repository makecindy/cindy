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
