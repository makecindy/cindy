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
