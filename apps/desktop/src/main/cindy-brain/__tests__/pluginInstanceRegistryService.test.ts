import { describe, expect, it, vi } from 'vitest';

import {
  emptyPluginInstanceRegistry,
  selectMarketPluginIdForInstance,
  type PluginInstanceRegistry,
  type PluginInstanceRegistryStore,
} from '../pluginInstanceRegistry.js';
import {
  pendingCensusMismatches,
  PluginInstanceRegistryService,
} from '../pluginInstanceRegistryService.js';

const NOW = '2026-10-08T00:00:00.000Z';

function memoryStore(initial: PluginInstanceRegistry): PluginInstanceRegistryStore & { snapshot(): PluginInstanceRegistry } {
  let current = initial;
  return {
    read: () => ({ kind: 'ok', registry: current }),
    write(registry) { current = registry; },
    discardCorrupt: () => false,
    snapshot: () => current,
  };
}

function service(options: {
  registry: PluginInstanceRegistry;
  relIds?: string[];
  log?: { warn(message: string, meta?: Record<string, unknown>): void };
  receiptRevision?: string;
  marketIdentityForInstance?: (instance: {
    ghostId: string;
    contentRelId: string;
    namespace: string | null;
    packageSha256: string | null;
  }) => { pluginId: string } | null;
}) {
  const store = memoryStore(options.registry);
  const created = new PluginInstanceRegistryService({
    ensureOwner: () => {},
    registryStore: () => store,
    listContentEntries: () => (options.relIds ?? []).map((relId) => ({ relId, dir: relId })),
    receiptFact: (relId) => ({
      ghostId: relId,
      hasNamespace: false,
      namespace: null,
      revision: options.receiptRevision ?? 'rev-1',
      packageSha256: 'ab'.repeat(32),
    }),
    censusCandidates: () => [],
    readApproval: () => ({ state: 'missing' }),
    recordLegacyEligibility: () => {},
    marketIdentityForInstance: options.marketIdentityForInstance,
    log: options.log,
  });
  return { created, store };
}

describe('plugin instance registry service', () => {
  it('returns the stored census allowlist', () => {
    const registry: PluginInstanceRegistry = {
      ...emptyPluginInstanceRegistry(),
      census: { completedAt: NOW, pendingRelIds: ['hello'] },
    };
    const { created } = service({ registry, relIds: ['hello'] });
    expect(created.ensureCensus()?.pendingRelIds).toEqual(['hello']);
    const synced = created.sync();
    expect(synced.instances.hello?.namespaceState).toBe('pending');
    expect(pendingCensusMismatches(synced, 'strict')).toEqual([]);
  });

  it('reports a pending row that is missing from the census allowlist', () => {
    const registry: PluginInstanceRegistry = {
      ...emptyPluginInstanceRegistry(),
      census: { completedAt: NOW, pendingRelIds: [] },
      instances: {
        hello: {
          instanceKey: 'hello',
          contentRelId: 'hello',
          ghostId: 'hello',
          namespace: null,
          namespaceState: 'pending',
          pluginId: null,
          source: 'legacy',
          receiptRevision: 'rev-1',
          packageSha256: null,
          active: true,
        },
      },
    };
    expect(pendingCensusMismatches(registry)).toEqual(['hello:pending-but-not-listed']);
    // Repeated scans of one defect should not flood logs; periodic summaries
    // and a new owner/cache lifecycle still report the outstanding problem.
    const warn = vi.fn();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    try {
      const options = { registry, relIds: ['hello'], log: { warn }, receiptRevision: 'rev-1' };
      const { created } = service(options);
      created.sync();
      created.sync();
      created.sync();
      expect(warn).toHaveBeenCalledTimes(1);
      clock.mockReturnValue(301_000);
      created.sync();
      expect(warn).toHaveBeenLastCalledWith(expect.any(String), {
        mismatches: ['hello:pending-but-not-listed'], repeatedChecks: 3,
      });
      created.sync();
      created.sync();
      options.receiptRevision = 'rev-2';
      created.sync();
      expect(warn).toHaveBeenCalledTimes(3);
      // A changed receipt is a new anomaly, not another repeat of the old one.
      expect(warn).toHaveBeenLastCalledWith(expect.any(String), {
        mismatches: ['hello:pending-but-not-listed'], repeatedChecks: 1,
      });
      created.clear();
      created.sync();
      expect(warn).toHaveBeenCalledTimes(4);
    } finally {
      clock.mockRestore();
    }
  });

  // Unit regression for PR #6667: even suppressed warnings used to search
  // every instance again for each mismatch. Count record reads through sync(),
  // not wall-clock time; the existing single-row test cannot expose this cost.
  it('bounds mismatch diagnostic work by the number of registered instances', () => {
    const relIds = Array.from({ length: 8 }, (_, index) => `plugin-${index}`);
    let relIdReads = 0;
    const registry: PluginInstanceRegistry = {
      ...emptyPluginInstanceRegistry(),
      census: { completedAt: NOW, pendingRelIds: [] },
      instances: Object.fromEntries(relIds.map((relId) => [relId, {
        instanceKey: relId,
        get contentRelId() { relIdReads += 1; return relId; },
        ghostId: relId,
        namespace: null,
        namespaceState: 'pending' as const,
        pluginId: null,
        source: 'legacy' as const,
        receiptRevision: 'rev-1',
        packageSha256: null,
        active: true,
      }])),
    };
    const warn = vi.fn();
    const { created } = service({ registry, log: { warn } });
    const scan = {
      listContentEntries: () => [],
      receiptFact: () => null,
      isPresenceUnknown: () => true,
    };
    for (let round = 0; round < 2; round += 1) {
      relIdReads = 0;
      created.sync(scan);
      expect(relIdReads).toBeLessThanOrEqual(relIds.length * 5);
    }
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(expect.any(String), {
      mismatches: relIds.map((relId) => `${relId}:pending-but-not-listed`),
      repeatedChecks: 1,
    });
  });
});

describe('market identity backfill', () => {
  const sha = 'ab'.repeat(32);
  function row(overrides: Partial<PluginInstanceRegistry['instances'][string]> = {}) {
    return {
      instanceKey: 'helper',
      contentRelId: 'helper',
      ghostId: 'helper',
      namespace: null,
      namespaceState: 'pending' as const,
      pluginId: null,
      source: 'manual' as const,
      receiptRevision: 'rev-1',
      packageSha256: sha,
      active: true,
      ...overrides,
    };
  }

  it('writes the only installed market plugin id onto an unlabeled upgrade', () => {
    const registry: PluginInstanceRegistry = {
      ...emptyPluginInstanceRegistry(),
      census: { completedAt: NOW, pendingRelIds: ['helper'] },
      instances: { helper: row() },
    };
    const { created, store } = service({
      registry,
      relIds: ['helper'],
      marketIdentityForInstance: () => ({ pluginId: 'plugin-a' }),
    });
    created.sync();
    expect(store.snapshot().instances.helper).toMatchObject({
      pluginId: 'plugin-a',
      source: 'market',
    });
  });

  it('does not relabel forge or builtin installs', () => {
    const registry: PluginInstanceRegistry = {
      ...emptyPluginInstanceRegistry(),
      census: { completedAt: NOW, pendingRelIds: ['helper', '_ns/_root/builtin-helper'] },
      instances: {
        helper: row({ source: 'agent-forge' }),
        '_root__builtin-helper': row({
          instanceKey: '_root__builtin-helper',
          contentRelId: '_ns/_root/builtin-helper',
          ghostId: 'builtin-helper',
          source: 'builtin',
        }),
      },
    };
    const { created, store } = service({
      registry,
      relIds: ['helper', '_ns/_root/builtin-helper'],
      marketIdentityForInstance: (instance) => ({ pluginId: instance.ghostId + '-market' }),
    });
    created.sync();
    const next = store.snapshot();
    expect(next.instances.helper).toMatchObject({ pluginId: null, source: 'agent-forge' });
    expect(next.instances['_root__builtin-helper']).toMatchObject({ pluginId: null, source: 'builtin' });
  });

  it('does not give a manual root the enterprise plugin id of the same ghost id', () => {
    const sha = 'ab'.repeat(32);
    const registry: PluginInstanceRegistry = {
      ...emptyPluginInstanceRegistry(),
      census: { completedAt: NOW, pendingRelIds: ['helper'] },
      instances: {
        helper: row({ source: 'manual', packageSha256: sha }),
        '_ns__xd__helper': row({
          instanceKey: '_ns__xd__helper',
          contentRelId: '_ns/xd/helper',
          namespace: 'xd',
          namespaceState: 'confirmed',
          source: 'manual',
          packageSha256: sha,
        }),
      },
    };
    const records = [{
      pluginId: 'plugin-org',
      ghostId: 'helper',
      installed: true,
      namespace: 'xd',
      scope: 'organization',
      organizationId: 'org-xd',
      sha256: sha,
    }];
    const { created, store } = service({
      registry,
      relIds: ['helper', '_ns/xd/helper'],
      marketIdentityForInstance: (instance) => {
        const pluginId = selectMarketPluginIdForInstance(instance, records);
        return pluginId ? { pluginId } : null;
      },
    });
    created.sync();
    const next = store.snapshot();
    expect(next.instances.helper).toMatchObject({ pluginId: null, source: 'manual' });
    expect(next.instances['_ns__xd__helper']).toMatchObject({ pluginId: 'plugin-org', source: 'market' });
  });

  it('does not drop existing records when publish runs before the cache is loaded', () => {
    const registry: PluginInstanceRegistry = {
      ...emptyPluginInstanceRegistry(),
      census: { completedAt: NOW, pendingRelIds: [] },
      instances: {
        other: {
          instanceKey: 'other',
          contentRelId: 'other',
          ghostId: 'other',
          namespace: null,
          namespaceState: 'confirmed',
          pluginId: null,
          source: 'manual',
          receiptRevision: 'rev-1',
          packageSha256: 'ab'.repeat(32),
          active: true,
        },
      },
    };
    const store = memoryStore(registry);
    const created = new PluginInstanceRegistryService({
      ensureOwner: () => {},
      registryStore: () => store,
      listContentEntries: () => [{ relId: 'other', dir: 'other' }],
      receiptFact: () => ({
        ghostId: 'other',
        hasNamespace: true,
        namespace: null,
        revision: 'rev-1',
        packageSha256: 'ab'.repeat(32),
      }),
      censusCandidates: () => [],
      readApproval: () => ({ state: 'missing' }),
      recordLegacyEligibility: () => {},
    });
    created.publish({
      instanceKey: '_ns__acme__helper',
      contentRelId: '_ns/acme/helper',
      ghostId: 'helper',
      namespace: 'acme',
      namespaceState: 'confirmed',
      pluginId: 'plugin-helper',
      source: 'market',
      receiptRevision: 'rev-2',
      packageSha256: 'cd'.repeat(32),
      active: true,
    });
    const saved = store.snapshot();
    expect(saved.instances.other?.namespaceState).toBe('confirmed');
    expect(saved.instances['_ns__acme__helper']?.namespace).toBe('acme');
  });
});
