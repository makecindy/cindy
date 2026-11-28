import { describe, expect, it, vi } from 'vitest';
import { collectModelDiscoveryPages, collectModelDiscoveryPagesWithStatus } from '../model-discovery-pages.js';

const endpoint = 'https://models.example/v1/models';
describe('model list pagination', () => {
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

  // #11298: refresh may offer to remove models only after reading the whole catalog.
  // Before this flag, a failed second page silently looked like a shorter catalog.
  it.each([
    ['single page', { data: ['one'] }, async () => ({}), true],
    ['all pages read', { data: ['one'], next_cursor: 'two' }, async () => ({ data: ['two'] }), true],
    ['later page fails', { data: ['one'], next_cursor: 'two' }, async () => { throw new Error('offline'); }, false],
    ['later page unparseable', { data: ['one'], next_cursor: 'two' }, async () => ({ error: 'busy' }), false],
    ['untrusted next link', { data: ['one'], next: 'https://attacker.example/v1/models?page=2' }, async () => ({}), false],
    ['repeated cursor', { data: ['one'], next_cursor: 'repeat' }, async () => ({ data: ['one'], next_cursor: 'repeat' }), false],
    ['has_more without cursor', { data: ['one'], has_more: true }, async () => ({}), false],
    // Review P2: pagination styles this collector does not follow must not read as complete.
    ['camelCase hasMore', { data: ['one'], hasMore: true, nextCursor: 'two' }, async () => ({}), false],
    ['nested pagination.next', { data: ['one'], pagination: { next: '/v1/models?page=2' } }, async () => ({}), false],
    ['meta.next_cursor', { data: ['one'], meta: { next_cursor: 'two' } }, async () => ({}), false],
    ['total above the collected count', { data: ['one'], total: 3 }, async () => ({}), false],
    // Second review: generic hints (object links, page counts, nested totals, numeric next).
    ['links.next object', { data: ['one'], links: { next: { href: '/v1/models?page=2' } } }, async () => ({}), false],
    ['pageInfo.hasNextPage', { data: ['one'], pageInfo: { hasNextPage: true } }, async () => ({}), false],
    ['pagination.has_next', { data: ['one'], pagination: { has_next: true } }, async () => ({}), false],
    ['total_pages above one', { data: ['one'], pagination: { total_pages: 3 } }, async () => ({}), false],
    ['nested meta.total', { data: ['one'], meta: { total: 300 } }, async () => ({}), false],
    ['numeric next page', { data: ['one'], next: 2 }, async () => ({}), false],
    ['last_page above current_page', { data: ['one'], current_page: 1, last_page: 4 }, async () => ({}), false],
    ['last page of a page-number catalog', { data: ['one'], current_page: 4, last_page: 4, has_more: false }, async () => ({}), true],
    ['empty pagination fields', { data: ['one'], meta: { next_cursor: null }, total: 1 }, async () => ({}), true],
  ] as const)('reports catalog completeness: %s', async (_name, first, fetchPage, complete) => {
    const result = await collectModelDiscoveryPagesWithStatus(first, endpoint, fetchPage);
    expect(result.models?.length).toBeGreaterThan(0);
    expect(result.complete).toBe(complete);
  });

  it('treats a failed OpenRouter speech catalog as incomplete', async () => {
    const result = await collectModelDiscoveryPagesWithStatus({ data: ['one'] },
      'https://openrouter.ai/api/v1/models', async () => { throw new Error('offline'); });
    expect(result).toMatchObject({ complete: false, models: [{ id: 'one' }] });
  });
});
