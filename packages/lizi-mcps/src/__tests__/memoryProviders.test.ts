import { expect, it, vi } from 'vitest';
import { MemoryToolRegistry } from '../cindy_memoryToolRegistry.js';
import { registerMemorySearchTool } from '../memory/search.js';
import type { MemoryMcpDeps } from '../types.js';

// Unit, production memory_search entry: existing coverage only exercises local
// storage. A plugin result must be inline, attributed, bounded and optional;
// rejection must leave the original Cindy response byte-for-byte unchanged.
it('merges selected provider memories through memory_search and preserves local results on failure', async () => {
  const own = [{ filename: 'reference_local.md', title: 'Local', snippet: 'own', score: -1, type: 'reference' }];
  const search = vi.fn(async () => own);
  const context = { sessionId: 'task', workingDir: '/unused', memoryScopeKey: 'fixture' };
  const searchProviders = vi.fn<NonNullable<MemoryMcpDeps['searchProviders']>>(async () => [{ id: 'remote', title: 'Provider', content: 'Full provider memory',
    sourcePlugin: { id: 'selected', name: 'Selected' } }]);
  const deps = { workdir: '/unused', getSessionContext: () => context, searchProviders,
    getManager: () => ({ isEnabled: () => true, getStore: async () => ({ search }) }),
  } as unknown as MemoryMcpDeps;
  const registry = new MemoryToolRegistry();
  registerMemorySearchTool(registry, deps);
  const result = await registry.call('memory_search', { query: 'word', limit: 2 });
  expect(result.isError).not.toBe(true);
  const data = JSON.parse((result.content[0] as { text: string }).text).data;
  expect(data.hits).toEqual([own[0], { id: 'remote', title: 'Provider', content: 'Full provider memory', sourcePlugin: { id: 'selected', name: 'Selected' } }]);
  expect(data.count).toBe(2);
  expect(searchProviders).toHaveBeenCalledWith('word', { limit: 2 }, context);
  const cut = { id: 'cut', title: 'Cut', content: 'bounded', truncated: true, sourcePlugin: { id: 'selected', name: 'Selected' } };
  searchProviders.mockResolvedValueOnce({ hits: [cut], truncated: true });
  const block = (await registry.call('memory_search', { query: 'word', limit: 2 })).content[0];
  if (!block || block.type !== 'text') throw new Error('Expected text memory result');
  const truncated = JSON.parse(block.text).data;
  expect(truncated.truncated).toBe(true);
  expect(truncated.hits[1]).toEqual(cut);
  searchProviders.mockRejectedValueOnce(new Error('provider crashed'));
  const failed = await registry.call('memory_search', { query: 'word' });
  const baseline = new MemoryToolRegistry();
  registerMemorySearchTool(baseline, { ...deps, searchProviders: undefined } as MemoryMcpDeps);
  expect(failed).toEqual(await baseline.call('memory_search', { query: 'word' }));
});
