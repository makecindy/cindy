import { describe, expect, it, vi } from 'vitest';

import { buildUnconfirmedConfirmationEvidence } from '../pluginInstanceConfirmation.js';
import {
  canReclaimLegacyBareInstance,
  reconcilePendingNamespaceMigrations,
  stampInstanceCensus,
} from '../pluginNamespaceMigration.js';
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

describe('reconcilePendingNamespaceMigrations', () => {
  const census = { completedAt: NOW, pendingRelIds: ['hello'] };

  it('does not stop a plugin whose classification is still pending', async () => {
    const prepare = vi.fn(async () => true);
    const commit = vi.fn(async () => ({ ok: true as const }));
    await reconcilePendingNamespaceMigrations({
      ensureCensus: () => census,
      ownerContextKey: () => 'owner',
      preparePendingResident: prepare,
      readApproval: () => ({ state: 'legacy-unapproved' }),
      classify: () => ({ kind: 'pending', reason: 'awaiting-organization-namespace' }),
      commit,
      confirmUnconfirmed: async () => {},
    }, true);
    expect(prepare).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });

  it('restores a stopped resident when the commit fails', async () => {
    const settled = vi.fn();
    await reconcilePendingNamespaceMigrations({
      ensureCensus: () => census,
      ownerContextKey: () => 'owner',
      preparePendingResident: async () => true,
      onPendingResidentMigrationSettled: settled,
      readApproval: () => ({ state: 'legacy-unapproved' }),
      classify: () => ({ kind: 'commit', namespace: 'acme', basis: 'market-organization' }),
      commit: async () => ({ ok: false as const, reason: 'busy' }),
      confirmUnconfirmed: async () => {},
    }, true);
    expect(settled).toHaveBeenCalledWith('hello', false);
  });

  it('does not restore when the commit succeeds', async () => {
    const settled = vi.fn();
    await reconcilePendingNamespaceMigrations({
      ensureCensus: () => census,
      ownerContextKey: () => 'owner',
      preparePendingResident: async () => true,
      onPendingResidentMigrationSettled: settled,
      readApproval: () => ({ state: 'legacy-unapproved' }),
      classify: () => ({ kind: 'commit', namespace: 'acme', basis: 'market-organization' }),
      commit: async () => ({ ok: true as const }),
      confirmUnconfirmed: async () => {},
    }, true);
    expect(settled).toHaveBeenCalledWith('hello', true);
  });
});

describe('canReclaimLegacyBareInstance', () => {
  const org = { organizationId: 'org-acme', orgSlug: 'acme' };
  const removed = {
    pluginId: 'plugin-a',
    scope: 'organization' as const,
    source: 'market' as const,
    organizationId: 'org-acme',
    installed: false,
  };
  const reclaim = (
    records: Parameters<typeof canReclaimLegacyBareInstance>[0]['records'],
    currentOrganization: Parameters<typeof canReclaimLegacyBareInstance>[0]['currentOrganization'] = org,
    namespace = 'acme',
  ) => canReclaimLegacyBareInstance({ pluginId: 'plugin-a', namespace, records, currentOrganization });

  it('lets the same organization plugin take back its removed pre-namespace install', () => {
    expect(reclaim([removed])).toBe(true);
    expect(reclaim([{ ...removed, source: 'legacy-adopted' }])).toBe(true);
  });

  it.each([
    ['another plugin id', [{ ...removed, pluginId: 'plugin-b' }]],
    ['a record that is still installed', [{ ...removed, installed: true }]],
    ['a record written after namespaces', [{ ...removed, namespace: 'acme' }]],
    ['a root record', [{ ...removed, namespace: null }]],
    ['a public install', [{ ...removed, scope: 'public' as const, organizationId: null }]],
    ['a custom market install', [{ ...removed, source: 'git-market' as const }]],
    ['another organization', [{ ...removed, organizationId: 'org-other' }]],
    ['two records for the same plugin', [removed, { ...removed }]],
  ])('refuses %s', (_label, records) => {
    expect(reclaim(records)).toBe(false);
  });

  it('refuses when the current organization does not own the requested namespace', () => {
    expect(reclaim([removed], null)).toBe(false);
    expect(reclaim([removed], { organizationId: 'org-acme', orgSlug: null })).toBe(false);
    expect(reclaim([removed], org, 'other')).toBe(false);
  });
});
