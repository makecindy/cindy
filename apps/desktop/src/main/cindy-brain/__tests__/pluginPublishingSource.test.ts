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
