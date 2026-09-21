import { afterEach, describe, expect, it, vi } from 'vitest';
import { searchCindyUpstream, upstreamSearchTerms } from '../upstreamQuery.js';

const signal = () => new AbortController().signal;
const pullRequest = (number = 12) => ({
  number,
  title: 'Scrolling flickers',
  state: 'open',
  html_url: `https://github.com/makecindy/cindy/pull/${number}`,
  pull_request: {},
  body: 'A short reproduction',
  updated_at: '2026-09-08T08:00:00Z',
  user: { login: 'contributor' },
});
const page = (items: unknown[] = []) => ({
  total_count: items.length,
  incomplete_results: false,
  items,
});
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
afterEach(() => vi.useRealTimers());

describe('Cindy upstream search', () => {
  it('extracts bounded literal terms from requests and confines every request to Cindy', async () => {
    expect(upstreamSearchTerms('我希望修复消息流闪烁')).toEqual(['消息', '闪烁']);
    const fetch = vi.fn(async () => json(page()));
    await searchCindyUpstream('scrolling repo:elsewhere/private OR is:closed', signal(), { fetch });
    expect(fetch.mock.calls.length).toBeLessThanOrEqual(6);
    for (const [url, init] of fetch.mock.calls as unknown as [string, RequestInit][]) {
      expect(new URL(url).searchParams.get('q')).toMatch(
        /^repo:makecindy\/cindy is:pr is:(open|merged) in:title,body "[\p{L}\p{N}]+"$/u,
      );
      expect(init.headers).not.toHaveProperty('authorization');
    }
  });
  it('does not search or claim no matches when no usable request was supplied', async () => {
    const fetch = vi.fn();
    expect(await searchCindyUpstream('希望修复', signal(), { fetch })).toMatchObject({
      status: 'needsRequest',
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('returns notFound only for a complete, valid empty result', async () => {
    expect(
      await searchCindyUpstream('scrolling', signal(), { fetch: async () => json(page()) }),
    ).toEqual({
      status: 'notFound',
      items: [],
      terms: ['scrolling'],
      excludedIncluded: 0,
      hasMore: false,
    });
  });
  it.each([
    {},
    { items: [] },
    { ...page(), incomplete_results: true },
    { ...page(), total_count: 1 },
    page([{}]),
    { ...page(), total_count: -1 },
    { ...page(), total_count: 0.5 },
    page([{ ...pullRequest(), html_url: 'https://example.com/pull/12' }]),
    page([{ ...pullRequest(), pull_request: undefined }]),
    page([{ ...pullRequest(), pull_request: [] }]),
    page([{ ...pullRequest(), state: 'unexpected' }]),
  ])('does not mislabel incomplete or malformed data as no matches: %j', async (body) => {
    expect(
      await searchCindyUpstream('scrolling', signal(), { fetch: async () => json(body) }),
    ).toMatchObject({ status: 'failed', failure: 'invalidResponse' });
  });
  it('deduplicates repeated hits, ranks shared matches first and retains factual context', async () => {
    const result = await searchCindyUpstream('scrolling flickering', signal(), {
      fetch: async (url) =>
        json(
          page(
            new URL(url).searchParams.get('q')?.includes('scrolling')
              ? [pullRequest(1), pullRequest(12)]
              : [pullRequest(12)],
          ),
        ),
    });
    expect(result.items.map((item) => item.number)).toEqual([12, 1]);
    expect(result.items[0]).toMatchObject({
      author: 'contributor',
      updatedAt: '2026-09-08T08:00:00.000Z',
      summary: 'A short reproduction',
    });
  });
  it('retains a closed PR with unknown inclusion if its detail cannot be verified', async () => {
    const closed = { ...pullRequest(), state: 'closed' };
    const result = await searchCindyUpstream('scrolling', signal(), {
      fetch: async () => json(page([closed])),
    });
    expect(result).toMatchObject({
      status: 'found',
      items: [{ state: 'unknown', inclusion: 'unknown' }],
    });
  });
  it('does not describe a bounded search as exhaustive when all checked PRs are included', async () => {
    const commit = 'a'.repeat(40);
    const fetch = vi.fn(async (url: string) =>
      new URL(url).pathname === '/search/issues'
        ? json({ ...page([pullRequest()]), total_count: 100 })
        : json({
            ...pullRequest(),
            merged: true,
            state: 'closed',
            merge_commit_sha: commit,
            base: { repo: { full_name: 'makecindy/cindy' } },
          }),
    );
    const result = await searchCindyUpstream('scrolling', signal(), {
      fetch,
      runtime: { channel: 'release', version: '1.0.0', commit, confidence: 'exact' },
    });
    expect(result).toMatchObject({
      status: 'notFound',
      items: [],
      excludedIncluded: 1,
      hasMore: true,
    });
    expect(fetch.mock.calls.filter(([url]) => url.includes('/pulls/'))).toHaveLength(1);
    const queries = fetch.mock.calls
      .filter(([url]) => url.includes('/search/issues'))
      .map(([url]) => new URL(url).searchParams.get('q'));
    expect(queries).toEqual([
      'repo:makecindy/cindy is:pr is:open in:title,body "scrolling"',
      'repo:makecindy/cindy is:pr is:merged in:title,body "scrolling"',
    ]);
  });
  it('times out detail lookup rather than reporting unknown candidates as a completed query', async () => {
    vi.useFakeTimers();
    const pending = searchCindyUpstream('scrolling', signal(), {
      fetch: async (url) =>
        url.includes('/search/issues') ? json(page([pullRequest()])) : new Promise(() => {}),
    });
    await vi.advanceTimersByTimeAsync(25_000);
    expect(await pending).toMatchObject({ status: 'failed', failure: 'timeout', items: [] });
  });
  it.each([403, 429, 503])('shows failure for GitHub HTTP %s', async (status) => {
    expect(
      await searchCindyUpstream('scrolling', signal(), { fetch: async () => json({}, status) }),
    ).toMatchObject({ status: 'failed', failure: status === 503 ? 'network' : 'rateLimit' });
  });
  it('cancels even if a fetch implementation never settles', async () => {
    const controller = new AbortController();
    const pending = searchCindyUpstream('scrolling', controller.signal, {
      fetch: () => new Promise(() => {}),
    });
    controller.abort();
    expect(await pending).toMatchObject({ status: 'cancelled' });
  });
  it('times out a stuck response body and aborts the request', async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | null | undefined;
    const pending = searchCindyUpstream('scrolling', signal(), {
      fetch: async (_url, init) => {
        requestSignal = init?.signal;
        return { ok: true, json: () => new Promise(() => {}) } as Response;
      },
    });
    await vi.advanceTimersByTimeAsync(25_000);
    expect(await pending).toMatchObject({ status: 'failed', failure: 'timeout' });
    expect(requestSignal?.aborted).toBe(true);
  });
});
