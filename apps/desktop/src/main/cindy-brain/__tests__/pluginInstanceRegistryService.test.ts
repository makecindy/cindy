import { describe, expect, it } from 'vitest';

import {
  emptyPluginInstanceRegistry,
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
  marketIdentityForGhost?: (ghostId: string) => { pluginId: string } | null;
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
      revision: 'rev-1',
      packageSha256: 'ab'.repeat(32),
    }),
    censusCandidates: () => [],
    readApproval: () => ({ state: 'missing' }),
    recordLegacyEligibility: () => {},
    marketIdentityForGhost: options.marketIdentityForGhost,
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
          receiptRevision: null,
          packageSha256: null,
          active: true,
        },
      },
    };
    expect(pendingCensusMismatches(registry)).toEqual(['hello:pending-but-not-listed']);
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
      marketIdentityForGhost: () => ({ pluginId: 'plugin-a' }),
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
      marketIdentityForGhost: (ghostId) => ({ pluginId: ghostId + '-market' }),
    });
    created.sync();
    const next = store.snapshot();
    expect(next.instances.helper).toMatchObject({ pluginId: null, source: 'agent-forge' });
    expect(next.instances['_root__builtin-helper']).toMatchObject({ pluginId: null, source: 'builtin' });
  });
});
