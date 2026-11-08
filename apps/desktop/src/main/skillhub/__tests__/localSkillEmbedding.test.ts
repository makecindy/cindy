import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { EmbeddingClient } from '@cindy/embedding-client';
import { SkillIndex } from '@cindy/skill-index';
import { EmbeddingService } from '../../embedding-host/EmbeddingService';
import { createLocalSkillEmbeddingAdapter } from '../localSkillEmbedding';

// Production adapter -> EmbeddingService -> real EmbeddingClient, with only fetch and the
// desktop route setting injected. Protects bounded native API calls and explicit rebuilds
// after a server alias changes; CLI batching tests do not execute this host route.
// Minimal failures: 65 entries; identical metadata rebuilt after v1 -> v2. Unit, no DB/network.
vi.mock('../../utility-model/oneShotCandidates', () => ({
  isProviderModelRouteDisabled: () => false,
  isProviderRouteSuspended: () => false,
}));

function fixture() {
  const state = { model: 'backend-v1', active: 0, peak: 0 };
  const batches: string[][] = [];
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    state.peak = Math.max(state.peak, ++state.active);
    const input = JSON.parse(String(init?.body)).input as string[];
    batches.push(input);
    await Promise.resolve();
    state.active--;
    return new Response(JSON.stringify({ model: state.model,
      data: input.map((text, index) => ({ index, embedding: [text.length, state.model === 'backend-v1' ? 1 : 2] })),
    }), { status: 200 });
  });
  const client = new EmbeddingClient({ baseUrl: 'https://embedding.invalid', getApiKey: () => 'invalid-test-key', fetchImpl });
  const service = new EmbeddingService({
    getClient: () => client,
    getDbClient: () => { throw new Error('Synchronous embeddings must not read the database'); },
    isVecAvailable: () => false,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
  });
  const adapter = createLocalSkillEmbeddingAdapter('text-embedding-3-small', () => service);
  return { state, batches, fetchImpl, client, service, adapter };
}

describe('native local Skill embeddings', () => {
  it('serializes 65 entries into 32/32/1 HTTP batches and preserves every vector', async () => {
    const f = fixture();
    const texts = Array.from({ length: 65 }, (_, i) => `skill-${i}`);
    expect(await f.adapter.embed(texts, 'document')).toEqual({ vectors: texts.map(text => [text.length, 1]), modelUsed: 'backend-v1' });
    expect(f.batches.map(batch => batch.length)).toEqual([32, 32, 1]);
    expect(f.batches.flat()).toEqual(texts);
    expect(f.state.peak).toBe(1);
  });

  it('rebuilds identical metadata against the current server model instead of its LRU copy', async () => {
    const f = fixture();
    const index = new SkillIndex();
    index.sync([{ id: 'video', name: 'video', description: 'Extract subtitles', source: 'library', filePath: path.resolve('video', 'SKILL.md') }]);
    await index.buildVectors(f.adapter);
    expect(await index.buildVectors(f.adapter)).toEqual({ embedded: 0, reused: 1 });
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
    f.state.model = 'backend-v2';
    await index.buildVectors(f.adapter, { rebuild: true });
    expect(f.fetchImpl).toHaveBeenCalledTimes(2);
    expect(index.snapshot().vectorModel).toBe('backend-v2');
    expect(index.snapshot().entries[0]!.vector?.[1]).toBe(2);
  });

  it('keeps ordinary consumers cacheable while native Skill queries see the current alias', async () => {
    const f = fixture();
    const input = { modelId: 'text-embedding-3-small' as const, inputType: 'query' as const };
    await f.service.embedSync(['video'], input);
    expect((await f.service.embedSync(['video'], input)).cacheHits).toBe(1);
    f.state.model = 'backend-v2';
    expect((await f.adapter.embed(['video'], 'query')).modelUsed).toBe('backend-v2');
    expect(f.fetchImpl).toHaveBeenCalledTimes(2);
    expect((await f.service.embedSync(['video'], input)).modelUsed).toBe('backend-v1');
    expect(f.fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each(['model', 'owner'] as const)('keeps the previous complete index when %s changes between batches', async (changed) => {
    const f = fixture();
    const index = new SkillIndex();
    index.sync(Array.from({ length: 65 }, (_, i) => ({
      id: `skill-${i}`, name: `skill-${i}`, description: `Task ${i}`, source: 'library', filePath: path.resolve(`skill-${i}`, 'SKILL.md'),
    })));
    await index.buildVectors(f.adapter);
    const before = index.snapshot();
    f.fetchImpl.mockClear();
    let batch = 0;
    const adapter = createLocalSkillEmbeddingAdapter('text-embedding-3-small', () => {
      if (++batch === 2) {
        if (changed === 'owner') throw new Error('Account changed');
        f.state.model = 'backend-v2';
      }
      return f.service;
    });
    await expect(index.buildVectors(adapter, { rebuild: true })).rejects.toThrow(changed === 'owner' ? 'Account changed' : 'Embedding model changed between batches');
    expect(f.fetchImpl).toHaveBeenCalledTimes(changed === 'owner' ? 1 : 2);
    expect(index.snapshot()).toEqual(before);
  });
});
