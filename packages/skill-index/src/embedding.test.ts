import { describe, expect, it, vi } from 'vitest';
import { EmbeddingClient } from '@cindy/embedding-client';
import { createSkillEmbeddingAdapter, type SkillEmbeddingConfig } from './embedding.js';

// Test value: the real adapter/client must send only selected metadata to the configured
// endpoint, preserve vector ordering, and reject invalid credentials/configuration/results.
// Existing desktop wire tests cover catalog models, not this explicit custom-model entry.
// Minimal input: two texts with reversed response indices; missing env key; wrong dimensions.
// Tier: unit, injected fetch/Response only (no socket, external API or developer credentials).
const config: SkillEmbeddingConfig = {
  baseUrl: 'https://embeddings.invalid/v1',
  model: 'custom-multilingual',
  dimensions: 2,
  apiKeyEnv: 'TEST_EMBEDDING_KEY',
};

function response(vectors: number[][], model = config.model) {
  return new Response(JSON.stringify({
    model,
    data: vectors.map((embedding, index) => ({ index, embedding })).reverse(),
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

describe('explicit Skill embedding transport', () => {
  it('uses the configured endpoint and environment key, preserving input order', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => response([[1, 0], [0, 1]]));
    const adapter = createSkillEmbeddingAdapter(config, {
      env: { TEST_EMBEDDING_KEY: 'invalid-test-key' }, fetchImpl,
    });
    expect(await adapter.embed(['photo', 'sound'], 'document')).toEqual([[1, 0], [0, 1]]);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://embeddings.invalid/v1/embeddings');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer invalid-test-key');
    expect(JSON.parse(String(init?.body))).toEqual({
      model: config.model, input: ['photo', 'sound'], dimensions: 2,
    });
    expect(adapter.identity).not.toContain('invalid-test-key');
  });

  it('uses identical protocol semantics for query/document, including catalog-shaped model names', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => response([[1, 0]], 'voyage/voyage-4'));
    const env = { TEST_EMBEDDING_KEY: 'invalid-first-key' };
    const adapter = createSkillEmbeddingAdapter({ ...config, model: 'voyage/voyage-4' }, { env, fetchImpl });
    await adapter.embed(['photo'], 'document');
    env.TEST_EMBEDDING_KEY = 'invalid-second-key';
    await adapter.embed(['photo'], 'query');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchImpl.mock.calls) {
      expect(JSON.parse(String(init?.body))).not.toHaveProperty('input_type');
    }
    expect(new Headers(fetchImpl.mock.calls[1]![1]?.headers).get('authorization')).toBe('Bearer invalid-second-key');
  });

  it('invalidates index identity for endpoint/model/dimension changes, not credentials or URL spelling', () => {
    const identity = createSkillEmbeddingAdapter(config).identity;
    expect(createSkillEmbeddingAdapter({ ...config, baseUrl: 'https://embeddings.invalid/' }).identity).toBe(identity);
    expect(createSkillEmbeddingAdapter({ ...config, apiKeyEnv: 'OTHER_KEY' }).identity).toBe(identity);
    for (const change of [
      { baseUrl: 'https://other.invalid' }, { model: 'other' }, { dimensions: 3 },
    ]) {
      expect(createSkillEmbeddingAdapter({ ...config, ...change }).identity).not.toBe(identity);
    }
  });

  it('does not call the API without the configured environment key or with empty input', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const adapter = createSkillEmbeddingAdapter(config, { env: {}, fetchImpl });
    expect(await adapter.embed([], 'document')).toEqual([]);
    await expect(adapter.embed(['photo'], 'query')).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('serializes large refreshes into bounded batches without truncating or reordering', async () => {
    let active = 0;
    let peak = 0;
    const sizes: number[] = [];
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      peak = Math.max(peak, ++active);
      const input = JSON.parse(String(init?.body)).input as string[];
      sizes.push(input.length);
      await Promise.resolve();
      active--;
      return response(input.map((text) => [Number(text), 1]));
    });
    const adapter = createSkillEmbeddingAdapter(config, { env: { TEST_EMBEDDING_KEY: 'invalid-key' }, fetchImpl });
    const texts = Array.from({ length: 65 }, (_, index) => String(index));
    expect(await adapter.embed(texts, 'document')).toEqual(texts.map((text) => [Number(text), 1]));
    expect(sizes).toEqual([32, 32, 1]);
    expect(peak).toBe(1);
  });

  it('bounds a nonresponding endpoint and clears its request timer', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn<typeof fetch>().mockImplementation((_url, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      }));
      const adapter = createSkillEmbeddingAdapter(config, { env: { TEST_EMBEDDING_KEY: 'invalid-key' }, fetchImpl });
      const pending = expect(adapter.embed(['photo'], 'query')).rejects.toMatchObject({ code: 'TIMEOUT' });
      await vi.advanceTimersByTimeAsync(30_000);
      await pending;
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    { dimensions: 0 }, { dimensions: 1.5 }, { model: ' ' }, { apiKeyEnv: 'a=b' },
    { baseUrl: 'https://user:password@embeddings.invalid' },
    { baseUrl: 'https://embeddings.invalid?key=secret' }, { baseUrl: 'file:///private' },
  ])('rejects invalid or credential-bearing configuration: %j', (change) => {
    expect(() => createSkillEmbeddingAdapter({ ...config, ...change })).toThrow();
  });

  it('keeps dimension and response-index checks on custom models', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => response([[1, 2, 3]]));
    const adapter = createSkillEmbeddingAdapter(config, { env: { TEST_EMBEDDING_KEY: 'invalid-key' }, fetchImpl });
    await expect(adapter.embed(['photo'], 'document')).rejects.toMatchObject({ code: 'INVALID_MODEL' });
    fetchImpl.mockImplementation(async () => new Response(JSON.stringify({
      data: [{ index: 0, embedding: [1, 0] }, { index: 0, embedding: [0, 1] }],
    }), { status: 200 }));
    await expect(adapter.embed(['photo', 'sound'], 'document')).rejects.toMatchObject({ code: 'SERVER_ERROR' });
  });

  it('does not widen the existing catalog-only embed entry', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const client = new EmbeddingClient({ baseUrl: 'https://embeddings.invalid', getApiKey: () => 'invalid-key', fetchImpl });
    await expect(client.embed({ texts: ['photo'], model: 'custom-multilingual' as never })).rejects.toMatchObject({ code: 'INVALID_MODEL' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('retains custom-model opt-in when an inconsistent cached batch must be fetched again', async () => {
    let width = 2;
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const input = JSON.parse(String(init?.body)).input as string[];
      return response(input.map(() => Array.from({ length: width }, () => 1)));
    });
    const client = new EmbeddingClient({ baseUrl: 'https://embeddings.invalid', getApiKey: () => 'invalid-key', fetchImpl });
    await client.embedOpenAICompatible({ texts: ['photo'], model: config.model });
    width = 3;
    await client.embedOpenAICompatible({ texts: ['sound'], model: config.model });
    const result = await client.embedOpenAICompatible({ texts: ['photo', 'sound'], model: config.model });
    expect(result.embeddings).toEqual([[1, 1, 1], [1, 1, 1]]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});
