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
  it('records legacy root directories without rewriting existing rows', () => {
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
      candidates: [
        { ghostId: 'hello', relId: 'hello' },
        { ghostId: 'kept', relId: 'kept', identitySource: { namespace: 'acme' } },
        { ghostId: 'later', relId: '_ns/_root/later' },
      ],
      now: NOW,
      readApproval: () => ({ state: 'missing' }),
      recordLegacyEligibility: () => { throw new Error('missing approval is not recaptured'); },
    });
    expect(stamped?.census).toEqual({ completedAt: NOW, pendingRelIds: ['hello'] });
    expect(stamped?.instances.hello?.namespaceState).toBe('unconfirmed');
    expect(stamped?.instances.kept?.namespaceState).toBe('confirmed');
  });

  it('does not allocate rows for a fresh census', () => {
    const stamped = stampInstanceCensus({
      registry: emptyPluginInstanceRegistry(),
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
