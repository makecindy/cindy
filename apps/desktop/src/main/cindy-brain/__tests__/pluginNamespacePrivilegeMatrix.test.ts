import { describe, expect, it } from 'vitest';
import type { GhostManifest } from '../../../shared/ghost.js';
import { ghostManifestDigest, type PluginMarketInstallationRecord } from '../../plugin-market/ledger.js';
import { loadConnectionAudienceResolver } from '../connectionAudienceResolver.js';
import { confirmUnconfirmedInstances } from '../pluginInstanceConfirmation.js';
import {
  confirmUnconfirmedInstance,
  emptyPluginInstanceRegistry,
  upsertInstance,
  type PluginInstanceRecord,
  type PluginInstanceRegistry,
} from '../pluginInstanceRegistry.js';
import {
  loadGhostFirstPartyFactsLoader,
  type GhostFirstPartyFactsIdentity,
} from '../ghostFirstPartyFacts.js';
import {
  authorizeGhostHostPrimitive,
  authorizeGhostTokenBroker,
} from '../ghostFirstPartyPrivilege.js';

type State = 'confirmed' | 'pending' | 'unconfirmed' | 'unknown';
type Row = {
  label: string;
  ghostId: string;
  orgSlug: string;
  orgId: string;
  prefix: string;
  trustedNamespace: string | null;
  state: State;
  pending: boolean;
  broker: boolean;
  host: boolean;
  marketConnection: boolean;
  forgeConnection: boolean;
  forgeReason?: string;
};

const sha = 'a'.repeat(64);

function manifestFor(id: string): GhostManifest {
  return {
    schemaVersion: 2,
    id,
    name: id,
    version: '1.0.0',
    kind: 'chip',
    entry: 'index.js',
    network: {
      hosts: ['service.example'],
      secrets: [{
        key: 'cindy_identity',
        label: 'Cindy organization identity',
        source: 'oidc-token',
        inject: { header: 'Authorization', format: 'Bearer {value}', hosts: ['service.example'] },
      }],
    },
  };
}

function marketRow(id: string, orgId: string, namespace: string | null): PluginMarketInstallationRecord {
  const manifest = manifestFor(id);
  return {
    pluginId: 'plugin-' + id,
    ghostId: id,
    releaseId: 'release-1',
    version: '1.0.0',
    sha256: sha,
    scope: 'organization',
    organizationId: orgId,
    source: 'market',
    installed: true,
    updatedAt: '2026-10-12T00:00:00.000Z',
    namespace,
    manifestDigest: ghostManifestDigest(manifest),
    rawManifestSha256: ghostManifestDigest(manifest),
  };
}

function evaluate(row: Row) {
  const manifest = manifestFor(row.ghostId.includes('__') ? row.ghostId.split('__').at(-1)! : row.ghostId);
  const logicalId = manifest.id;
  const identity: GhostFirstPartyFactsIdentity = {
    membershipKind: 'org',
    orgId: row.orgId,
    orgSlug: row.orgSlug,
  };
  const recorded = row.state === 'confirmed' ? row.trustedNamespace : undefined;
  const factsLoader = loadGhostFirstPartyFactsLoader({
    readInstalledBuiltin: () => false,
    readMarketInstallation: () => marketRow(logicalId, row.orgId, row.trustedNamespace),
    readApprovedPackageSha256: () => sha,
    lookupOrganizationPrefix: () => ({ kind: 'known', pluginPrefix: row.prefix }),
    readInstallOrigin: () => 'manual',
    readInstallNamespace: () => recorded,
    readNamespaceState: () => row.state,
    isPendingLegacyNamespace: () => row.pending,
    isPendingLegacyForge: () => row.pending,
  });
  const loaded = factsLoader.load(row.ghostId, 'runtime', identity);
  const warnings: string[] = [];
  const connection = (origin: 'manual' | 'agent-forge') => loadConnectionAudienceResolver({
    readInstalledManifestIdentity: () => ({
      manifest,
      rawManifestSha256: ghostManifestDigest(manifest),
      legacyManifestDigest: ghostManifestDigest(manifest),
      legacyManifestDigests: [ghostManifestDigest(manifest)],
    }),
    readMarketInstallation: () => marketRow(logicalId, row.orgId, row.trustedNamespace),
    readApprovedPackageSha256: () => sha,
    readInstallOrigin: () => origin,
    readInstallNamespace: () => recorded,
    readNamespaceState: () => row.state,
    isPendingLegacyNamespace: () => row.pending,
    isPendingLegacyForge: () => row.pending,
    lookupOrganizationPrefix: () => ({ kind: 'known', pluginPrefix: row.prefix }),
    log: { info() {}, warn(_message, meta) { if (typeof meta?.reason === 'string') warnings.push(meta.reason); } },
  }).resolve(row.ghostId, {
    membershipId: 'member-1',
    membershipKind: 'org',
    orgId: row.orgId,
    orgSlug: row.orgSlug,
  });
  return {
    broker: authorizeGhostTokenBroker(row.ghostId, loaded),
    host: authorizeGhostHostPrimitive(row.ghostId, loaded),
    marketConnection: connection('manual') !== null,
    forgeConnection: connection('agent-forge') !== null,
    warnings,
  };
}

const rows: Row[] = [
  { label: 'old root confirmed', ghostId: 'helper', orgSlug: 'acme', orgId: 'org-acme', prefix: 'acme', trustedNamespace: null, state: 'confirmed', pending: false, broker: false, host: false, marketConnection: true, forgeConnection: true },
  { label: 'old root pending', ghostId: 'helper', orgSlug: 'acme', orgId: 'org-acme', prefix: 'acme', trustedNamespace: null, state: 'pending', pending: true, broker: true, host: false, marketConnection: true, forgeConnection: true },
  { label: 'old root unconfirmed', ghostId: 'helper', orgSlug: 'acme', orgId: 'org-acme', prefix: 'acme', trustedNamespace: null, state: 'unconfirmed', pending: false, broker: false, host: false, marketConnection: false, forgeConnection: false, forgeReason: 'installed-namespace-unconfirmed' },
  { label: 'new root confirmed', ghostId: '_root__helper', orgSlug: 'acme', orgId: 'org-acme', prefix: 'acme', trustedNamespace: null, state: 'confirmed', pending: false, broker: false, host: false, marketConnection: true, forgeConnection: true },
  { label: 'new root unconfirmed', ghostId: '_root__helper', orgSlug: 'acme', orgId: 'org-acme', prefix: 'acme', trustedNamespace: null, state: 'unconfirmed', pending: false, broker: false, host: false, marketConnection: false, forgeConnection: false, forgeReason: 'installed-namespace-unconfirmed' },
  { label: 'in-place org confirmed', ghostId: 'xd-feishu', orgSlug: 'xd', orgId: 'org-xd', prefix: 'xd', trustedNamespace: 'xd', state: 'confirmed', pending: false, broker: true, host: true, marketConnection: true, forgeConnection: true },
  { label: 'in-place org pending', ghostId: 'xd-feishu', orgSlug: 'xd', orgId: 'org-xd', prefix: 'xd', trustedNamespace: 'xd', state: 'pending', pending: true, broker: true, host: true, marketConnection: true, forgeConnection: true },
  { label: 'in-place org unconfirmed', ghostId: 'xd-feishu', orgSlug: 'xd', orgId: 'org-xd', prefix: 'xd', trustedNamespace: 'xd', state: 'unconfirmed', pending: false, broker: false, host: false, marketConnection: false, forgeConnection: false, forgeReason: 'installed-namespace-unconfirmed' },
  { label: 'namespaced org confirmed', ghostId: '_ns__acme__helper', orgSlug: 'acme', orgId: 'org-acme', prefix: 'acme', trustedNamespace: 'acme', state: 'confirmed', pending: false, broker: true, host: false, marketConnection: true, forgeConnection: true },
  { label: 'namespaced org unconfirmed', ghostId: '_ns__acme__helper', orgSlug: 'acme', orgId: 'org-acme', prefix: 'acme', trustedNamespace: 'acme', state: 'unconfirmed', pending: false, broker: false, host: false, marketConnection: false, forgeConnection: false, forgeReason: 'installed-namespace-unconfirmed' },
  { label: 'namespaced org unknown', ghostId: '_ns__acme__helper', orgSlug: 'acme', orgId: 'org-acme', prefix: 'acme', trustedNamespace: 'acme', state: 'unknown', pending: false, broker: true, host: false, marketConnection: false, forgeConnection: true },
];

describe('plugin namespace privilege matrix', () => {
  it.each(rows)('$label', (row) => {
    const actual = evaluate(row);
    expect({
      broker: actual.broker,
      host: actual.host,
      marketConnection: actual.marketConnection,
      forgeConnection: actual.forgeConnection,
    }).toEqual({
      broker: row.broker,
      host: row.host,
      marketConnection: row.marketConnection,
      forgeConnection: row.forgeConnection,
    });
    if (row.forgeReason) expect(actual.warnings).toContain(row.forgeReason);
  });

  it('restores broker access after an unconfirmed instance is confirmed', async () => {
    const record: PluginInstanceRecord = {
      instanceKey: '_ns__acme__helper',
      contentRelId: '_ns/acme/helper',
      ghostId: 'helper',
      namespace: 'acme',
      namespaceState: 'unconfirmed',
      pluginId: 'plugin-helper',
      source: 'market',
      receiptRevision: 'rev-1',
      packageSha256: sha,
      active: true,
    };
    expect(confirmUnconfirmedInstance(record, {
      marketRecords: [{
        namespace: 'acme',
        organizationId: 'org-acme',
        packageSha256: sha,
        scope: 'organization',
        installed: true,
      }],
      currentOrganization: { organizationId: 'org-acme', orgSlug: 'acme' },
      packageSha256: sha,
      forgeSelfTest: false,
    })).toEqual({ namespace: 'acme' });
    let registry: PluginInstanceRegistry = upsertInstance(emptyPluginInstanceRegistry(), record);
    const receipt = {
      id: 'helper',
      revision: 'rev-1',
      namespace: 'acme',
      packageSha256: sha,
      manifest: manifestFor('helper'),
      enabled: true,
    };
    await confirmUnconfirmedInstances({
      readEvidence: () => ({
        marketRecords: [{
          namespace: 'acme',
          organizationId: 'org-acme',
          packageSha256: sha,
          scope: 'organization',
          installed: true,
        }],
        currentOrganization: { organizationId: 'org-acme', orgSlug: 'acme' },
        packageSha256: sha,
        forgeSelfTest: false,
      }),
      isBlocked: () => false,
      sync: () => registry,
      ownerContextKey: () => 'owner',
      readApproval: () => ({ state: 'approved', receipt: receipt as never }),
      runExclusive: (body) => body(),
      contentPath: (relId) => relId,
      writeReceipt: async () => {},
      writeRegistry: (next) => { registry = next; },
    });
    expect(registry.instances[record.instanceKey]?.namespaceState).toBe('confirmed');
    const restored = evaluate({
      label: 'restored',
      ghostId: '_ns__acme__helper',
      orgSlug: 'acme',
      orgId: 'org-acme',
      prefix: 'acme',
      trustedNamespace: 'acme',
      state: 'confirmed',
      pending: false,
      broker: true,
      host: false,
      marketConnection: true,
      forgeConnection: true,
    });
    expect(restored.broker).toBe(true);
    expect(restored.marketConnection).toBe(true);
  });
});
