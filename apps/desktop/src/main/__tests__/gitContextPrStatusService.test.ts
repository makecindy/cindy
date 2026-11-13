import { createGlabCliTokenSource } from '../git-context/glabCliTokenSource';
import { fetchGitlabMr } from '../git-context/gitlabPrSummary';
import { remotePrStatuses } from '@cindy/maker-shared';
/**
 * git-context/prStatusService 单测 — 状态映射、TTL 缓存、in-flight 去重、
 * gh 缺失/未登录降级(不缓存,远端归一 no-token)、404/网络错误映射。依赖全注入,零网络零 Electron。
 */

import { describe, it, expect, vi } from 'vitest';

import {
  PrStatusService,
  filterPrStatusQueriesForRefs,
  mapRemoteToStatus,
  type PrRemoteState,
} from '../git-context/prStatusService';
import type { GhCliTokenReadResult } from '../git-context/ghCliTokenSource';
import { fetchPrSummary, summarizeChecks } from '../git-context/prSummary';
import { PrFollowWatch, prStatusSignature } from '../git-context/prFollowWatch';
import { followedGithubPrs } from '../scheduler-host/webhook/github';
import { cachedGithubPrHeads, refreshGithubPrEvents } from '../git-context/githubPrEvents';
import type { GithubClient } from '@cindy/github-client';

const Q = { owner: 'makecindy', repo: 'cindy', prNumber: 85 };
const TOKEN_OK = async (): Promise<GhCliTokenReadResult> => ({ ok: true, token: 'ghp_x' });

// Real shared status cache/event reader, synthetic clock and network. Verify request
// counts and current facts, not implementation strings: healthy vs failed delivery,
// explicit refresh, account switching and an overflow larger than the API batch cap.
describe('GitHub App status refresh policy', () => {
  it('reduces only covered PR reads, keeps bounded reconciliation, and falls back immediately when unhealthy', async () => {
    let now = 0;
    let healthy = true;
    const fetchPr = vi.fn(async () => remote({}));
    const svc = new PrStatusService({ readToken: TOKEN_OK, fetchPr, now: () => now, staleTtlMs: 0,
      eventCacheTtlMs: q => healthy && q.prNumber === Q.prNumber ? 300_000 : undefined });
    const other = { ...Q, prNumber: 86 };
    await svc.getStatuses([Q, other]);
    now = 90_000;
    await svc.getStatuses([Q, other]);
    expect(fetchPr).toHaveBeenCalledTimes(3); // only the uncovered PR polls
    now = 180_000;
    await svc.getStatuses([Q]);
    expect(fetchPr).toHaveBeenCalledTimes(3);
    now = 300_000;
    await svc.getStatuses([Q]);
    expect(fetchPr).toHaveBeenCalledTimes(4); // bounded read even on a quiet socket
    now = 390_000;
    healthy = false;
    await svc.getStatuses([Q]);
    expect(fetchPr).toHaveBeenCalledTimes(5); // original 60s TTL, no extended stale window
    healthy = true;
    await svc.getStatuses([Q], { refresh: true });
    expect(fetchPr).toHaveBeenCalledTimes(6); // user/event force refresh bypasses TTL
  });

  // Unit: one review changes the summary and supplies an explicit doorbell. The real
  // observer and event reader must produce one run, not a deferred duplicate at 60s.
  it('coalesces a changed summary and its explicit doorbell but keeps unchanged comments', async () => {
    vi.useFakeTimers();
    let head = 'first';
    const url = 'https://github.com/makecindy/cindy/pull/85';
    const runNow = vi.fn(async () => null);
    const watch = new PrFollowWatch({
      listActive: async () => [{ id: 'follow', status: 'active', recurring: true,
        preRunHook: { command: `node gate.mjs ${url}` } }] as never,
      inflight: () => 0, autoRunAllowed: () => true, hasCapacity: () => true, runNow,
    });
    const svc = new PrStatusService({ readToken: TOKEN_OK, fetchPr: async () => remote({ head_sha: head }),
      onObserved: (query, result) => watch.observe(query, result) });
    try {
      await svc.getStatuses([Q]);
      head = 'second';
      await refreshGithubPrEvents(svc, watch, [url], () => true, { reason: 'event', notify: [url] });
      expect(runNow).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(runNow).toHaveBeenCalledTimes(1);
      await refreshGithubPrEvents(svc, watch, [url], () => true, { reason: 'event', notify: [url] });
      expect(runNow).toHaveBeenCalledTimes(2);
    } finally { vi.clearAllTimers(); vi.useRealTimers(); }
  });

  it('times out a hung PR read without sending a follow-up notification', async () => {
    vi.useFakeTimers();
    const notify = vi.fn();
    try {
      const service = { getStatuses: () => new Promise(() => {}) } as unknown as PrStatusService;
      const url = 'https://github.com/example/project/pull/1';
      const check = refreshGithubPrEvents(service, { notify, observedSignature: () => undefined }, [url], () => true, { reason: 'event', notify: [url] });
      const rejected = expect(check).rejects.toThrow('PR_VERIFICATION_TIMEOUT');
      await vi.advanceTimersByTimeAsync(30_000);
      await rejected;
      expect(notify).not.toHaveBeenCalled();
    } finally { vi.clearAllTimers(); vi.useRealTimers(); }
  });

  it('rechecks all overflow PRs, propagates failures for retry, and keeps old-owner heads private', async () => {
    let scope = 'first';
    let current = true;
    let fail = false;
    const fetchPr = vi.fn(async () => { if (fail) throw new Error('offline'); return remote({ head_sha: 'a'.repeat(40) }); });
    const svc = new PrStatusService({ readToken: TOKEN_OK, fetchPr, scope: async () => scope });
    const notify = vi.fn(async () => {});
    const urls = Array.from({ length: 12 }, (_, i) => `https://github.com/example/project/pull/${i + 1}`);
    await refreshGithubPrEvents(svc, { notify, observedSignature: () => undefined }, urls, () => current, { reason: 'overflow', notify: urls });
    expect(fetchPr).toHaveBeenCalledTimes(12);
    expect(notify).toHaveBeenCalledTimes(12);
    expect(Object.keys(await cachedGithubPrHeads(svc, urls))).toHaveLength(12);
    expect(fetchPr).toHaveBeenCalledTimes(12); // head lookup never polls
    notify.mockClear();
    await refreshGithubPrEvents(svc, { notify, observedSignature: () => undefined }, [urls[0]!], () => current, { reason: 'event', notify: [] });
    expect(notify).not.toHaveBeenCalled(); // unchanged CI does not force the gate
    fail = true;
    await expect(refreshGithubPrEvents(svc, { notify, observedSignature: () => undefined }, urls, () => current, { reason: 'overflow', notify: urls }))
      .rejects.toThrow('PR_VERIFICATION_FAILED');
    scope = 'other';
    expect(await cachedGithubPrHeads(svc, urls)).toEqual({});
    current = false;
    const reads = fetchPr.mock.calls.length;
    await refreshGithubPrEvents(svc, { notify, observedSignature: () => undefined }, urls, () => current, { reason: 'overflow', notify: urls });
    expect(fetchPr).toHaveBeenCalledTimes(reads);
    expect(notify).not.toHaveBeenCalled();
  });
});

// Production summary + cache entry points. New counts must cover both GitHub APIs,
// truncated and unavailable results, absent from the prior four-state tests.
// Minimal inputs are one failed commit status and an incomplete thread page (unit).
describe('PR summary', () => {
  it('counts current rollup check runs and commit statuses once, without passing skipped checks', () => {
    expect(summarizeChecks({ totalCount: 5,
      checkRunCountsByState: [{ state: 'SUCCESS', count: 2 }, { state: 'SKIPPED', count: 1 }, { state: 'IN_PROGRESS', count: 1 }],
      statusContextCountsByState: [{ state: 'FAILURE', count: 1 }],
    })).toEqual({ total: 5, passed: 2, skipped: 1, pending: 1, failed: 1 });
    expect(summarizeChecks({ totalCount: 1, checkRunCountsByState: null, statusContextCountsByState: [] })).toBeNull();
    expect(summarizeChecks({ totalCount: 1, checkRunCountsByState: [{ state: 'FUTURE_STATE', count: 1 }], statusContextCountsByState: [] })).toBeNull();
  });

  // Bug: #8476's head reported failed=1 because a concurrency-cancelled duplicate of a job that
  // later passed stayed in GitHub's rollup counts; AI tools and automation read it as a CI failure.
  // Minimal input: the same workflow job cancelled, then rerun successfully (unit). Workflow display
  // names are not unique, so a same-named job of another workflow (or one without an id) stays separate;
  // same-named jobs of one execution (one check suite, e.g. fixed-name matrix shards) all count.
  it('counts only the newest run of the same workflow job, and keeps counts when nodes are incomplete', () => {
    const run = (databaseId: number, conclusion: string, workflowId: number | null = 7, suiteId = databaseId) => ({ __typename: 'CheckRun', databaseId, name: 'check:basis',
      status: 'COMPLETED', conclusion, checkSuite: { databaseId: suiteId, app: { slug: 'github-actions' }, workflowRun: { workflow: { databaseId: workflowId } } } });
    const rollup = (nodes: ReturnType<typeof run>[], hasNextPage = false) => ({
      totalCount: nodes.length + 1,
      checkRunCountsByState: ['SUCCESS', 'CANCELLED', 'FAILURE'].map(state => ({ state, count: nodes.filter(n => n.conclusion === state).length })),
      statusContextCountsByState: [{ state: 'SUCCESS', count: 1 }],
      nodes: [...nodes, { __typename: 'StatusContext' }],
      pageInfo: { hasNextPage },
    });
    expect(summarizeChecks(rollup([run(1, 'CANCELLED'), run(2, 'SUCCESS')])))
      .toEqual({ total: 2, passed: 2, failed: 0, pending: 0, skipped: 0 });
    expect(summarizeChecks(rollup([run(2, 'FAILURE'), run(1, 'SUCCESS')])))
      .toEqual({ total: 2, passed: 1, failed: 1, pending: 0, skipped: 0 });
    expect(summarizeChecks(rollup([run(1, 'CANCELLED'), run(2, 'SUCCESS')], true)))
      .toMatchObject({ total: 3, failed: 1 });
    expect(summarizeChecks(rollup([run(1, 'FAILURE', 7), run(2, 'SUCCESS', 8)])))
      .toMatchObject({ total: 3, failed: 1 });
    expect(summarizeChecks(rollup([run(1, 'FAILURE', null), run(2, 'SUCCESS', null)])))
      .toMatchObject({ total: 3, failed: 1 });
    expect(summarizeChecks(rollup([run(1, 'FAILURE', 7, 5), run(2, 'SUCCESS', 7, 5)])))
      .toMatchObject({ total: 3, failed: 1 });
    expect(summarizeChecks(rollup([run(1, 'CANCELLED', 7, 4), run(2, 'FAILURE', 7, 5), run(3, 'SUCCESS', 7, 5)])))
      .toMatchObject({ total: 3, passed: 2, failed: 1 });
  });

  it('keeps one GraphQL request and reports truncated reviews as unknown', async () => {
    // The PR card's live strip also needs merge readiness; it rides on the same request.
    const pr = { headRefOid: 'head', mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED',
      commits: { nodes: [{ commit: { oid: 'head', statusCheckRollup: null } }] },
      reviewThreads: { nodes: [{ isResolved: false }], pageInfo: { hasNextPage: true } } };
    const graphql = vi.fn().mockResolvedValue({ repository: { pullRequest: pr } });
    expect(await fetchPrSummary({ graphql } as unknown as GithubClient, Q)).toEqual({ headOid: 'head', unresolved: null,
      checks: { total: 0, passed: 0, failed: 0, pending: 0, skipped: 0 }, mergeState: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED' });
    expect(graphql).toHaveBeenCalledTimes(1);
    pr.reviewThreads.pageInfo.hasNextPage = false;
    expect(await fetchPrSummary({ graphql } as unknown as GithubClient, Q)).toMatchObject({ unresolved: 1 });
    expect(graphql).toHaveBeenCalledTimes(2);
  });

  it('does not turn missing PR data or a changed head into zero/all passing', async () => {
    const graphql = vi.fn().mockResolvedValue({ repository: { pullRequest: null } });
    expect(await fetchPrSummary({ graphql } as unknown as GithubClient, Q)).toEqual({ headOid: null, unresolved: null, checks: null, mergeState: null, reviewDecision: null });
    graphql.mockResolvedValue({ repository: { pullRequest: { headRefOid: 'new', commits: { nodes: [{ commit: { oid: 'old', statusCheckRollup: null } }] }, reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } } } } });
    expect(await fetchPrSummary({ graphql } as unknown as GithubClient, Q)).toMatchObject({ unresolved: 0, checks: null });
  });

  it('returns refreshed counts on the first expired UI request while sharing in-flight work', async () => {
    let now = 0;
    const fetchPr = vi.fn().mockResolvedValue(remote({ checks: { total: 1, passed: 0, failed: 0, pending: 1, skipped: 0 } }));
    const svc = new PrStatusService({ readToken: TOKEN_OK, fetchPr, staleTtlMs: 0, now: () => now });
    await svc.getStatuses([Q]);
    now = 90_000;
    fetchPr.mockResolvedValue(remote({ checks: { total: 1, passed: 1, failed: 0, pending: 0, skipped: 0 } }));
    const [first, second] = await Promise.all([svc.getStatuses([Q]), svc.getStatuses([Q])]);
    expect(first[0]).toMatchObject({ checks: { passed: 1, pending: 0 } });
    expect(second).toEqual(first);
    expect(fetchPr).toHaveBeenCalledTimes(2);
  });
});

function remote(partial: Partial<PrRemoteState>): PrRemoteState {
  return {
    state: 'open',
    title: 't',
    html_url: 'https://github.com/makecindy/cindy/pull/85',
    branch: 'feat/x',
    ...partial,
  };
}

describe('mapRemoteToStatus', () => {
  it('四态映射:merged 优先于 closed,draft 仅在 open', () => {
    expect(mapRemoteToStatus(remote({ state: 'closed', merged: true }))).toBe('merged');
    expect(mapRemoteToStatus(remote({ state: 'closed', merged_at: '2026-06-12T00:00:00Z' }))).toBe(
      'merged',
    );
    expect(mapRemoteToStatus(remote({ state: 'closed' }))).toBe('closed');
    expect(mapRemoteToStatus(remote({ draft: true }))).toBe('draft');
    expect(mapRemoteToStatus(remote({}))).toBe('open');
  });
});

describe('filterPrStatusQueriesForRefs', () => {
  it('远程查询只保留目标 session 已记录的 PR,owner/repo 大小写不敏感', () => {
    expect(
      filterPrStatusQueriesForRefs(
        [
          { owner: 'MakeCindy', repo: 'Cindy', prNumber: 85 },
          { owner: 'private', repo: 'secret', prNumber: 1 },
        ],
        [{ owner: 'makecindy', repo: 'cindy', prNumber: 85 }],
      ),
    ).toEqual([{ owner: 'MakeCindy', repo: 'Cindy', prNumber: 85 }]);
  });
});

describe('PrStatusService', () => {
  it('expired credentials offer local sign-in while remote callers retain no-token', async () => {
    const svc = new PrStatusService({
      readToken: TOKEN_OK,
      fetchPr: async () => {
        throw Object.assign(new Error('Unauthorized'), { status: 401 });
      },
    });
    expect(await svc.getStatuses([Q])).toMatchObject([{ reason: 'gh-not-logged-in' }]);
    expect(await svc.getStatuses([Q], { remote: true })).toMatchObject([{ reason: 'no-token' }]);
  });
  it('正常查询返回状态与标题', async () => {
    const svc = new PrStatusService({
      readToken: TOKEN_OK,
      fetchPr: async () => remote({ merged: true, state: 'closed' }),
    });
    const [r] = await svc.getStatuses([Q]);
    expect(r).toMatchObject({ ok: true, status: 'merged', prNumber: 85 });
  });

  it('PR 源分支(head.ref)透传到结果', async () => {
    const svc = new PrStatusService({
      readToken: TOKEN_OK,
      fetchPr: async () => remote({ branch: 'fix/voice-input-enter-send' }),
    });
    expect((await svc.getStatuses([Q]))[0]).toMatchObject({
      ok: true,
      branch: 'fix/voice-input-enter-send',
    });
  });

  it('未解决 review thread 数透传;fetch 端缺省时归一为 null', async () => {
    const withCount = new PrStatusService({
      readToken: TOKEN_OK,
      fetchPr: async () => remote({ unresolved_count: 3 }),
    });
    expect((await withCount.getStatuses([Q]))[0]).toMatchObject({ ok: true, unresolvedCount: 3 });

    const withoutCount = new PrStatusService({
      readToken: TOKEN_OK,
      fetchPr: async () => remote({}),
    });
    expect((await withoutCount.getStatuses([Q]))[0]).toMatchObject({
      ok: true,
      unresolvedCount: null,
    });
  });

  it('TTL 内命中缓存,过期后重新拉取', async () => {
    let now = 0;
    const fetchPr = vi.fn(async () => remote({}));
    const svc = new PrStatusService({
      readToken: TOKEN_OK,
      fetchPr,
      cacheTtlMs: 100,
      now: () => now,
    });
    await svc.getStatuses([Q]);
    await svc.getStatuses([Q]);
    expect(fetchPr).toHaveBeenCalledTimes(1);
    now = 200;
    await svc.getStatuses([Q]);
    expect(fetchPr).toHaveBeenCalledTimes(2);
  });

  // 过期但未超 stale 窗:立即用旧值回答,后台复核一次;下一次查询拿到新值。
  // 修复前每 60s 过期都让一次 ~1.2s 的 GitHub 往返挡在侧栏 / 手机的状态查询前面。
  it('过期后先回旧值再后台复核,超过 stale 窗才同步等待', async () => {
    let now = 0;
    let resolveFetch!: (v: PrRemoteState) => void;
    const fetchPr = vi.fn(async () => remote({}));
    const svc = new PrStatusService({
      readToken: TOKEN_OK, fetchPr, cacheTtlMs: 100, staleTtlMs: 1_000, now: () => now,
    });
    expect((await svc.getStatuses([Q]))[0]).toMatchObject({ ok: true, status: 'open' });
    now = 200;
    fetchPr.mockImplementation(() => new Promise<PrRemoteState>((res) => (resolveFetch = res)));
    // Stale answer returns without waiting for the slow revalidation.
    expect((await svc.getStatuses([Q]))[0]).toMatchObject({ ok: true, status: 'open' });
    await vi.waitFor(() => expect(fetchPr).toHaveBeenCalledTimes(2));
    // A second stale read joins the same in-flight revalidation.
    expect((await svc.getStatuses([Q]))[0]).toMatchObject({ status: 'open' });
    expect(fetchPr).toHaveBeenCalledTimes(2);
    resolveFetch(remote({ merged: true, state: 'closed' }));
    await vi.waitFor(async () => expect((await svc.getStatuses([Q]))[0]).toMatchObject({ status: 'merged' }));
    // Beyond the stale window the read waits for GitHub again.
    now = 5_000;
    fetchPr.mockImplementation(async () => remote({ state: 'closed' }));
    expect((await svc.getStatuses([Q]))[0]).toMatchObject({ status: 'closed' });
    expect(fetchPr).toHaveBeenCalledTimes(3);
  });

  it('并发同一 PR 只发一次请求(in-flight 去重)', async () => {
    let resolveFetch!: (v: PrRemoteState) => void;
    const fetchPr = vi.fn(() => new Promise<PrRemoteState>((res) => (resolveFetch = res)));
    const svc = new PrStatusService({ readToken: TOKEN_OK, fetchPr });
    const p1 = svc.getStatuses([Q]);
    const p2 = svc.getStatuses([Q]);
    // readToken 是 async,等微任务推进到 fetchPr 真正被调用后再放行
    await vi.waitFor(() => expect(fetchPr).toHaveBeenCalled());
    resolveFetch(remote({}));
    await Promise.all([p1, p2]);
    expect(fetchPr).toHaveBeenCalledTimes(1);
  });

  it('gh 未登录返回 gh-not-logged-in 且不缓存(登录完立即生效)', async () => {
    let read: GhCliTokenReadResult = { ok: false, reason: 'gh-not-logged-in' };
    const fetchPr = vi.fn(async () => remote({}));
    const svc = new PrStatusService({ readToken: async () => read, fetchPr });
    const [r1] = await svc.getStatuses([Q]);
    expect(r1).toMatchObject({ ok: false, reason: 'gh-not-logged-in' });
    read = { ok: true, token: 'ghp_x' };
    const [r2] = await svc.getStatuses([Q]);
    expect(r2).toMatchObject({ ok: true, status: 'open' });
  });

  it('gh 未安装透传 gh-missing;超时 / 执行故障 / readToken 抛错归为 no-token', async () => {
    const fetchPr = vi.fn(async () => remote({}));
    const missing = new PrStatusService({
      readToken: async () => ({ ok: false, reason: 'gh-missing' }),
      fetchPr,
    });
    expect((await missing.getStatuses([Q]))[0]).toMatchObject({ ok: false, reason: 'gh-missing' });

    const timeout = new PrStatusService({
      readToken: async () => ({ ok: false, reason: 'gh-timeout' }),
      fetchPr,
    });
    expect((await timeout.getStatuses([Q]))[0]).toMatchObject({ ok: false, reason: 'no-token' });

    const execFailed = new PrStatusService({
      readToken: async () => ({ ok: false, reason: 'gh-exec-failed' }),
      fetchPr,
    });
    expect((await execFailed.getStatuses([Q]))[0]).toMatchObject({ ok: false, reason: 'no-token' });

    const thrown = new PrStatusService({
      readToken: async () => {
        throw new Error('boom');
      },
      fetchPr,
    });
    expect((await thrown.getStatuses([Q]))[0]).toMatchObject({ ok: false, reason: 'no-token' });
    expect(fetchPr).not.toHaveBeenCalled();
  });

  it('remote 查询把 gh-missing / gh-not-logged-in 归一为 no-token,其它 reason 不变', async () => {
    const fetchPr = vi.fn(async () => {
      throw Object.assign(new Error('nf'), { status: 404 });
    });
    for (const reason of ['gh-missing', 'gh-not-logged-in'] as const) {
      const svc = new PrStatusService({ readToken: async () => ({ ok: false, reason }), fetchPr });
      expect((await svc.getStatuses([Q], { remote: true }))[0]).toMatchObject({
        ok: false,
        reason: 'no-token',
      });
      expect((await svc.getStatuses([Q]))[0]).toMatchObject({ ok: false, reason });
    }
    const nf = new PrStatusService({ readToken: TOKEN_OK, fetchPr });
    expect((await nf.getStatuses([Q], { remote: true }))[0]).toMatchObject({
      ok: false,
      reason: 'not-found',
    });
  });

  it('fetch-failed 不缓存:瞬时网络错误后下一次查询立即重试', async () => {
    let failing = true;
    const fetchPr = vi.fn(async () => {
      if (failing) throw new Error('ECONNRESET');
      return remote({});
    });
    const svc = new PrStatusService({ readToken: TOKEN_OK, fetchPr });
    expect((await svc.getStatuses([Q]))[0]).toMatchObject({ ok: false, reason: 'fetch-failed' });
    // 网络恢复后,无需等 TTL,下一次查询直接成功
    failing = false;
    expect((await svc.getStatuses([Q]))[0]).toMatchObject({ ok: true, status: 'open' });
    expect(fetchPr).toHaveBeenCalledTimes(2);
  });

  it('not-found 会被缓存(确定性结果,避免对已删 PR 反复打 API)', async () => {
    const fetchPr = vi.fn(async () => {
      throw Object.assign(new Error('nf'), { status: 404 });
    });
    const svc = new PrStatusService({ readToken: TOKEN_OK, fetchPr });
    await svc.getStatuses([Q]);
    await svc.getStatuses([Q]);
    expect(fetchPr).toHaveBeenCalledTimes(1);
  });

  it('404 映射 not-found,其它错误映射 fetch-failed', async () => {
    const svc404 = new PrStatusService({
      readToken: TOKEN_OK,
      fetchPr: async () => {
        throw Object.assign(new Error('nf'), { status: 404 });
      },
    });
    expect((await svc404.getStatuses([Q]))[0]).toMatchObject({ ok: false, reason: 'not-found' });

    const svcNet = new PrStatusService({
      readToken: TOKEN_OK,
      fetchPr: async () => {
        throw new Error('ECONNRESET');
      },
    });
    expect((await svcNet.getStatuses([Q]))[0]).toMatchObject({ ok: false, reason: 'fetch-failed' });
  });

  it('批量查询上限 10 条,超出忽略', async () => {
    const fetchPr = vi.fn(async () => remote({}));
    const svc = new PrStatusService({ readToken: TOKEN_OK, fetchPr });
    const queries = Array.from({ length: 15 }, (_, i) => ({
      owner: 'o',
      repo: 'r',
      prNumber: i + 1,
    }));
    const results = await svc.getStatuses(queries);
    expect(results).toHaveLength(10);
    expect(fetchPr).toHaveBeenCalledTimes(10);
  });
});

// Unit: REST mergeable already reaches metadata, but a passing CI summary hid conflicts.
it.each([
  [false, true],
  [true, false],
  [null, null],
  [undefined, null],
] as const)('projects GitHub mergeable %s into conflicts %s', async (mergeable, conflicts) => {
  const service = new PrStatusService({
    readToken: TOKEN_OK,
    fetchPr: async () => remote({ metadata: { mergeable } }),
  });
  expect((await service.getStatuses([Q]))[0]).toMatchObject({ ok: true, conflicts });
});

// Unit: production MR fetch + shared status service, not a copied mapper.
// GitHub fixtures cannot detect GitLab pipeline selection/paging or credentials crossing hosts.
describe('GitLab MR status', () => {
  const q = {
    provider: 'gitlab' as const,
    host: 'git.example.com',
    owner: 'group/sub',
    repo: 'project',
    prNumber: 7,
  };
  const mr = () => ({
    state: 'opened',
    draft: false,
    title: 'MR title',
    sourceBranch: 'feature',
    diffHeadSha: 'head',
    resolvableDiscussionsCount: 5,
    resolvedDiscussionsCount: 3,
    headPipeline: {
      status: 'RUNNING',
      jobs: {
        count: 5,
        nodes: ['SUCCESS', 'FAILED', 'MANUAL', 'SKIPPED', 'CANCELED'].map((status) => ({ status })),
        pageInfo: { hasNextPage: false },
      },
    },
  });
  // Unit: use the same GraphQL response; omitted fields from older hosts remain unknown.
  it.each([true, false, null, undefined])('projects GitLab conflicts %s', async (conflicts) => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: { project: { mergeRequest: { ...mr(), conflicts } } },
          }),
        ),
    );
    const service = new PrStatusService({
      readToken: TOKEN_OK,
      readGitlabToken: async () => ({ ok: true, token: 'fake' }),
      fetchPr: vi.fn(),
      fetchGitlab: (token, query) => fetchGitlabMr(token, query, fetch),
    });
    expect((await service.getStatuses([q]))[0]).toMatchObject({
      ok: true,
      conflicts: conflicts ?? null,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('skips optional manual jobs but keeps blocking or unknown manual jobs pending', async () => {
    const value = mr();
    value.headPipeline.status = 'SUCCESS';
    const nodes = [
      { status: 'MANUAL', allowFailure: true },
      { status: 'MANUAL', allowFailure: false },
      { status: 'MANUAL' },
      { status: 'MANUAL', allowFailure: 'true' },
    ];
    value.headPipeline.jobs = {
      count: nodes.length,
      nodes,
      pageInfo: { hasNextPage: false },
    };
    const fetch = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const { query } = JSON.parse(String(init?.body));
      value.headPipeline.jobs.nodes = /nodes\s*\{[^}]*\ballowFailure\b/.test(query)
        ? nodes
        : nodes.map(({ status }) => ({ status }));
      return new Response(JSON.stringify({ data: { project: { mergeRequest: value } } }));
    });
    expect((await fetchGitlabMr('fake-token', q, fetch)).checks).toEqual({
      total: 4,
      passed: 0,
      failed: 0,
      pending: 3,
      skipped: 1,
    });
  });
  it('counts only latest GitLab jobs after a failed attempt is retried successfully', async () => {
    const attempts = [
      { status: 'FAILED', retried: true },
      { status: 'SUCCESS', retried: false },
      { status: 'SUCCESS', retried: false },
    ];
    const fetch = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const { query } = JSON.parse(String(init?.body));
      const nodes = /jobs\s*\([^)]*retried\s*:\s*false/.test(query)
        ? attempts.filter((job) => !job.retried)
        : attempts;
      const value = mr();
      value.headPipeline.status = 'SUCCESS';
      value.headPipeline.jobs = {
        count: nodes.length,
        nodes,
        pageInfo: { hasNextPage: false },
      };
      return new Response(JSON.stringify({ data: { project: { mergeRequest: value } } }));
    });

    expect((await fetchGitlabMr('fake-token', q, fetch)).checks).toEqual({
      total: 2,
      passed: 2,
      failed: 0,
      pending: 0,
      skipped: 0,
    });
  });
  it('reports zero checks without a head pipeline but keeps a missing diff head unknown', async () => {
    const value = { ...mr(), headPipeline: null };
    const fetch = vi.fn(
      async () => new Response(JSON.stringify({ data: { project: { mergeRequest: value } } })),
    );
    expect((await fetchGitlabMr('fake-token', q, fetch)).checks).toEqual({
      total: 0,
      failed: 0,
      passed: 0,
      pending: 0,
      skipped: 0,
    });
    value.diffHeadSha = '';
    expect((await fetchGitlabMr('fake-token', q, fetch)).checks).toBeNull();
  });
  it('summarizes GitLab-selected merged-result jobs', async () => {
    const value = mr();
    const pipeline = { ...value.headPipeline, sha: 'synthetic-merge-commit' };
    value.headPipeline = pipeline;
    const fetch = vi
      .fn()
      .mockImplementation(
        async () => new Response(JSON.stringify({ data: { project: { mergeRequest: value } } })),
      );
    expect(await fetchGitlabMr('fake-token', q, fetch)).toMatchObject({
      unresolved_count: 2,
      checks: { total: 5, passed: 1, failed: 2, pending: 1, skipped: 1 },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe('https://git.example.com/api/graphql');
    expect(JSON.parse(fetch.mock.calls[0][1].body).variables).toEqual({
      path: 'group/sub/project',
      iid: '7',
    });
    value.headPipeline.jobs.pageInfo.hasNextPage = true;
    expect((await fetchGitlabMr('fake-token', q, fetch)).checks).toBeNull();
    value.headPipeline.jobs.pageInfo.hasNextPage = false;
    value.headPipeline.jobs.nodes[0].status = 'FUTURE';
    expect((await fetchGitlabMr('fake-token', q, fetch)).checks).toBeNull();
  });
  it.each(['https://other.example.com/api/graphql', 'http://git.example.com/api/graphql'])(
    'never sends credentials to redirect %s',
    async (location) => {
      const fetch = vi
        .fn()
        .mockResolvedValue(new Response(null, { status: 302, headers: { location } }));
      await expect(fetchGitlabMr('fake-token', q, fetch)).rejects.toThrow();
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );
  it('makes no unauthenticated request, maps 401 to login and never falls back to GitHub', async () => {
    const github = vi.fn();
    const gitlab = vi.fn().mockRejectedValue({ status: 401 });
    const read = vi.fn().mockResolvedValue({ ok: false, reason: 'glab-missing' });
    const reject = vi.fn();
    const service = new PrStatusService({
      readToken: TOKEN_OK,
      fetchPr: github,
      readGitlabToken: read,
      fetchGitlab: gitlab,
      rejectGitlabToken: reject,
    });
    expect(await service.getStatuses([q])).toEqual([{ ...q, ok: false, reason: 'glab-missing' }]);
    expect(gitlab).not.toHaveBeenCalled();
    read.mockResolvedValue({ ok: true, token: 'fake-token' });
    expect(await service.getStatuses([q])).toEqual([
      { ...q, ok: false, reason: 'glab-not-logged-in' },
    ]);
    expect(read).toHaveBeenCalledWith(q.host);
    expect(reject).toHaveBeenCalledWith(q.host);
    expect(github).not.toHaveBeenCalled();
    expect(filterPrStatusQueriesForRefs([{ ...q, host: 'other.example.com' }, Q], [q])).toEqual([]);
  });
  // Unit regression: the focus handler used full invalidation, discarding successful
  // GitHub/GitLab caches and in-flight reads. Existing auth tests never crossed a
  // window focus. One cached PR, one pending PR and two MR hosts expose the loss.
  it('on window focus retries GitLab login failures without refetching successes or discarding in-flight reads', async () => {
    let signedIn = false;
    const healthy = { ...q, host: 'healthy.example.com' };
    const exec = vi.fn(
      (
        _file: string,
        args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string) => void,
      ) => callback(null, args.at(-1) === healthy.host || signedIn ? 'fake-token' : ''),
    );
    const tokens = createGlabCliTokenSource({
      exec: exec as unknown as typeof import('node:child_process').execFile,
      now: () => 0,
    });
    let finish!: (value: PrRemoteState) => void;
    let started!: () => void;
    const pending = new Promise<PrRemoteState>((resolve) => {
      finish = resolve;
    });
    const fetching = new Promise<void>((resolve) => {
      started = resolve;
    });
    const next = { ...Q, prNumber: 86 };
    const fetchPr = vi.fn(async (_token: string, query: typeof Q) => {
      if (query.prNumber === next.prNumber) {
        started();
        return pending;
      }
      return remote({});
    });
    const fetchGitlab = vi.fn(async () => remote({}));
    const service = new PrStatusService({
      readToken: TOKEN_OK,
      fetchPr,
      readGitlabToken: (host) => tokens.readTokenDetailed(host),
      invalidateGitlabTokenFailures: () => tokens.invalidateNegativeCache(),
      fetchGitlab,
      now: () => 0,
    });
    expect(await service.getStatuses([Q, q, healthy])).toMatchObject([
      { ok: true },
      { ok: false, reason: 'glab-not-logged-in' },
      { ok: true },
    ]);
    signedIn = true;
    expect((await service.getStatuses([q]))[0]).toMatchObject({ ok: false });
    const inFlight = service.getStatuses([next]);
    await fetching;
    service.invalidateGitlabAuthFailures();
    expect(await service.getStatuses([Q, q, healthy])).toMatchObject([
      { ok: true },
      { ok: true },
      { ok: true },
    ]);
    expect(fetchPr).toHaveBeenCalledTimes(2);
    expect(fetchGitlab).toHaveBeenCalledTimes(2);
    await tokens.readTokenDetailed(healthy.host);
    expect(exec).toHaveBeenCalledTimes(3);
    const joined = service.getStatuses([next]);
    finish(remote({ title: 'in flight' }));
    expect(await inFlight).toMatchObject([{ ok: true, title: 'in flight' }]);
    expect(await joined).toEqual(await inFlight);
    expect(await service.getStatuses([next])).toEqual(await inFlight);
    expect(fetchPr).toHaveBeenCalledTimes(2);
  });
  it('keeps legacy hosts from receiving MR queries on their GitHub channel', async () => {
    const invoke = vi.fn().mockImplementation(async (channel: string) => {
      if (channel === 'git-context:mr-status') throw new Error('CHANNEL_NOT_ALLOWED');
      return [{ ...Q, ok: false, reason: 'not-found' }];
    });
    expect(await remotePrStatuses([Q, q], 'session', invoke)).toEqual([
      { ...Q, ok: false, reason: 'not-found' },
      { ...q, ok: false, reason: 'unsupported' },
    ]);
    expect(invoke.mock.calls[0][1][0].queries).toEqual([Q]);
    expect(invoke.mock.calls[1][1][0].queries).toEqual([q]);
  });
  // Unit regression: transport failures must not claim an old host, or retry MRs as PRs.
  // The existing legacy-host test only exercised CHANNEL_NOT_ALLOWED.
  it.each([
    [
      Object.assign(new Error('blocked'), { code: 'DEVICE_LINK_CHANNEL_NOT_ALLOWED' }),
      'unsupported',
    ],
    [new Error('[UNSUPPORTED_CAPABILITY] old host'), 'unsupported'],
    [Object.assign(new Error('timed out'), { code: 'TIMEOUT' }), 'fetch-failed'],
    [
      new Error('[NOT_CONNECTED] disconnected; CHANNEL_NOT_ALLOWED is only diagnostic text'),
      'fetch-failed',
    ],
  ] as const)(
    'classifies remote MR failures without losing diagnostics: %s',
    async (error, reason) => {
      const invoke = vi.fn().mockRejectedValue(error);
      const reportError = vi.fn();
      expect(await remotePrStatuses([q], 'session', invoke, reportError)).toEqual([
        { ...q, ok: false, reason },
      ]);
      expect(invoke).toHaveBeenCalledExactlyOnceWith('git-context:mr-status', [
        { sessionId: 'session', queries: [q] },
      ]);
      expect(reportError).toHaveBeenCalledExactlyOnceWith(error);
    },
  );
});

// Rule (Dash, 2026-11-06): a PR follow-up should react when the title-bar refresh already saw the
// PR change, instead of waiting for its next cron look; no test covered status → schedule.
// Production entry: PrStatusService.getStatuses feeding the real PrFollowWatch (unit, fake clock).
// Minimal inputs: one head change, a schedule for #8 next to one for #85, one in flight.
describe('PR follow watch', () => {
  const schedule = (id: string, url: string, extra: Record<string, unknown> = {}) =>
    ({ id, status: 'active', recurring: true, manual: false, preRunHook: { command: `node "/s/pr-heartbeat-gate.mjs" ${url}` }, ...extra }) as never;
  function setup() {
    let now = 0;
    let head = 'a1';
    const runNow = vi.fn(async () => ({ runId: 'r' }));
    const inflight = vi.fn(() => 0);
    const hasCapacity = vi.fn(() => true);
    const autoRunAllowed = vi.fn(() => true);
    const watch = new PrFollowWatch({
      listActive: async () => [
        schedule('follow-85', 'https://github.com/MakeCindy/cindy/pull/85'),
        schedule('follow-8', 'https://github.com/makecindy/cindy/pull/8'),
        schedule('other', 'https://github.com/makecindy/cindy/pull/850'),
        schedule('once', 'https://github.com/makecindy/cindy/pull/85', { recurring: false }),
        schedule('manual', 'https://github.com/makecindy/cindy/pull/85', { manual: true }),
      ],
      inflight,
      hasCapacity,
      autoRunAllowed,
      runNow,
      now: () => now,
    });
    const svc = new PrStatusService({
      readToken: TOKEN_OK,
      fetchPr: async () => remote({ head_sha: head } as Partial<PrRemoteState>),
      cacheTtlMs: 1,
      staleTtlMs: 0,
      now: () => now,
      onObserved: (query, result) => watch.observe(query, result),
    });
    const look = async (at: number, nextHead = head) => {
      now = at;
      head = nextHead;
      await svc.getStatuses([Q], { waitForFresh: true });
      await new Promise((resolve) => setImmediate(resolve));
    };
    return { look, runNow, inflight, hasCapacity, autoRunAllowed, watch };
  }

  it('runs only recurring schedules naming this PR, once per change, skipping in-flight and recent ones', async () => {
    const { look, runNow, inflight } = setup();
    await look(10);
    await look(20);
    expect(runNow).not.toHaveBeenCalled();
    await look(30, 'b2');
    expect(runNow.mock.calls).toEqual([['follow-85', { kind: 'watch', source: 'pr-status', detail: 'https://github.com/makecindy/cindy/pull/85' }]]);
    await look(40, 'c3');
    expect(runNow).toHaveBeenCalledTimes(1);
    inflight.mockReturnValue(1);
    await look(70_000, 'd4');
    expect(runNow).toHaveBeenCalledTimes(1);
    inflight.mockReturnValue(0);
    await look(80_000, 'e5');
    expect(runNow).toHaveBeenCalledTimes(2);
  });

  // Review (Greptile P1 on #9022): run-now skips the scheduler's concurrency cap, so a burst of PR
  // changes could start more agents than maxConcurrentRuns. Minimal input: one change while no slot is
  // free, then a later refresh once a slot opens (unit).
  it('waits for a free scheduler slot instead of exceeding the cap, and runs on the next refresh', async () => {
    const { look, runNow, hasCapacity } = setup();
    await look(10);
    hasCapacity.mockReturnValue(false);
    await look(100_000, 'b2');
    expect(runNow).not.toHaveBeenCalled();
    hasCapacity.mockReturnValue(true);
    await look(200_000);
    expect(runNow).toHaveBeenCalledTimes(1);
    await look(300_000);
    expect(runNow).toHaveBeenCalledTimes(1);
  });

  // Review (Codex P2 on #9022): a passive instance shares data with another one that owns automatic runs.
  it('never starts runs on a passive scheduler instance', async () => {
    const { look, runNow, autoRunAllowed } = setup();
    autoRunAllowed.mockReturnValue(false);
    await look(10);
    await look(100_000, 'b2');
    expect(runNow).not.toHaveBeenCalled();
  });

  // App comments can be new without changing the PR summary. Queued wakeups retain owner guards.
  it('handles doorbells without a baseline and drops pending work when its connection changes', async () => {
    const { watch, runNow, hasCapacity, look } = setup();
    let current = true;
    hasCapacity.mockReturnValue(false);
    await watch.notify('https://github.com/makecindy/cindy/pull/85', () => current);
    expect(runNow).not.toHaveBeenCalled();
    current = false;
    hasCapacity.mockReturnValue(true);
    await look(10);
    expect(runNow).not.toHaveBeenCalled();
    await watch.notify('https://github.com/makecindy/cindy/pull/85', () => true);
    expect(runNow).toHaveBeenCalledTimes(1);
    await watch.notify('https://github.com/makecindy/cindy/pull/85', () => true);
    expect(runNow).toHaveBeenCalledTimes(1);
  });

  // Explicit PR pre-run checks keep their existing event wakeup. Busy peers must
  // recover without another GitHub read, and must not rerun siblings that already handled the bell.
  it('wakes gated follows after capacity returns without repeating an already handled sibling', async () => {
    vi.useFakeTimers();
    let busy = true;
    const url = 'https://github.com/example/project/pull/85';
    const runNow = vi.fn<(id: string) => Promise<null>>(async () => null);
    const watch = new PrFollowWatch({
      listActive: async () => ['first', 'busy', 'paused', 'explicit-app'].map(id => schedule(id, url, {
        status: id === 'paused' ? 'paused' : 'active',
        webhookTrigger: id === 'explicit-app' ? { source: { preset: 'github-app', repositories: ['example/project'] } } : undefined,
      })),
      inflight: id => id === 'busy' && busy ? 1 : 0,
      hasCapacity: () => true, autoRunAllowed: () => true, runNow,
    });
    try {
      await watch.notify(url);
      expect(runNow.mock.calls.map(call => call[0])).toEqual(['first']);
      busy = false;
      await vi.advanceTimersByTimeAsync(5000);
      expect(runNow.mock.calls.map(call => call[0])).toEqual(['first', 'busy']);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(runNow).toHaveBeenCalledTimes(2);
    } finally { vi.clearAllTimers(); vi.useRealTimers(); }
  });

  // PR #9378 security review: a PR URL in an ordinary script is not event consent.
  // Unit: subscription discovery + real comment/status wakeups, including deferred work;
  // the previous script-only happy path did not distinguish consent from incidental URLs.
  it('does not subscribe or wake ordinary scripts that only mention a PR URL', async () => {
    vi.useFakeTimers();
    const url = 'https://github.com/makecindy/cindy/pull/85';
    let tasks = [schedule('ordinary', url, {
      preRunHook: undefined, executionMode: 'script', scriptConfig: { command: `node report.mjs ${url}` },
    })];
    const runNow = vi.fn(async () => null);
    let capacity = false;
    const watch = new PrFollowWatch({ listActive: async () => tasks,
      inflight: () => 0, hasCapacity: () => capacity, autoRunAllowed: () => true, runNow });
    const ok = (headSha: string) => ({ ok: true, status: 'open', prNumber: 85, headSha }) as never;
    try {
      expect(followedGithubPrs(tasks)).toEqual([]);
      await watch.notify(url);
      watch.observe(Q, ok('old'));
      watch.observe(Q, ok('new'));
      await vi.advanceTimersByTimeAsync(5_000);
      capacity = true;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(runNow).not.toHaveBeenCalled();

      // Removing a genuine follower's gate while it waits must also revoke its wakeup.
      capacity = false;
      tasks = [schedule('ordinary', url)];
      expect(followedGithubPrs(tasks)).toEqual([url]);
      await watch.notify(url);
      tasks = [schedule('ordinary', url, { preRunHook: undefined,
        executionMode: 'script', scriptConfig: { command: `node report.mjs ${url}` } })];
      capacity = true;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(runNow).not.toHaveBeenCalled();
    } finally { vi.clearAllTimers(); vi.useRealTimers(); }
  });

  it('treats failed reads as no news and keeps the baseline', async () => {
    const runNow = vi.fn(async () => null);
    const watch = new PrFollowWatch({
      listActive: async () => [schedule('follow-85', 'https://github.com/makecindy/cindy/pull/85')],
      inflight: () => 0,
      hasCapacity: () => true,
      autoRunAllowed: () => true,
      runNow,
    });
    const ok = (headSha: string) => ({ ok: true, status: 'open', prNumber: 85, headSha }) as never;
    const settle = () => new Promise((resolve) => setImmediate(resolve));
    watch.observe(Q, ok('a1'));
    watch.observe(Q, { ok: false, prNumber: 85, reason: 'fetch-failed' } as never);
    watch.observe(Q, ok('a1'));
    await settle();
    expect(runNow).not.toHaveBeenCalled();
    watch.observe(Q, ok('b2'));
    await settle();
    expect(runNow).toHaveBeenCalledTimes(1);
    expect(prStatusSignature({ ok: false, prNumber: 85, reason: 'fetch-failed' } as never)).toBeNull();
  });
});
