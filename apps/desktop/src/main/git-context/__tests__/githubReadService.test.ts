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
