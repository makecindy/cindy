import { describe, expect, it } from 'vitest';
import type { PluginInstanceRecord, PluginInstanceReceiptFact } from '../pluginInstanceRegistry';
import type { PluginMarketInstallationRecord } from '../../plugin-market/ledger';
import { projectPluginPublishingSource } from '../pluginPublishingSource';

const record: PluginInstanceRecord = { instanceKey: '_root__example', contentRelId: '_ns/_root/example',
  ghostId: 'example', namespace: null, namespaceState: 'confirmed', source: 'manual', pluginId: null,
  receiptRevision: 'revision', packageSha256: 'a'.repeat(64), active: true };
const receipt: PluginInstanceReceiptFact = { ghostId: 'example', hasNamespace: true, namespace: null,
  revision: 'revision', packageSha256: 'a'.repeat(64) };
const market: PluginMarketInstallationRecord = { pluginId: 'public-id', ghostId: 'example', namespace: null,
  releaseId: 'release', version: '1.0.0', sha256: 'a'.repeat(64), scope: 'public', organizationId: null,
  source: 'market', installed: true, updatedAt: '2026-10-20T00:00:00.000Z' };
describe('publishing provenance does not grant authorship', () => {
  it('permits a verified local package path but refuses unreadable evidence and legacy guesses', () => {
    expect(projectPluginPublishingSource(record, receipt, { kind: 'absent' })).toEqual({ kind: 'local', source: 'manual' });
    expect(projectPluginPublishingSource(record, undefined, { kind: 'absent' }).kind).toBe('unavailable');
    expect(projectPluginPublishingSource(record, receipt, { kind: 'invalid' }).kind).toBe('unavailable');
    expect(projectPluginPublishingSource({ ...record, source: 'legacy' }, receipt, { kind: 'absent' }).kind).toBe('unavailable');
    expect(projectPluginPublishingSource(record, { ...receipt, revision: 'replacement' }, { kind: 'absent' }).kind).toBe('unavailable');
  });
  it.each(['git-market', 'local-market'] as const)('does not turn %s installation into first publication', source => {
    expect(projectPluginPublishingSource(record, receipt, { kind: 'found', record: { ...market, source } }).kind).toBe('unavailable');
  });
  it('requires the exact public market identity and approved bytes, independently of publishing ACL', () => {
    const installed = { ...record, source: 'market' as const, pluginId: market.pluginId };
    expect(projectPluginPublishingSource(installed, receipt, { kind: 'found', record: market })).toEqual({ kind: 'public-market', pluginId: market.pluginId });
    expect(projectPluginPublishingSource({ ...installed, pluginId: 'other' }, receipt, { kind: 'found', record: market }).kind).toBe('unavailable');
    expect(projectPluginPublishingSource(installed, receipt, { kind: 'absent' }).kind).toBe('unavailable');
    expect(projectPluginPublishingSource(installed, receipt, { kind: 'found', record: { ...market, scope: 'personal' } }).kind).toBe('unavailable');
  });
});


it('projects local authoring identity without treating it as an enterprise or a market source', () => {
  const local = { ...record, namespace: 'local', instanceKey: '_ns__local__example', contentRelId: '_ns/local/example' };
  expect(projectPluginPublishingSource(local, { ...receipt, namespace: 'local' }, { kind: 'absent' }))
    .toEqual({ kind: 'local', source: 'manual' });
  expect(projectPluginPublishingSource(local, receipt, { kind: 'absent' }).kind).toBe('unavailable');
});

// Card/source display is separate from publishing authority. Evidence conflicts
// must never remove the warning on a local replacement (unit / Host projection).
it('projects display source from the current receipt and exact installation ledger', async () => {
  const { projectPluginInstallationSource: project } = await import('../pluginPublishingSource');
  const installed = { ...record, source: 'market' as const, pluginId: market.pluginId };
  expect(project(installed, receipt, { kind: 'found', record: market })).toEqual({ kind: 'market' });
  expect(project(record, receipt, { kind: 'found', record: market })).toEqual({ kind: 'local' });
  expect(project(installed, { ...receipt, revision: 'old' }, { kind: 'found', record: market })).toEqual({ kind: 'unknown' });
  expect(project(installed, receipt, { kind: 'invalid' })).toEqual({ kind: 'unknown' });
  for (const source of ['git-market', 'local-market'] as const) {
    expect(project(installed, receipt, { kind: 'found', record: { ...market, source, sourceKey: 'local:fixture' } })).toEqual({ kind: 'third-party' });
  }
  const org = { ...installed, namespace: 'acme' };
  const orgReceipt = { ...receipt, namespace: 'acme' };
  const orgMarket = { ...market, namespace: 'acme', scope: 'organization' as const, organizationId: 'acme-id' };
  expect(project(org, orgReceipt, { kind: 'found', record: orgMarket })).toEqual({ kind: 'organization', namespace: 'acme' });
  expect(project(org, { ...orgReceipt, installOrigin: 'manual' }, { kind: 'found', record: orgMarket })).toEqual({ kind: 'local' });
  expect(project({ ...record, source: 'legacy' }, receipt, { kind: 'absent' })).toEqual({ kind: 'unknown' });
});
