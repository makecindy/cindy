import { describe, expect, it, vi } from 'vitest';
import { mergeDiscoveredRuntimeModels, type CustomProviderConfig } from '@cindy/model-providers';

describe('model source projection after a process restart', () => {
  it('withholds persisted sources until this process discovers them, including interrupted credential writes', async () => {
    const sources = await import('../model-source-snapshots');
    const catalog = await import('../active-catalog');
    const discovered = sources.issueModelSourceSnapshot([{
      id: 'chatgpt/foo', name: 'Foo', opaqueModelId: true,
      discoveredSource: { kind: 'magpie', providerId: 'Account A' },
    }], 'pi', 'credential-A');
    const persisted: CustomProviderConfig = { id: 'restart-source', name: 'Gateway', auth: { method: 'none' },
      runtimes: { pi: { baseUrl: 'http://127.0.0.1:3425/v1', wireProtocol: 'openai-chat',
        models: mergeDiscoveredRuntimeModels([], discovered) } } };
    catalog.setCustomProviderConfigs([persisted]);
    const modelOf = (current: typeof catalog) =>
      current.getActiveCatalog().providers.find(p => p.id === persisted.id)!.models.pi![0];
    expect(modelOf(catalog).discoveredSource?.providerId).toBe('Account A');

    // Persisted DB bytes can survive after the credential store was changed but
    // before its config transaction completed. A new Main has no proof of A.
    const diskSnapshot = JSON.parse(JSON.stringify(persisted)) as CustomProviderConfig;
    // reset-modules: simulate a fresh Main process with a new provenance epoch and catalog cache.
    vi.resetModules();
    const restarted = await import('../active-catalog');
    restarted.setCustomProviderConfigs([diskSnapshot]);
    expect(modelOf(restarted).discoveredSource).toBeUndefined();
    expect(modelOf(restarted).userModelConfig?.discoveredSource).toBeUndefined();
    expect(modelOf(restarted).opaqueModelId).toBe(true);
    expect(diskSnapshot.runtimes.pi!.models[0].discoveredSource?.providerId).toBe('Account A');

    const refreshedSources = await import('../model-source-snapshots');
    const refreshed = refreshedSources.issueModelSourceSnapshot([{
      id: 'chatgpt/foo', name: 'Foo', opaqueModelId: true,
      discoveredSource: { kind: 'magpie', providerId: 'Account B' },
    }], 'pi', 'credential-B');
    restarted.setCustomProviderConfigs([{ ...diskSnapshot, runtimes: { pi: {
      ...diskSnapshot.runtimes.pi!, models: mergeDiscoveredRuntimeModels(diskSnapshot.runtimes.pi!.models, refreshed),
    } } }]);
    expect(modelOf(restarted).discoveredSource?.providerId).toBe('Account B');
    catalog.setCustomProviderConfigs([]);
    restarted.setCustomProviderConfigs([]);
  });
});
