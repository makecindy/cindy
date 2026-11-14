import { describe, expect, it, vi } from 'vitest';
import { collectModelDiscoveryPages } from '../model-discovery-pages.js';

const endpoint = 'https://models.example/v1/models';
describe('model list pagination', () => {
  // #9882, unit: malformed continuation cannot prove the saved inventory ended.
  // Existing incomplete-page coverage only used boolean has_more or bad next links.
  it.each([1, 'true', 'false'])('rejects ambiguous has_more=%j only for strict recovery', async has_more => {
    const page = { data: ['one'], has_more, last_id: 'one' };
    const fetchPage = vi.fn();
    expect(await collectModelDiscoveryPages(page, endpoint, fetchPage, { requireComplete: true })).toBeNull();
    expect(await collectModelDiscoveryPages(page, endpoint, fetchPage)).toMatchObject([{ id: 'one' }]);
    expect(fetchPage).not.toHaveBeenCalled();
  });

  // Malformed members on any page must not become authoritative deletions;
  // valid duplicates and intentionally filtered provider modes remain supported.
  it.each([[{}], ['one', {}], [{ id: '' }], [null], ['   '],
    [{ id: '', name: 'models/embedding', supportedGenerationMethods: ['embedContent'] }]])(
    'rejects malformed members in strict catalogs: %j', async (...members) => {
      expect(await collectModelDiscoveryPages({ data: members }, endpoint, vi.fn())).not.toBeNull();
      for (const later of [false, true]) {
        const failure = { data: members };
        expect(await collectModelDiscoveryPages(later ? { data: ['one'], next: '?page=2' } : failure,
          endpoint, async () => failure, { requireComplete: true })).toBeNull();
      }
    },
  );

  it('retains legitimate empty, duplicate and deliberately filtered strict inventories', async () => {
    for (const data of [[], ['one', 'one']]) {
      expect(await collectModelDiscoveryPages({ data }, endpoint, vi.fn(), { requireComplete: true }))
        .toHaveLength(data.length ? 1 : 0);
    }
    const google = { models: [
      { name: 'models/chat', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/embedding', supportedGenerationMethods: ['embedContent'] },
    ] };
    expect(await collectModelDiscoveryPages(google, 'https://generativelanguage.googleapis.com/v1beta/models',
      vi.fn(), { requireComplete: true })).toMatchObject([{ id: 'chat' }]);
    expect(await collectModelDiscoveryPages({ data: [{ id: 'image', type: 'image' }] },
      'https://ai-gateway.vercel.sh/v1/models', vi.fn(), { requireComplete: true })).toEqual([]);
  });

  // #9882: partial catalogs cannot authorize deletion of missing provenance.
  // Unit via the real collector; existing tests only covered best-effort import.
  it.each(['offline', 'malformed', 'cycle', 'untrusted', 'page-limit', 'model-limit'] as const)(
    'rejects incomplete %s catalogs when completeness is required', async scenario => {
      const first = { data: [{ id: 'one' }], next: scenario === 'untrusted' ? 'https://other.example/v1/models?page=2' : '?page=2' };
      let pageNumber = 2;
      const fetchPage = vi.fn(async () => {
        if (scenario === 'offline') throw new Error('offline');
        if (scenario === 'malformed') return { error: 'invalid page' };
        if (scenario === 'cycle') return first;
        if (scenario === 'model-limit') return { data: Array.from({ length: 10_000 }, (_, i) => ({ id: String(i) })) };
        return { data: [{ id: 'one' }], next: '?page=' + ++pageNumber };
      });
      expect(await collectModelDiscoveryPages(first, endpoint, fetchPage, { requireComplete: true })).toBeNull();
      if (scenario === 'untrusted') expect(fetchPage).not.toHaveBeenCalled();
    },
  );

  it('accepts complete pagination when completeness is required', async () => {
    const rows = await collectModelDiscoveryPages({ data: ['one'], next: '?page=2' }, endpoint,
      async () => ({ data: ['two'] }), { requireComplete: true });
    expect(rows?.map(model => model.id)).toEqual(['one', 'two']);
  });

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
    const models = await collectModelDiscoveryPages({ data: [{ id: 'one', context_window: 128000 }], ...pagination }, endpoint, fetch);
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
