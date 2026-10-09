import { describe, expect, it, vi } from 'vitest';

import type { NamespaceMigrationLedgerRead } from '../pluginNamespaceMigration.js';
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
  legacy?: () => NamespaceMigrationLedgerRead;
  relIds?: string[];
}) {
  const legacy = options.legacy ?? vi.fn(() => {
    throw new Error('legacy ledger should not be read');
  });
  const store = memoryStore(options.registry);
  const created = new PluginInstanceRegistryService({
    ensureOwner: () => {},
    registryStore: () => store,
    readLegacyLedger: legacy,
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
  return { created, store, legacy };
}

describe('plugin instance registry service', () => {
  it('does not read the legacy ledger once the registry has a census', () => {
    const registry: PluginInstanceRegistry = {
      ...emptyPluginInstanceRegistry(),
      census: { completedAt: NOW, pendingRelIds: ['hello'] },
    };
    const { created, legacy } = service({ registry, relIds: ['hello'] });
    expect(created.ensureCensus()?.entries.hello?.status).toBe('pending');
    const synced = created.sync();
    expect(synced.instances.hello?.namespaceState).toBe('pending');
    expect(legacy).not.toHaveBeenCalled();
    expect(pendingCensusMismatches(synced, 'strict')).toEqual([]);
  });

  it('still refuses an unknown legacy schema when no census has been stored', () => {
    const { created, store } = service({
      registry: emptyPluginInstanceRegistry(),
      legacy: () => ({ kind: 'unknown-schema' }),
    });
    expect(created.ensureCensus()).toBeNull();
    expect(store.snapshot().census).toBeNull();
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
