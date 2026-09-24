import { describe, expect, it, vi } from 'vitest';
import { collectModelDiscoveryPages } from '../model-discovery-pages.js';

const endpoint = 'https://models.example/v1/models';
describe('model list pagination', () => {
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
