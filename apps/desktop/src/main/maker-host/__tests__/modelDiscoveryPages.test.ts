import { describe, expect, it, vi } from 'vitest';
import { collectModelDiscoveryPages } from '../model-discovery-pages.js';

const endpoint = 'https://models.example/v1/models';
describe('model list pagination', () => {
  it.each([{}, 'metadata', 0, null])('validates the models array when data is non-array metadata: %j', async data => {
    expect(await collectModelDiscoveryPages({ data, models: [{ id: 'kept' }, {}] }, endpoint, vi.fn(), true)).toBeNull();
    expect((await collectModelDiscoveryPages({ data, models: [{ id: 'kept' }] }, endpoint, vi.fn(), true))?.map(model => model.id)).toEqual(['kept']);
  });

  it.each(['key', 'model_name', 'model_id'])('accepts parser-supported %s identities in complete snapshots', async key => {
    const result = await collectModelDiscoveryPages({ data: [{ [key]: 'team-model' }] }, endpoint, vi.fn(), true);
    expect(result?.map(model => model.id)).toEqual(['team-model']);
  });

  it.each([{ name: 'broken' }, { model: 'broken' }])('rejects a partially parseable snapshot: %j', async broken => {
    expect(await collectModelDiscoveryPages({ data: [{ id: 'kept' }, broken] }, endpoint, vi.fn(), true)).toBeNull();
  });

  it('retains intentional Google and Vercel catalog filtering', async () => {
    const google = { models: [
      { name: 'models/chat', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/embed', supportedGenerationMethods: ['embedContent'] },
    ] };
    expect((await collectModelDiscoveryPages(google, endpoint, vi.fn(), true))?.map(model => model.id)).toEqual(['chat']);
    const vercel = { data: [{ id: 'chat', type: 'language' }, { id: 'image', type: 'image' }] };
    expect((await collectModelDiscoveryPages(vercel, 'https://ai-gateway.vercel.sh/v1/models', vi.fn(), true))?.map(model => model.id)).toEqual(['chat']);
  });

  // Review #9154: valid pages may contain only intentionally excluded models.
  // Such pages must not invalidate the snapshot or stop cursor traversal.
  it.each(['google', 'vercel'] as const)('accepts fully filtered %s pages throughout a complete snapshot', async kind => {
    const url = kind === 'vercel' ? 'https://ai-gateway.vercel.sh/v1/models' : endpoint;
    const page = (id: string, filtered = false) => ({ data: [kind === 'google'
      ? { name: `models/${id}`, supportedGenerationMethods: [filtered ? 'embedContent' : 'generateContent'] }
      : { id, type: filtered ? 'image' : 'language' }] });
    for (const position of [0, 1, 2]) {
      const pages = [page('one'), page('two')];
      pages.splice(position, 0, page('excluded', true));
      const paged = pages.map((value, index) => index < pages.length - 1
        ? { ...value, next: `?page=${index + 2}` } : value);
      let next = 1;
      const fetch = vi.fn(async () => paged[next++]);
      expect((await collectModelDiscoveryPages(paged[0], url, fetch, true))?.map(model => model.id)).toEqual(['one', 'two']);
      expect(fetch).toHaveBeenCalledTimes(2);
    }
    expect(await collectModelDiscoveryPages(page('excluded', true), url, vi.fn(), true)).toEqual([]);
  });

  // #9045, unit: snapshot refresh may delete absent models, so partial pages
  // cannot be reported as success. Existing tests cover only additive discovery.
  it.each(['offline', 'invalid', 'business-error', 'cycle', 'missing-cursor', 'foreign-link'] as const)(
    'rejects an incomplete snapshot on %s while additive discovery retains completed pages', async failure => {
      const page = { data: ['one'], next_cursor: 'repeat' };
      const fetchPage = async () => {
        if (failure === 'offline') throw new Error('offline');
        if (failure === 'invalid') return { message: 'not a model list' };
        if (failure === 'business-error') return { error: 'unavailable', data: [] };
        if (failure === 'missing-cursor') return { data: ['two'], has_more: true };
        if (failure === 'foreign-link') return { data: ['two'], next: 'https://foreign.example/models' };
        return page;
      };
      expect(await collectModelDiscoveryPages(page, endpoint, fetchPage, true)).toBeNull();
      expect(await collectModelDiscoveryPages(page, endpoint, fetchPage)).not.toBeNull();
    },
  );
  it('merges later metadata for repeated IDs without dropping earlier fields', async () => {
    const models = await collectModelDiscoveryPages({ data: [{ id: 'one', name: 'Named model',
      supports_fast_mode: true, max_output_tokens: 4000 }], next: '?page=2' }, endpoint,
      async () => ({ data: [{ id: 'one', context_window: 64000, supports_fast_mode: false,
        efforts: [], defaultEffort: null }] }));
    expect(models).toHaveLength(1);
    expect(models?.[0]).toMatchObject({ name: 'Named model', contextWindow: 64000,
      discoveredMetadata: { contextWindow: 64000, maxOutputTokens: 4000,
        supportsFastMode: false, efforts: [], defaultEffort: null } });
  });

  it('requires the separate OpenRouter speech catalog before replacing a saved snapshot', async () => {
    const first = { data: ['chat-model'] };
    const unavailable = async () => { throw new Error('speech catalog unavailable'); };
    const openRouter = 'https://openrouter.ai/api/v1/models';
    expect(await collectModelDiscoveryPages(first, openRouter, unavailable, true)).toBeNull();
    expect(await collectModelDiscoveryPages(first, openRouter, unavailable)).toHaveLength(1);
  });

  it.each([
    [{ has_more: true, last_id: 'one' }, 'after_id=one'],
    [{ nextPageToken: 'two' }, 'pageToken=two'],
    [{ next_page_token: 'two' }, 'page_token=two'],
    [{ next_cursor: 'two' }, 'cursor=two'],
    [{ next: '?page=2' }, 'page=2'],
  ])('follows cursors without losing metadata: %j', async (pagination, query) => {
    const fetch = vi.fn(async (url: string) => {
      expect(url).toBe(`${endpoint}?${query}`);
      return { data: [{ id: 'one' }, { id: 'two', native_api: 'openai-responses', supports_fast_mode: false }] };
    });
    const models = await collectModelDiscoveryPages({ data: [{ id: 'one', context_window: 128000 }], ...pagination }, endpoint, fetch, true);
    expect(models?.map(model => model.id)).toEqual(['one', 'two']);
    expect(models?.[0]?.discoveredMetadata?.contextWindow).toBe(128000);
    expect(models?.[1]?.discoveredMetadata?.nativeApi).toBe('openai-responses');
  });

  it.each(['https://attacker.example/v1/models?page=2', '/other?page=2', 'https://user:pass@models.example/v1/models'])('never sends credentials to an untrusted next link: %s', async next => {
    const fetch = vi.fn();
    expect(await collectModelDiscoveryPages({ data: ['one'], next }, endpoint, fetch)).toHaveLength(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('retains completed pages on failure and stops repeated cursors', async () => {
    const page = { data: ['one'], next_cursor: 'repeat' };
    const fetch = vi.fn(async () => page);
    expect(await collectModelDiscoveryPages(page, endpoint, fetch)).toHaveLength(1);
    expect(fetch).toHaveBeenCalledOnce();
    expect(await collectModelDiscoveryPages(page, endpoint, async () => { throw new Error('offline'); })).toHaveLength(1);
  });
});
