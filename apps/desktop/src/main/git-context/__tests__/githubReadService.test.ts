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
vi.mock('../../maker-host/outbound-fetch', () => ({ outboundFetch: host.fetch }));
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
