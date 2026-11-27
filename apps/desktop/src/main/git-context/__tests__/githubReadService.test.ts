/** Unit: public reads preserve independent cursors across restart; errors never acknowledge work.
 * Existing badge tests cover summary caching, not the durable read protocol. Minimal change: one edited comment.
 */
import { describe, expect, it, vi } from 'vitest';
import { GithubReadService, type Journal } from '../githubReadService';
import { GithubReadTransport } from '../githubReadTransport';
import { parseGithubPr } from '@cindy/maker-shared';

const host = vi.hoisted(() => ({
  account: null as unknown,
  fetch: vi.fn(),
}));
vi.mock('../../authManager', () => ({ getDeviceId: () => 'computer' }));
vi.mock('../../localDb/client/current', () => ({ getCurrentDbClientSnapshot: () => host.account }));
vi.mock('../../maker-host/outbound-fetch.desktop', () => ({ outboundFetch: host.fetch }));
vi.mock('../ghCliTokenSource', () => ({
  getSharedGhCliTokenSource: () => ({
    readTokenDetailed: async () => ({ ok: true, token: 'fake' }),
  }),
}));

function setup() {
  const store = new Map<string, Journal>();
  let body = 'old';
  let present = true;
  let partial = false;
  let identity = 'account-a';
  const service = () =>
    new GithubReadService(async () => ({
      scope: identity,
      sourceDevice: 'computer',
      assertCurrent: async () => {},
      status: async (pr) => ({
        ...pr,
        ok: true,
        status: 'open',
        conflicts: true,
        title: 'Test',
        branch: 'branch',
        htmlUrl: 'https://github.com/o/r/pull/1',
        headSha: 'abc',
        baseBranch: 'main',
        observedAt: Date.now(),
        revision: 'r1',
        unresolvedCount: 0,
        checks: { total: 0, passed: 0, pending: 0, failed: 0, skipped: 0 },
      }),
      details: async (_pr, kind) => ({
        items: kind === 'comments' && present ? [{ id: 'c1', body }] : [],
        partial,
        errors: partial ? ['failure'] : [],
        observed_at: Date.now(),
      }),
      readJournal: async (key) => structuredClone(store.get(key) ?? null),
      writeJournal: async (key, state) => {
        store.set(key, structuredClone(state));
      },
    }));
  return {
    service,
    store,
    edit: (value: string) => {
      body = value;
      present = true;
    },
    deleteComment: () => {
      present = false;
    },
    fail: (value: boolean) => {
      partial = value;
    },
    switchAccount: () => {
      identity = 'account-b';
    },
  };
}
const pr = { repo: 'o/r', number: 1 };
describe('shared GitHub read protocol', () => {
  it('requires explicit identities and normalizes PR subpages without interpreting arbitrary text', () => {
    expect(parseGithubPr({ url: 'https://github.com/O/R/pull/12/files' })).toMatchObject({
      owner: 'o',
      repo: 'r',
      prNumber: 12,
    });
    for (const value of [
      12,
      { number: 12 },
      { repo: 'group/project', number: 12, provider: 'gitlab', host: 'git.example.com' },
      { url: 'https://git.example.com/group/project/-/merge_requests/12' },
      { url: 'https://github.com.evil.test/o/r/pull/12' },
      { url: 'https://user@github.com/o/r/pull/12' },
    ])
      expect(() => parseGithubPr(value)).toThrow();
  });
  it('reads a snapshot without writing associations or even a journal baseline', async () => {
    const h = setup();
    expect(await h.service().read('get_pr_status', { pr })).toMatchObject({
      ok: true,
      head_sha: 'abc',
      conflicts: true,
      checks: { total: 0 },
      partial: false,
    });
    expect(h.store.size).toBe(0);
  });
  it('delivers the same stable event to independent readers and survives a new service instance', async () => {
    const h = setup();
    const service = h.service();
    const baseline = await service.read('get_pr_changes', { pr });
    expect(baseline.events).toEqual([]);
    h.edit('edited');
    const first = await service.read('get_pr_changes', { pr, after: baseline.next_cursor });
    const second = await h.service().read('get_pr_changes', { pr, after: baseline.next_cursor });
    expect(first.events).toEqual(second.events);
    expect(first.events).toMatchObject([{ kind: 'comments', fact: { body: 'edited' } }]);
    expect((await service.read('get_pr_changes', { pr, after: first.next_cursor })).events).toEqual(
      [],
    );
  });
  // r4434503933: a complete empty comment list must retract the old fact; partial reads cannot.
  it('records deletions once across restart without confusing incomplete reads or reappearing items', async () => {
    const h = setup();
    const service = h.service();
    const baseline = await service.read('get_pr_changes', { pr });
    h.deleteComment();
    h.fail(true);
    await expect(
      service.read('get_pr_changes', { pr, after: baseline.next_cursor }),
    ).rejects.toThrow('GITHUB_OBSERVATION_INCOMPLETE');
    h.fail(false);
    const removed = await service.read('get_pr_changes', { pr, after: baseline.next_cursor });
    expect(removed.events).toMatchObject([
      { kind: 'comments', item_id: 'c1', fact: { id: 'c1', deleted: true } },
    ]);
    expect(
      (await h.service().read('get_pr_changes', { pr, after: baseline.next_cursor })).events,
    ).toEqual(removed.events);
    expect(
      (await service.read('get_pr_changes', { pr, after: removed.next_cursor })).events,
    ).toEqual([]);
    h.edit('restored');
    expect(
      (await service.read('get_pr_changes', { pr, after: removed.next_cursor })).events,
    ).toMatchObject([{ kind: 'comments', fact: { body: 'restored' } }]);
  });
  it('does not advance failed observations and rejects foreign or expired cursors', async () => {
    const h = setup();
    const service = h.service();
    const baseline = await service.read('get_pr_changes', { pr });
    h.fail(true);
    h.edit('new');
    await expect(
      service.read('get_pr_changes', { pr, after: baseline.next_cursor }),
    ).rejects.toThrow('GITHUB_OBSERVATION_INCOMPLETE');
    h.fail(false);
    const recovered = await service.read('get_pr_changes', { pr, after: baseline.next_cursor });
    expect(recovered.events).toHaveLength(1);
    expect(
      await service.read('get_pr_changes', {
        pr: { repo: 'o/other', number: 1 },
        after: baseline.next_cursor,
      }),
    ).toMatchObject({ errorCode: 'RESYNC_REQUIRED' });
    h.switchAccount();
    expect(await service.read('get_pr_changes', { pr, after: baseline.next_cursor })).toMatchObject(
      { errorCode: 'RESYNC_REQUIRED' },
    );
  });
  it('pages only through returned events and rejects stale detail pagination', async () => {
    const h = setup();
    const service = h.service();
    const baseline = await service.read('get_pr_changes', { pr });
    for (const body of ['a', 'b']) {
      h.edit(body);
      await service.read('get_pr_changes', { pr });
    }
    const first = await service.read('get_pr_changes', {
      pr,
      after: baseline.next_cursor,
      limit: 1,
    });
    expect(first.has_more).toBe(true);
    const second = await service.read('get_pr_changes', { pr, after: first.next_cursor, limit: 1 });
    expect(second).toMatchObject({ has_more: false, events: [{ fact: { body: 'b' } }] });
    const details = await service.read('get_pr_details', { pr, kind: 'comments', limit: 1 });
    h.edit('c');
    expect(
      await service.read('get_pr_details', { pr, kind: 'comments', after: details.next_cursor }),
    ).toMatchObject({ errorCode: 'RESYNC_REQUIRED' });
  });
});

it('shares conditional reads, avoids credential bleed, and honors identity-wide rate backoff', async () => {
  let now = 0;
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(new Response('[{"id":1}]', { headers: { etag: 'v1' } }))
    .mockResolvedValueOnce(new Response(null, { status: 304 }))
    .mockResolvedValueOnce(new Response(null, { status: 429, headers: { 'retry-after': '60' } }));
  const transport = new GithubReadTransport(fetcher, () => now);
  const [a, b] = await Promise.all([
    transport.read('identity', 'fake', '/test'),
    transport.read('identity', 'fake', '/test'),
  ]);
  expect(a).toEqual(b);
  expect(fetcher).toHaveBeenCalledTimes(1);
  now = 61_000;
  expect(await transport.read('identity', 'fake', '/test')).toEqual(a);
  expect(fetcher.mock.calls[1][1].headers['If-None-Match']).toBe('v1');
  await expect(transport.read('other', 'fake-other', '/test')).rejects.toThrow();
  await expect(transport.read('other', 'fake-other', '/different')).rejects.toThrow(
    'GITHUB_RATE_LIMITED',
  );
  expect(fetcher).toHaveBeenCalledTimes(3);
});

// Unit: secondary 429/403 must back off by retry-after (not primary x-ratelimit-reset), while
// primary exhaustion (remaining=0) scopes backoff to its resource bucket (REST vs GraphQL).
it('separates secondary retry-after backoff from primary x-ratelimit-reset and buckets primary exhaustion', async () => {
  let now = 1_700_000_000_000;
  const oneHourLaterSec = String(Math.floor((now + 3_600_000) / 1000));
  const fetcher = vi
    .fn()
    // 1) Secondary 429 with remaining > 0 and hourly x-ratelimit-reset: must honor retry-after (60s), not 1h reset.
    .mockResolvedValueOnce(
      new Response(null, {
        status: 429,
        headers: {
          'retry-after': '60',
          'x-ratelimit-remaining': '3884',
          'x-ratelimit-reset': oneHourLaterSec,
        },
      }),
    )
    // 2) Recovery after 60s succeeds.
    .mockResolvedValueOnce(Response.json({ ok: 'recovered' }))
    // 3) Secondary 429 without retry-after but with hourly x-ratelimit-reset: falls back to 60s, not 1h.
    .mockResolvedValueOnce(
      new Response(null, {
        status: 429,
        headers: {
          'x-ratelimit-remaining': '3800',
          'x-ratelimit-reset': String(Math.floor((now + 3_700_000) / 1000)),
        },
      }),
    )
    // 4) Recovery after 60s succeeds.
    .mockResolvedValueOnce(Response.json({ ok: 'fallback-recovered' }))
    // 5) Plain permission 403 (remaining > 0, no retry-after) does not trip backoff.
    .mockResolvedValueOnce(
      new Response(null, {
        status: 403,
        headers: {
          'x-ratelimit-remaining': '3799',
          'x-ratelimit-reset': String(Math.floor((now + 3_700_000) / 1000)),
        },
      }),
    )
    // 6) Next request immediately after permission 403 still runs.
    .mockResolvedValueOnce(Response.json({ ok: 'after-403' }))
    // 7) GraphQL primary exhaustion (remaining=0) blocks /graphql until reset, but not REST.
    .mockResolvedValueOnce(
      new Response(null, {
        status: 403,
        headers: {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': String(Math.floor((now + 600_000) / 1000)),
        },
      }),
    )
    // 8) REST read while GraphQL primary quota is exhausted still succeeds.
    .mockResolvedValueOnce(Response.json({ ok: 'rest-still-works' }))
    // 9) GraphQL recovers once its reset timestamp passes.
    .mockResolvedValueOnce(Response.json({ data: { ok: true } }));

  const transport = new GithubReadTransport(fetcher, () => now);

  await expect(transport.read('acct', 'tok', '/repos/o/r/pulls/1')).rejects.toThrow('GITHUB_HTTP_429');
  now += 59_000;
  await expect(transport.read('acct', 'tok', '/repos/o/r/pulls/2')).rejects.toThrow('GITHUB_RATE_LIMITED');
  now += 2_000; // 61s total, well before the 1h x-ratelimit-reset
  await expect(transport.read('acct', 'tok', '/repos/o/r/pulls/2')).resolves.toEqual({ ok: 'recovered' });

  await expect(transport.read('acct', 'tok', '/repos/o/r/pulls/3')).rejects.toThrow('GITHUB_HTTP_429');
  now += 61_000;
  await expect(transport.read('acct', 'tok', '/repos/o/r/pulls/4')).resolves.toEqual({
    ok: 'fallback-recovered',
  });

  await expect(transport.read('acct', 'tok', '/repos/private/repo/pulls/1')).rejects.toThrow(
    'GITHUB_HTTP_403',
  );
  await expect(transport.read('acct', 'tok', '/repos/o/r/pulls/5')).resolves.toEqual({
    ok: 'after-403',
  });

  await expect(
    transport.read('acct', 'tok', '/graphql', { body: { query: '{ viewer { login } }' } }),
  ).rejects.toThrow('GITHUB_HTTP_403');
  now += 120_000; // 2m elapsed, still before 10m GraphQL reset
  await expect(
    transport.read('acct', 'tok', '/graphql', { body: { query: '{ viewer { id } }' } }),
  ).rejects.toThrow('GITHUB_RATE_LIMITED');
  await expect(transport.read('acct', 'tok', '/repos/o/r/pulls/6')).resolves.toEqual({
    ok: 'rest-still-works',
  });
  now += 500_000; // past 10m GraphQL reset
  await expect(
    transport.read('acct', 'tok', '/graphql', { body: { query: '{ viewer { id } }' } }),
  ).resolves.toEqual({ data: { ok: true } });
  expect(fetcher).toHaveBeenCalledTimes(9);
});

// Unit: cap concurrent requests to avoid startup 429 bursts, and fail queued reads fast on backoff or auth invalidation.
it('caps in-flight GitHub reads and fails queued reads fast on rate limit or invalidation', async () => {
  let active = 0;
  let peak = 0;
  const gates: Array<() => void> = [];
  const fetcher = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        active += 1;
        peak = Math.max(peak, active);
        gates.push(() => {
          active -= 1;
          resolve(Response.json({ ok: true }));
        });
      }),
  );
  const transport = new GithubReadTransport(fetcher, () => 1_000);
  const batch = Array.from({ length: 10 }, (_, i) =>
    transport.read('acct', 'tok', `/repos/o/r/pulls/${i + 1}`),
  );
  await Promise.resolve();
  expect(peak).toBe(6);
  expect(fetcher).toHaveBeenCalledTimes(6);
  while (gates.length > 0) {
    gates.shift()!();
    await Promise.resolve();
    await Promise.resolve();
  }
  await expect(Promise.all(batch)).resolves.toHaveLength(10);
  expect(peak).toBe(6);

  // Queued reads fail fast when an active slot hits 429 (no extra network calls).
  const rateLimitGates: Array<(response: Response) => void> = [];
  const rateLimitedFetcher = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        rateLimitGates.push(resolve);
      }),
  );
  const limited = new GithubReadTransport(rateLimitedFetcher, () => 1_000, 2);
  const r1 = limited.read('acct', 'tok', '/repos/o/r/pulls/1');
  const r2 = limited.read('acct', 'tok', '/repos/o/r/pulls/2');
  const r3 = limited.read('acct', 'tok', '/repos/o/r/pulls/3');
  await Promise.resolve();
  expect(rateLimitedFetcher).toHaveBeenCalledTimes(2);
  rateLimitGates[0](new Response(null, { status: 429, headers: { 'retry-after': '60' } }));
  rateLimitGates[1](Response.json({ ok: true }));
  await expect(r1).rejects.toThrow('GITHUB_HTTP_429');
  await expect(r2).resolves.toEqual({ ok: true });
  await expect(r3).rejects.toThrow('GITHUB_RATE_LIMITED');
  expect(rateLimitedFetcher).toHaveBeenCalledTimes(2);

  // Queued reads reject immediately with GITHUB_AUTH_CHANGED on invalidate().
  const authGates: Array<(response: Response) => void> = [];
  const authFetcher = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        authGates.push(resolve);
      }),
  );
  const invalidating = new GithubReadTransport(authFetcher, () => 1_000, 1);
  const a1 = invalidating.read('acct', 'tok', '/repos/o/r/pulls/1');
  const a2 = invalidating.read('acct', 'tok', '/repos/o/r/pulls/2');
  await Promise.resolve();
  invalidating.invalidate();
  await expect(a2).rejects.toThrow('GITHUB_AUTH_CHANGED');
  authGates[0](Response.json({ ok: true }));
  await expect(a1).rejects.toThrow('GITHUB_AUTH_CHANGED');
  expect(authFetcher).toHaveBeenCalledTimes(1);
});

// A paginated thread must be complete, while repeated consumers must not mutate cached GraphQL nodes.
it('follows outer and nested review pagination without modifying shared cached responses', async () => {
  const { readGithubDetails } = await import('../githubPrDetails');
  const page = (nodes: unknown[], next: string | null = null) => ({
    nodes,
    pageInfo: { hasNextPage: !!next, endCursor: next },
  });
  const first = { id: 't1', comments: page([{ id: 'c1' }], 'comment-page-2') };
  const fetcher = vi.fn(async (_input, init) => {
    const { query, variables } = JSON.parse(init.body);
    const data = query.includes('node(id:')
      ? { node: { comments: page([{ id: 'c2' }]) } }
      : {
          repository: {
            pullRequest: {
              reviewThreads: variables.after
                ? page([{ id: 't2', comments: page([]) }])
                : page([first], 'thread-page-2'),
            },
          },
        };
    return Response.json({ data });
  });
  const transport = new GithubReadTransport(fetcher as typeof fetch);
  const input = {
    transport,
    scope: 'test',
    token: 'fake',
    pr: { owner: 'o', repo: 'r', prNumber: 1 },
    kind: 'threads' as const,
    head: 'abc',
    base: 'main',
  };
  const a = await readGithubDetails(input);
  const b = await readGithubDetails(input);
  expect(a).toMatchObject({
    partial: false,
    items: [
      { id: 't1', comments: [{ id: 'c1' }, { id: 'c2' }] },
      { id: 't2', comments: [] },
    ],
  });
  expect(b.items).toEqual(a.items);
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(b.observed_at).toBe(a.observed_at);
});

it('rejects an in-flight response after authorization invalidation', async () => {
  let finish!: (response: Response) => void;
  const fetcher = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  const transport = new GithubReadTransport(fetcher);
  const pending = transport.read('account', 'fake', '/test');
  transport.invalidate();
  finish(Response.json({ private: true }));
  await expect(pending).rejects.toThrow('GITHUB_AUTH_CHANGED');
});

// r4434503941: exercise host assembly, not a mocked details callback. One batched first page
// plus one continuation must remain two network requests even under explicit refresh (unit tier).
it('reuses refreshed observation first pages and refreshes only their continuations', async () => {
  const { createGithubReadService } = await import('../githubReadHost');
  let journal: string | undefined;
  host.account = {
    userId: 'account',
    clientEpoch: 1,
    client: {
      drizzle: {
        select: () => ({
          from: () => ({
            where: () => ({ limit: async () => (journal ? [{ state: journal }] : []) }),
          }),
        }),
        insert: () => ({
          values: (row: { state: string }) => ({
            onConflictDoUpdate: async () => {
              journal = row.state;
            },
          }),
        }),
        delete: () => ({ where: async () => {} }),
      },
    },
  };
  let version = 'one';
  const page = (nodes: unknown[], next: string | null = null) => ({
    nodes,
    pageInfo: { hasNextPage: !!next, endCursor: next },
  });
  host.fetch.mockImplementation(async (_input, init) => {
    const { query, variables } = JSON.parse(init.body);
    const comments = page(
      [{ id: variables.after ? 'c2' : 'c1', body: version }],
      variables.after ? null : 'page-2',
    );
    const contexts = page([]);
    const pullRequest = query.includes('threads:reviewThreads')
      ? { threads: page([]), comments, reviews: page([]) }
      : { comments, reviews: page([]), reviewThreads: page([]) };
    return Response.json({
      data: { repository: { pullRequest, object: { statusCheckRollup: { contexts } } } },
    });
  });
  const status = {
    ...pr,
    owner: 'o',
    repo: 'r',
    prNumber: 1,
    ok: true as const,
    status: 'open' as const,
    title: 'Test',
    branch: 'branch',
    htmlUrl: 'https://github.com/o/r/pull/1',
    headSha: 'abc',
    baseBranch: 'main',
    unresolvedCount: 0,
    checks: { total: 0, passed: 0, pending: 0, failed: 0, skipped: 0 },
  };
  const service = createGithubReadService({
    getStatuses: async () => [status],
  } as unknown as import('../prStatusService').PrStatusService);
  const baseline = await service.read('get_pr_changes', { pr, freshness: 'refresh' });
  expect(host.fetch).toHaveBeenCalledTimes(2);
  version = 'two';
  const changed = await service.read('get_pr_changes', {
    pr,
    freshness: 'refresh',
    after: baseline.next_cursor,
  });
  expect(host.fetch).toHaveBeenCalledTimes(4);
  expect(changed.events).toMatchObject([
    { item_id: 'c1', fact: { body: 'two' } },
    { item_id: 'c2', fact: { body: 'two' } },
  ]);
  version = 'three';
  const direct = await service.read('get_pr_details', {
    pr,
    kind: 'comments',
    freshness: 'refresh',
  });
  expect(direct.items).toMatchObject([{ body: 'three' }, { body: 'three' }]);
  expect(host.fetch).toHaveBeenCalledTimes(6);
});

// 测试价值：
// - 防退化点：当并发追踪超过 50 个 PR（100+ REST+GraphQL 请求）时，ttl:0 的 POST /graphql
//   响应曾挤占 100 条 FIFO 缓存并逐出 REST ETag，导致后续轮询失去 304 Not Modified。
// - 触发条件：120 个 PR 交替发起 GET /repos/o/r/pulls/:n (ttl:0, 带 ETag) 与 POST /graphql (ttl:0, 无 ETag)。
// - 生产入口与可观察结果：直接调用 GithubReadTransport.read，断言第二轮 120 个 GET 全部携带
//   If-None-Match 命中 304 复用原数据，而 ttl:0 的 GraphQL 每次都重新请求不返回旧缓存。
// - 依赖策略：仅注入内存 fake fetch，不触发真实网络或时钟等待。
// - 对应规则或根因：docs/dev-rules/server-channel-review.md（条件请求 304 与受控重试）。
it('keeps REST ETags across >100 interleaved GraphQL ttl:0 status reads and revalidates with 304', async () => {
  const etags = new Map<string, string>();
  const seenIfNoneMatch = new Map<string, string | null>();
  let graphqlCalls = 0;
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (method === 'POST') {
      graphqlCalls += 1;
      return Response.json({ data: { call: graphqlCalls } });
    }
    const headers = init?.headers as Record<string, string> | undefined;
    const inm = headers?.['If-None-Match'] ?? null;
    seenIfNoneMatch.set(url, inm);
    const expected = etags.get(url);
    if (expected && inm === expected) {
      return new Response(null, { status: 304 });
    }
    const tag = `W/"etag-${url.split('/').pop()}"`;
    etags.set(url, tag);
    return new Response(JSON.stringify({ url, seq: 1 }), {
      status: 200,
      headers: { 'content-type': 'application/json', etag: tag },
    });
  });

  const transport = new GithubReadTransport(fetcher as typeof fetch, () => 10_000, 12);
  const count = 120;
  for (let i = 1; i <= count; i += 1) {
    await transport.read('acct', 'tok', `/repos/o/r/pulls/${i}`, { ttl: 0 });
    await transport.read('acct', 'tok', '/graphql', {
      body: { query: 'query Summary($n:Int!){}', variables: { n: i } },
      ttl: 0,
    });
  }
  expect(graphqlCalls).toBe(count);

  for (let i = 1; i <= count; i += 1) {
    const path = `/repos/o/r/pulls/${i}`;
    const res = await transport.read('acct', 'tok', path, { ttl: 0 });
    expect(res).toEqual({ url: `https://api.github.com${path}`, seq: 1 });
    expect(seenIfNoneMatch.get(`https://api.github.com${path}`)).toBe(`W/"etag-${i}"`);
  }

  // ttl:0 GraphQL must not serve stale cached data on a subsequent read.
  const freshGql = await transport.read('acct', 'tok', '/graphql', {
    body: { query: 'query Summary($n:Int!){}', variables: { n: 1 } },
    ttl: 0,
  });
  expect(freshGql).toEqual({ data: { call: count + 1 } });
});

// 测试价值：
// - 防退化点：304 回填未走容量上限检查时，请求在途期间被淘汰的条目回写会让缓存超出 MAX_CACHE_ENTRIES 且持续膨胀。
// - 触发条件：maxCacheEntries=2，缓存满 /a、/b 后发起 /a 条件刷新，在途期间写入 /c、/d 挤出 /a，再返回 304。
// - 生产入口与可观察结果：GithubReadTransport.read，通过后续请求实际携带的 If-None-Match 头部断言
//   304 回写后缓存严格保持 2 条（/c 被逐出、/d 与 /a 保留）。
// - 依赖策略：仅内存 fake fetch 与可控 Promise，无网络与真实时钟等待。
// - 对应规则或根因：PR #13282 Greptile P2（缓存容量不变量）。
it('enforces maxCacheEntries when a 304 revalidation reinserts an entry evicted while in flight', async () => {
  let release304!: (response: Response) => void;
  let holdNextA = false;
  const seenIfNoneMatch: Array<{ path: string; inm: string | null }> = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const headers = init?.headers as Record<string, string> | undefined;
    seenIfNoneMatch.push({ path, inm: headers?.['If-None-Match'] ?? null });
    if (path === '/repos/o/r/pulls/1' && holdNextA) {
      holdNextA = false;
      return new Promise<Response>((resolve) => {
        release304 = resolve;
      });
    }
    return new Response(JSON.stringify({ path }), {
      status: 200,
      headers: { 'content-type': 'application/json', etag: `W/"${path}"` },
    });
  });

  const transport = new GithubReadTransport(fetcher as typeof fetch, () => 10_000, 6, 2);
  await transport.read('acct', 'tok', '/repos/o/r/pulls/1', { ttl: 0 });
  await transport.read('acct', 'tok', '/repos/o/r/pulls/2', { ttl: 0 });

  // Start conditional revalidation for /1; while it is in flight, /3 and /4 evict /1 and /2.
  holdNextA = true;
  const revalidating = transport.read('acct', 'tok', '/repos/o/r/pulls/1', { ttl: 0 });
  await Promise.resolve();
  await transport.read('acct', 'tok', '/repos/o/r/pulls/3', { ttl: 0 });
  await transport.read('acct', 'tok', '/repos/o/r/pulls/4', { ttl: 0 });
  // Cache currently holds {/3, /4} (size 2). Resolving /1 with 304 must evict /3 so size stays 2.
  release304(new Response(null, { status: 304 }));
  await expect(revalidating).resolves.toEqual({ path: '/repos/o/r/pulls/1' });

  seenIfNoneMatch.length = 0;
  // /4 and /1 must still be cached (carry If-None-Match); /3 must have been evicted (no If-None-Match).
  await transport.read('acct', 'tok', '/repos/o/r/pulls/4', { ttl: 0 });
  await transport.read('acct', 'tok', '/repos/o/r/pulls/1', { ttl: 0 });
  await transport.read('acct', 'tok', '/repos/o/r/pulls/3', { ttl: 0 });
  expect(seenIfNoneMatch).toEqual([
    { path: '/repos/o/r/pulls/4', inm: 'W/"/repos/o/r/pulls/4"' },
    { path: '/repos/o/r/pulls/1', inm: 'W/"/repos/o/r/pulls/1"' },
    { path: '/repos/o/r/pulls/3', inm: null },
  ]);
});

// 测试价值：
// - 防退化点：仅在剩余配额归零（HTTP 403/429）时才限流会导致后台轮询直接打穿配额；需要在低配额阶段渐进降频并在窗口重置后自动恢复。
// - 触发条件：连续响应返回 remaining=900/5000（low）、remaining=100/5000（critical）、时钟跨过 resetAt（恢复 normal）、invalidate 清除状态。
// - 生产入口与可观察结果：GithubReadTransport.read + getRateLimitPressure + getCombinedRateLimitPressure。
// - 依赖策略：纯内存 fake fetch 与可控 now 时钟。
// - 对应规则或根因：docs/dev-rules/server-channel-review.md（GitHub API 低配额自适应降频与自动恢复）。
it('tracks x-ratelimit pressure per resource bucket and auto-recovers after resetAt or invalidate', async () => {
  let now = 1_700_000_000_000;
  const resetSec = String(Math.floor((now + 1_800_000) / 1000));
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({ ok: 1 }, {
        headers: {
          'x-ratelimit-resource': 'core',
          'x-ratelimit-limit': '5000',
          'x-ratelimit-remaining': '900',
          'x-ratelimit-reset': resetSec,
        },
      }),
    )
    .mockResolvedValueOnce(
      Response.json({ data: { ok: 2 } }, {
        headers: {
          'x-ratelimit-resource': 'graphql',
          'x-ratelimit-limit': '5000',
          'x-ratelimit-remaining': '100',
          'x-ratelimit-reset': resetSec,
        },
      }),
    );
  const transport = new GithubReadTransport(fetcher as typeof fetch, () => now);
  expect(transport.getCombinedRateLimitPressure('acct')).toBe('normal');

  await transport.read('acct', 'tok', '/repos/o/r/pulls/1', { ttl: 0 });
  expect(transport.getRateLimitPressure('acct', 'rest')).toMatchObject({ level: 'low', remaining: 900, limit: 5000 });
  expect(transport.getRateLimitPressure('acct', 'graphql').level).toBe('normal');
  expect(transport.getCombinedRateLimitPressure('acct')).toBe('low');

  await transport.read('acct', 'tok', '/graphql', { body: { query: '{ viewer { login } }' }, ttl: 0 });
  expect(transport.getRateLimitPressure('acct', 'graphql')).toMatchObject({ level: 'critical', remaining: 100, limit: 5000 });
  expect(transport.getCombinedRateLimitPressure('acct')).toBe('critical');

  // Once the reset window passes, pressure returns to normal automatically without needing a network probe.
  now += 1_801_000;
  expect(transport.getRateLimitPressure('acct', 'rest').level).toBe('normal');
  expect(transport.getRateLimitPressure('acct', 'graphql').level).toBe('normal');
  expect(transport.getCombinedRateLimitPressure('acct')).toBe('normal');

  // invalidate() also drops recorded quota state immediately (e.g. account switch).
  now -= 1_000_000;
  expect(transport.getCombinedRateLimitPressure('acct')).toBe('critical');
  transport.invalidate();
  expect(transport.getCombinedRateLimitPressure('acct')).toBe('normal');
});
