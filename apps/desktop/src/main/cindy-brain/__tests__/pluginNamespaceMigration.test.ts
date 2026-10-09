import { describe, expect, it } from 'vitest';

import { buildUnconfirmedConfirmationEvidence } from '../pluginInstanceConfirmation.js';
import { stampInstanceCensus } from '../pluginNamespaceMigration.js';
import { emptyPluginInstanceRegistry, type PluginInstanceRecord } from '../pluginInstanceRegistry.js';

const NOW = '2026-10-08T00:00:00.000Z';

function row(overrides: Partial<PluginInstanceRecord> = {}): PluginInstanceRecord {
  return {
    instanceKey: 'hello',
    contentRelId: 'hello',
    ghostId: 'hello',
    namespace: null,
    namespaceState: 'unconfirmed',
    pluginId: null,
    source: 'legacy',
    receiptRevision: null,
    packageSha256: null,
    active: true,
    ...overrides,
  };
}

describe('stampInstanceCensus', () => {
  it('imports pending legacy rows and leaves a confirmed row alone', () => {
    const registry = {
      ...emptyPluginInstanceRegistry(),
      instances: {
        hello: row(),
        kept: row({
          instanceKey: 'kept', contentRelId: 'kept', ghostId: 'kept',
          namespace: 'acme', namespaceState: 'confirmed',
        }),
      },
    };
    const stamped = stampInstanceCensus({
      registry,
      legacy: {
        kind: 'ok',
        ledger: {
          schemaVersion: 1,
          censusedAt: NOW,
          entries: {
            hello: { ghostId: 'hello', relId: 'hello', capturedAt: NOW, status: 'pending' },
            gone: { ghostId: 'gone', relId: 'gone', capturedAt: NOW, status: 'pending' },
          },
        },
      },
      candidates: [{ ghostId: 'hello', relId: 'hello' }, { ghostId: 'kept', relId: 'kept' }],
      now: '2026-10-09T00:00:00.000Z',
      readApproval: () => ({ state: 'missing' }),
      recordLegacyEligibility: () => { throw new Error('import does not recapture'); },
    });
    expect(stamped?.census).toEqual({ completedAt: NOW, pendingRelIds: ['hello'] });
    expect(stamped?.instances.hello?.namespaceState).toBe('pending');
    expect(stamped?.instances.kept?.namespaceState).toBe('confirmed');
    expect(stamped?.instances.gone).toBeUndefined();
  });

  it('does not allocate rows for a fresh census', () => {
    const stamped = stampInstanceCensus({
      registry: emptyPluginInstanceRegistry(),
      legacy: { kind: 'missing' },
      candidates: [
        { ghostId: 'hello', relId: 'hello' },
        { ghostId: 'later', relId: '_ns/_root/later' },
      ],
      now: NOW,
      readApproval: () => ({ state: 'missing' }),
      recordLegacyEligibility: () => undefined,
    });
    expect(stamped?.census?.pendingRelIds).toEqual(['hello']);
    expect(stamped?.instances).toEqual({});
  });
});

describe('buildUnconfirmedConfirmationEvidence', () => {
  it('keeps an absent namespace field distinct from an explicit null', () => {
    const evidence = buildUnconfirmedConfirmationEvidence({
      rows: [{ installed: true, scope: 'organization', organizationId: 'org-xd', sha256: 'ab' }],
      record: row({ namespace: 'xd', namespaceState: 'unconfirmed' }),
      currentOrganization: { organizationId: 'org-xd', orgSlug: 'xd' },
      packageSha256: 'ab',
      forgeSelfTest: false,
    });
    expect(evidence.marketRecords?.[0]).not.toHaveProperty('namespace');
    const explicit = buildUnconfirmedConfirmationEvidence({
      rows: [{ installed: true, namespace: null, scope: 'public', organizationId: null, sha256: 'ab' }],
      record: row({ namespace: null }),
      currentOrganization: null,
      packageSha256: 'ab',
      forgeSelfTest: false,
    });
    expect(explicit.marketRecords?.[0]).toMatchObject({ namespace: null });
  });
});
