import { createGlabCliTokenSource, readGitlabStatusToken } from '../git-context/glabCliTokenSource';
import { fetchGitlabMr, fetchGitlabMrStatus } from '../git-context/gitlabPrSummary';
import { normalizePrTrigger } from '@cindy/maker-scheduler/pr-trigger';
import { remotePrStatuses } from '@cindy/maker-shared';
/**
 * git-context/prStatusService 单测 — 状态映射、TTL 缓存、in-flight 去重、
 * gh 缺失/未登录降级(不缓存,远端归一 no-token)、404/网络错误映射。依赖全注入,零网络零 Electron。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import {
  Scheduler,
  type ListFilter,
  type Schedule as EngineSchedule,
  type ScheduleRun,
  type ScheduleStorage,
} from '@cindy/maker-scheduler';
import { executePreRunHook } from '../scheduler-host/pre-run-hook';

import {
  PrStatusService,
  createPrStatusBroadcastGate,
  filterPrStatusQueriesForRefs,
  mapRemoteToStatus,
  withoutPrMetadata,
  type PrRemoteState,
} from '../git-context/prStatusService';
import type { GhCliTokenReadResult } from '../git-context/ghCliTokenSource';
import { fetchPrSummary, summarizeChecks } from '../git-context/prSummary';
import { PrFollowWatch, prStatusSignature } from '../git-context/prFollowWatch';
import { admitTaskAction, assertTaskActionCurrent } from '../maker-ipc/taskActionAuthorization';
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

  // Protocol (git-context:pr-status / mr-status answer): status chips never read `metadata`
  // (PR body, author/reviewer objects). Logs showed ~11 KB per answer over device-link, the
  // second-largest result stream. The channel answer drops it; the service result keeps it for
  // the main-process GitHub read tools (get_pr_changes).
  it('keeps metadata for GitHub read tools but drops it from status channel answers', async () => {
    const svc = new PrStatusService({
      readToken: TOKEN_OK,
      fetchPr: async () => remote({ metadata: { body: 'x'.repeat(8_000), author: { login: 'a' } } }),
    });
    const [full] = await svc.getStatuses([Q]);
    expect(full).toMatchObject({ ok: true, metadata: { author: { login: 'a' } } });
    const answer = withoutPrMetadata(full);
    expect(answer).not.toHaveProperty('metadata');
    expect(answer).toMatchObject({ ok: true, status: 'open', prNumber: 85, title: full.ok ? full.title : '' });
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
  it('prefers the exact plugin host over local glab, falls back to glab, and discards a read across an account switch', async () => {
    const cli = createGlabCliTokenSource({ exec: vi.fn((_bin, _args, _opts, cb) => cb({ code: 'ENOENT' }, '')) as never });
    let owner = 'first';
    const readPlugin = vi.fn(async (host: string) => host === q.host ? 'fixture' : null);
    expect(await readGitlabStatusToken(q.host, cli, () => owner, readPlugin)).toEqual({ ok: true, token: 'fixture' });
    expect(await readGitlabStatusToken('other.example.com', cli, () => owner, readPlugin)).toMatchObject({ ok: false });
    expect(await readGitlabStatusToken(q.host, cli, () => owner, async () => {
      owner = 'second';
      return 'fixture';
    })).toMatchObject({ ok: false });
    cli.rejectToken(q.host);
    expect(await readGitlabStatusToken(q.host, cli, () => owner, async () => null)).toEqual({ ok: false, reason: 'glab-not-logged-in' });
  });

  // The title bar should remain usable on self-managed instances with an older GraphQL schema.
  it('keeps REST status and a scoped URL when optional summaries fail', async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => String(input).endsWith('/api/graphql')
      ? Response.json({ errors: [{ message: 'Unknown field' }] })
      : Response.json({ iid: 7, title: 'Fix', state: 'opened', draft: true, source_branch: 'feature', sha: 'head' }));
    expect(await fetchGitlabMrStatus('fake', q, fetch)).toMatchObject({
      state: 'open', draft: true, title: 'Fix', checks: null, unresolved_count: null,
      html_url: 'https://git.example.com/group/sub/project/-/merge_requests/7',
    });
    expect(fetch.mock.calls[0]?.[0]).toBe('https://git.example.com/api/v4/projects/group%2Fsub%2Fproject/merge_requests/7');
  });
  // Unit regression for #12168: an unresponsive optional endpoint withheld a valid MR badge on mobile.
  // The schema-error case above returns immediately and cannot catch a blocked supplement.
  it('returns REST status when the concurrent GraphQL summary exhausts its shorter deadline', async () => {
    const rest = new AbortController();
    const summary = new AbortController();
    const deadline = vi.spyOn(AbortSignal, 'timeout')
      .mockReturnValueOnce(rest.signal)
      .mockReturnValueOnce(summary.signal);
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/api/graphql')) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
        });
      }
      return Response.json({ iid: 7, title: 'Fix', state: 'opened', source_branch: 'feature', sha: 'head' });
    });
    try {
      const status = fetchGitlabMrStatus('fake', q, fetch);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(deadline.mock.calls[1]![0]).toBeLessThan(deadline.mock.calls[0]![0]);
      summary.abort();
      await expect(status).resolves.toMatchObject({ state: 'open', title: 'Fix', checks: null });
    } finally {
      summary.abort();
      deadline.mockRestore();
    }
  });
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
    expect(runNow.mock.calls).toEqual([['follow-85', { kind: 'watch', source: 'pr-status', detail: 'https://github.com/makecindy/cindy/pull/85' }, expect.objectContaining({ id: 'follow-85' }), undefined]]);
    await look(40, 'c3');
    expect(runNow).toHaveBeenCalledTimes(1);
    inflight.mockReturnValue(1);
    await look(70_000, 'd4');
    expect(runNow).toHaveBeenCalledTimes(1);
    inflight.mockReturnValue(0);
    await look(80_000, 'e5');
    expect(runNow).toHaveBeenCalledTimes(2);
  });

  // Unit regression: a PR event delivered from an expired tool context used to pass
  // its pre-check but fail the session send. Ordinary tests run without a caller.
  it('dispatches the scheduled turn independently of the expired action that observed the PR', async () => {
    const { watch, runNow } = setup();
    runNow.mockImplementation(async () => {
      await assertTaskActionCurrent();
      return { runId: 'scheduled-turn' };
    });
    let current = true;
    const decision = await admitTaskAction(
      { server: 'cindy_helper', sessionId: 'caller', tool: 'manage_session_prs', args: {} },
      { key: 'input', ownerInput: true, delegated: false, assertCurrent: async () => {
        if (!current) throw new Error('TASK_ACTION_AUTHORIZATION_EXPIRED');
      } },
    );
    if (!decision.ok || !decision.run) throw new Error('missing action scope');
    await decision.run(async () => {
      current = false;
      await watch.notify('https://github.com/makecindy/cindy/pull/85');
      await expect(assertTaskActionCurrent()).rejects.toThrow('TASK_ACTION_AUTHORIZATION_EXPIRED');
    });
    expect(runNow).toHaveBeenCalledOnce();
    await expect(runNow.mock.results[0]!.value).resolves.toEqual({ runId: 'scheduled-turn' });
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

  // 2026-11-24: a specific GitLab MR is a prTrigger followed by timed status reads. It must never be
  // sent to the GitHub App subscription, and a verified merge observed by the shared reader runs it.
  it('follows a GitLab MR trigger through status observations only', async () => {
    const mr = 'https://gitlab.example.com/group/app/-/merge_requests/12';
    const tasks = [schedule('mr', mr, { prTrigger: { url: mr, change: 'merged' } })];
    const runNow = vi.fn(async () => null);
    const watch = new PrFollowWatch({ listActive: async () => tasks, runNow, inflight: () => 0,
      autoRunAllowed: () => true, hasCapacity: () => true });
    expect(followedGithubPrs(tasks)).toEqual([]);
    const query = { provider: 'gitlab' as const, host: 'gitlab.example.com', owner: 'group', repo: 'app', prNumber: 12 };
    watch.observe(query, { ok: true, status: 'open' } as never);
    watch.observe(query, { ok: true, status: 'merged' } as never);
    await new Promise(resolve => setImmediate(resolve));
    expect(runNow).toHaveBeenCalledTimes(1);
    expect(runNow.mock.calls[0]?.slice(0, 3)).toEqual(['mr', expect.objectContaining({ detail: mr }), tasks[0]]);
  });

  it('runs the selected merge condition for event-only automations, independent of an incidental hook URL', async () => {
    const target = 'https://github.com/makecindy/cindy/pull/85';
    const other = 'https://github.com/makecindy/cindy/pull/8';
    const tasks = [schedule('merged', other, { manual: true, prTrigger: { url: target, change: 'merged' } }),
      schedule('disabled', target, { prTrigger: null })];
    const runNow = vi.fn(async () => null);
    const watch = new PrFollowWatch({ listActive: async () => tasks, runNow, inflight: () => 0,
      autoRunAllowed: () => true, hasCapacity: () => true });
    expect(followedGithubPrs(tasks)).toEqual([target]);
    await watch.notify(other);
    await watch.notify(target);
    watch.observe(Q, { ok: true, status: 'open' } as never);
    watch.observe(Q, { ok: true, status: 'closed' } as never);
    await new Promise(resolve => setImmediate(resolve));
    expect(runNow).not.toHaveBeenCalled();
    watch.observe(Q, { ok: true, status: 'merged' } as never);
    await new Promise(resolve => setImmediate(resolve));
    expect(runNow).toHaveBeenCalledTimes(1);
    expect(runNow).toHaveBeenCalledWith('merged', expect.objectContaining({ detail: target }), tasks[0], undefined);
  });

  // #11309: a failed timed check can advance lastFiredAt without handling the merge.
  it('recovers an unseen merge after a failed check, and skips a previously processed merge after restart', async () => {
    const url = 'https://github.com/makecindy/cindy/pull/85';
    const task = schedule('merge', url, { createdAt: 1, lastFiredAt: 30, prTrigger: { url, change: 'merged' } });
    const runNow = vi.fn(async () => null);
    const hasSuccessfulPrRunSince = vi.fn(async () => false);
    const watch = new PrFollowWatch({ listActive: async () => [task], inflight: () => 0,
      autoRunAllowed: () => true, hasCapacity: () => true, hasSuccessfulPrRunSince, runNow });
    const merged = { ok: true, status: 'merged', metadata: { merged_at: new Date(20).toISOString() } } as never;
    watch.observe(Q, { ok: false, reason: 'fetch-failed' } as never);
    watch.observe(Q, merged);
    await new Promise(resolve => setImmediate(resolve));
    expect(runNow).toHaveBeenCalledTimes(1);
    expect(hasSuccessfulPrRunSince).toHaveBeenCalledWith('merge', 20);
    watch.reset();
    hasSuccessfulPrRunSince.mockResolvedValue(true);
    watch.observe(Q, merged);
    await new Promise(resolve => setImmediate(resolve));
    expect(runNow).toHaveBeenCalledTimes(1);
  });

  // #12168: consecutive REST reads of the same head can have a missing GraphQL
  // summary. Losing and regaining detail must not dispatch an otherwise idle task.
  it('observes verified MR changes across missing summaries and resets the summary on a new head', async () => {
    const target = { provider: 'gitlab' as const, host: 'git.example.com', owner: 'group', repo: 'project', prNumber: 7 };
    const url = 'https://git.example.com/group/project/-/merge_requests/7';
    const tasks = (['any', 'ci', 'review'] as const).map(change =>
      schedule(change, url, { preRunHook: undefined, prTrigger: { url, change } }));
    const runNow = vi.fn(async (_id: string) => null);
    let now = 0;
    const watch = new PrFollowWatch({ listActive: async () => tasks, runNow, inflight: () => 0,
      autoRunAllowed: () => true, hasCapacity: () => true, now: () => now });
    const observe = async (headSha: string, failed: number | null, unresolvedCount: number | null, notes = 0) => {
      now += 300_000;
      runNow.mockClear();
      watch.observe(target, { ...target, ok: true, status: 'open', htmlUrl: url, title: 'Fix', branch: 'fix',
        headSha, checks: failed === null ? null : { total: 1, passed: 1 - failed, failed, pending: 0, skipped: 0 },
        unresolvedCount, metadata: { user_notes_count: notes } });
      await new Promise(resolve => setImmediate(resolve));
      return runNow.mock.calls.map(([id]) => id);
    };
    expect(await observe('head1', null, null)).toEqual([]);
    expect(await observe('head1', 0, 0)).toEqual([]);
    expect(await observe('head1', null, null)).toEqual([]);
    expect(await observe('head1', 0, 0)).toEqual([]);
    expect(await observe('head1', null, null, 1)).toEqual(['any', 'review']);
    expect(await observe('head1', 1, 1, 1)).toEqual(['any', 'ci', 'review']);
    expect(await observe('head2', null, null, 1)).toEqual(['any']);
    expect(await observe('head2', 0, 0, 1)).toEqual([]);
  });

  // Restart the watcher between reads; only the successful run's dispatch facts survive.
  it('recovers offline MR changes once per successful observation, including across restarts', async () => {
    const target = { provider: 'gitlab' as const, host: 'git.example.com', owner: 'group/sub', repo: 'project', prNumber: 7 };
    const url = 'https://git.example.com/group/sub/project/-/merge_requests/7';
    const task = schedule('review-mr', url, { createdAt: 1, prTrigger: { url, change: 'any' } });
    const runNow = vi.fn(async () => null);
    let last: { url: string; signature: string } | null = null;
    const restart = async (unresolvedCount: number | null, failed: number | null, pipelineId = 1) => {
      const watch = new PrFollowWatch({ listActive: async () => [task], inflight: () => 0,
        autoRunAllowed: () => true, hasCapacity: () => true, lastSuccessfulMrObservation: async () => last, runNow });
      const status = { ...target, ok: true as const, status: 'open' as const, title: 'Fix', branch: 'fix',
        htmlUrl: url, headSha: 'abc', unresolvedCount, metadata: { pipeline_id: pipelineId }, checks: failed === null ? null :
          { total: 1, failed, pending: 0, passed: 1 - failed, skipped: 0 } };
      watch.observe(target, status);
      await watch.reconcileInitialMrWork(task, status);
      return { url, signature: prStatusSignature(status)! };
    };
    await restart(0, 0);
    expect(runNow).not.toHaveBeenCalled();
    last = await restart(1, 0);
    expect(runNow).toHaveBeenLastCalledWith('review-mr', expect.objectContaining({ detail: url }), task, last);
    await restart(null, null);
    await restart(1, 0);
    expect(runNow).toHaveBeenCalledTimes(1);
    await restart(2, 1); // failed or interrupted execution: the receipt does not advance
    last = await restart(2, 1);
    await restart(2, 1);
    expect(runNow).toHaveBeenCalledTimes(3);
    last = await restart(2, 1, 2); // another failed pipeline on the same commit
    await restart(2, 1, 2);
    expect(runNow).toHaveBeenCalledTimes(4);
    last = { ...last, url: url.replace('git.example', 'other.example') };
    await restart(2, 1, 2);
    expect(runNow).toHaveBeenCalledTimes(5);
  });

  it('keeps GitLab follow-ups local and recovers a merge missed while the host was offline', async () => {
    const url = 'https://git.example.com/group/sub/project/-/merge_requests/7';
    const prTrigger = normalizePrTrigger({ url: url.toUpperCase().replace('HTTPS:', 'https:'), change: 'any' });
    expect(prTrigger.url).toBe(url);
    const task = schedule('mr', url, { createdAt: 1, preRunHook: undefined, prTrigger });
    expect(followedGithubPrs([task])).toEqual([]);
    const runNow = vi.fn(async () => null);
    const watch = new PrFollowWatch({ listActive: async () => [task], inflight: () => 0,
      autoRunAllowed: () => true, hasCapacity: () => true, runNow });
    watch.observe({ host: 'git.example.com', provider: 'gitlab', owner: 'group/sub', repo: 'project', prNumber: 7 },
      { ok: true, status: 'merged', metadata: { merged_at: new Date(20).toISOString() } } as never);
    await new Promise(resolve => setImmediate(resolve));
    expect(runNow).toHaveBeenCalledWith('mr', expect.objectContaining({ detail: url }), task, expect.objectContaining({ url }));
  });

  it('filters CI, review and recovery wakeups for ordinary tasks with no gate', async () => {
    const url = 'https://github.com/makecindy/cindy/pull/85';
    const tasks = (['ci', 'review', 'merged', 'any'] as const).map(change =>
      schedule(change, url, { manual: true, preRunHook: undefined, prTrigger: { url, change } }));
    const runNow = vi.fn(async (_id: string) => null);
    const watch = new PrFollowWatch({ listActive: async () => tasks, runNow, inflight: () => 0,
      autoRunAllowed: () => true, hasCapacity: () => true });
    await watch.notifyChange(url, 'reconcile', () => true);
    expect(runNow).not.toHaveBeenCalled();
    const open = { ok: true, status: 'open', checks: { total: 1, pending: 1 } };
    watch.observe(Q, open as never);
    watch.observe(Q, { ...open, checks: { total: 1, passed: 1 } } as never);
    await new Promise(resolve => setImmediate(resolve));
    expect(runNow.mock.calls.map(([id]) => id)).toEqual(['ci', 'any']);
    await watch.notifyChange(url, 'review', () => true);
    expect(runNow.mock.calls.map(([id]) => id)).toEqual(['ci', 'any', 'review']);
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

  // PR 11309, unit: the bound runner can discover a busy session after admission.
  // A successful status sample with the same signature would never wake the task again.
  it.each([true, false])('retains a runner-deferred merge only while the trigger applies (active=%s)', async (active) => {
    vi.useFakeTimers();
    try {
      const url = 'https://github.com/makecindy/cindy/pull/85';
      let task = schedule('merge', url, { preRunHook: undefined, prTrigger: { url, change: 'merged' } });
      const runNow = vi.fn(async () => ({ runId: 'merge-run', deferred: false }));
      runNow.mockResolvedValueOnce({ runId: 'deferred-run', deferred: true });
      const watch = new PrFollowWatch({
        listActive: async () => [task], inflight: () => 0, hasCapacity: () => true, autoRunAllowed: () => true, runNow,
      });
      await watch.notifyChange(url, 'merged', () => true);
      expect(runNow).toHaveBeenCalledOnce();
      if (!active) task = schedule('merge', url, { preRunHook: undefined, prTrigger: null });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(runNow).toHaveBeenCalledTimes(active ? 2 : 1);
      if (active) expect(runNow).toHaveBeenLastCalledWith('merge', { kind: 'watch', source: 'pr-status', detail: url }, task, undefined);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(runNow).toHaveBeenCalledTimes(active ? 2 : 1);
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

  // 测试价值
  // - 生产入口与可观察结果：refreshGithubPrEvents + PrStatusService + PrFollowWatch 在连续 overflow 批次与忙顺延下的触发次数与参数。
  // - 规则依据：docs/product-rules/github-status-and-associations.md（omitted > 0 补查找回评论变化）与 docs/dev-rules/server-channel-review.md（无关仓库高频 CI 溢出不得每分钟拉起全部跟进任务）。
  // - 现有覆盖缺口：既有 overflow 用例仅验证单次调用，未覆盖同一 updated_at 连续溢出静默、评论推进 updated_at 立即补查，以及旧式无 prTrigger 跟进任务的 runner 顺延保留。
  // - 最小失败输入：同一 PR 连续三次 overflow（第二次无变化、第三次仅 updated_at 推进）+ 首次执行返回 deferred。
  // - tier：unit（fake timers，纯内存替身）。
  it('suppresses repeated overflow reconciles when updated_at is unchanged, wakes on new comment timestamps, and retains deferred legacy follows', async () => {
    vi.useFakeTimers();
    const url = 'https://github.com/makecindy/cindy/pull/85';
    let updatedAt = '2026-11-25T02:00:00Z';
    const runNow = vi.fn(async () => ({ runId: 'r-ok', deferred: false }));
    runNow.mockResolvedValueOnce({ runId: 'r-deferred', deferred: true });
    const legacyTask = schedule('legacy-follow-324', url);
    const watch = new PrFollowWatch({
      listActive: async () => [legacyTask],
      inflight: () => 0,
      hasCapacity: () => true,
      autoRunAllowed: () => true,
      runNow,
    });
    const svc = new PrStatusService({
      readToken: TOKEN_OK,
      fetchPr: async () => remote({ head_sha: 'a1', metadata: { updated_at: updatedAt } }),
      onObserved: (query, result) => watch.observe(query, result),
    });
    try {
      // First overflow without prior baseline reconciles once; runner defers, and legacy task retains the retry.
      await refreshGithubPrEvents(svc, watch, [url], () => true, { reason: 'overflow', notify: [url] });
      expect(runNow).toHaveBeenCalledTimes(1);
      expect(runNow).toHaveBeenLastCalledWith(
        'legacy-follow-324',
        { kind: 'watch', source: 'pr-status', detail: url, reason: 'reconcile' },
        legacyTask,
        undefined,
      );
      await vi.advanceTimersByTimeAsync(60_000);
      expect(runNow).toHaveBeenCalledTimes(2);

      // Subsequent overflow batches from busy sibling repos with identical summary + updated_at stay quiet.
      await vi.advanceTimersByTimeAsync(60_000);
      await refreshGithubPrEvents(svc, watch, [url], () => true, { reason: 'overflow', notify: [url] });
      await vi.advanceTimersByTimeAsync(60_000);
      await refreshGithubPrEvents(svc, watch, [url], () => true, { reason: 'overflow', notify: [url] });
      expect(runNow).toHaveBeenCalledTimes(2);

      // A new issue comment during overflow advances updated_at without changing status counts -> wakes immediately.
      updatedAt = '2026-11-25T02:05:00Z';
      await vi.advanceTimersByTimeAsync(60_000);
      await refreshGithubPrEvents(svc, watch, [url], () => true, { reason: 'overflow', notify: [url] });
      expect(runNow).toHaveBeenCalledTimes(3);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  // 测试价值
  // - 生产入口与可观察结果：真实 Scheduler + executePreRunHook(stdin trigger 管道) + PrStatusService + PrFollowWatch + refreshGithubPrEvents 全链路下，验证 waiting(human) 长期无事件退避、显式评论即时唤醒、updated_at 缺失节流兜底以及 overflow 丢评论的双重恢复（updated_at 推进即时补查 + 定时 probe 兜底）。
  // - 规则依据：docs/product-rules/github-status-and-associations.md 与 docs/dev-rules/server-channel-review.md。
  // - 现有覆盖缺口：既有测试用 mock runNow 替身，未打通真实 preRunHook 子进程 stdin trigger 与 gate 状态机的退避/唤醒闭环，也未覆盖 updated_at 缺失与同秒漏更新的 probe 兜底。
  // - 最小失败输入：waiting(human) 基线后经历 25 分钟定时 tick + 无关 overflow、显式评论、缺失 updated_at 的连续 overflow 及丢事件的评论更新。
  // - tier：unit（临时目录真实门禁脚本 + FakeClock）。
  it('verifies waiting(human) backoff, instant explicit-comment wakeup, missing-updated_at fallback, and overflow dropped-comment recovery through real executePreRunHook', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-pr-gate-e2e-'));
    const stateFile = path.join(tmpDir, 'gate-state.json');
    const worldFile = path.join(tmpDir, 'pr-world.json');
    const gateScript = path.join(tmpDir, 'pr-heartbeat-gate.mjs');
    const url = 'https://github.com/makecindy/cindy/pull/85';

    // Mirrors official pr-heartbeat-gate.mjs + follow-pacing.mjs contract:
    // reads stdin JSON { trigger }, enforces 30m waiting(human) pace unless triggered,
    // runs cheap remarks probe when due, and passes (exit 0) only on new remarks.
    fs.writeFileSync(
      gateScript,
      [
        'import fs from "node:fs";',
        'const [stateFile, worldFile, targetUrl] = process.argv.slice(2);',
        'const rawStdin = fs.readFileSync(0, "utf8");',
        'const payload = rawStdin ? JSON.parse(rawStdin) : {};',
        'const world = JSON.parse(fs.readFileSync(worldFile, "utf8"));',
        'const now = world.now;',
        'const prev = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")) : null;',
        'const trigger = payload?.trigger;',
        'const triggered = trigger?.kind === "watch" && trigger?.source === "pr-status" && String(trigger?.detail).toLowerCase() === targetUrl.toLowerCase();',
        'const WAITING_PACE_MS = 30 * 60_000;',
        'const PACE_SLACK_MS = 60_000;',
        'if (!triggered && prev?.phase === "waiting(human)" && now - prev.lastLookAt + PACE_SLACK_MS < WAITING_PACE_MS) {',
        '  world.notDueSkips += 1;',
        '  fs.writeFileSync(worldFile, JSON.stringify(world));',
        '  process.stdout.write("[pr-heartbeat-gate] SKIP reason=not-due (pace=waiting)\\nCINDY_PRECHECK_OK\\n");',
        '  process.exit(2);',
        '}',
        'if (!triggered) world.probes += 1; else world.triggeredReads += 1;',
        'fs.writeFileSync(worldFile, JSON.stringify(world));',
        'const changed = !prev || prev.remarks !== world.remarks;',
        'fs.writeFileSync(stateFile, JSON.stringify({ phase: "waiting(human)", remarks: world.remarks, lastLookAt: now }));',
        'if (changed) {',
        '  process.stdout.write("[pr-heartbeat-gate] PASS reason=changed (events=[remarks])\\nCINDY_PRECHECK_OK\\n");',
        '  process.exit(0);',
        '}',
        'process.stdout.write("[pr-heartbeat-gate] SKIP reason=waiting-human\\nCINDY_PRECHECK_OK\\n");',
        'process.exit(2);',
      ].join('\n'),
      'utf8',
    );

    let currentNow = Date.UTC(2026, 10, 25, 0, 0, 0);
    const clock = {
      now: () => currentNow,
      advance: (ms: number) => {
        currentNow += ms;
      },
    };
    const schedulesMap = new Map<string, EngineSchedule>();
    const runsMap = new Map<string, ScheduleRun>();
    const storage: ScheduleStorage = {
      async list(filter?: ListFilter) {
        const all = [...schedulesMap.values()];
        return filter?.status ? all.filter((s) => s.status === filter.status) : all;
      },
      async listActive() {
        return [...schedulesMap.values()].filter((s) => s.status === 'active');
      },
      async get(id: string) {
        const s = schedulesMap.get(id);
        return s ? { ...s } : null;
      },
      async insert(sch: EngineSchedule) {
        schedulesMap.set(sch.id, { ...sch });
        return { ...sch };
      },
      async update(id: string, patch: Partial<EngineSchedule>, expected?: EngineSchedule) {
        const ex = schedulesMap.get(id);
        if (!ex) return null;
        if (
          expected &&
          (['lastFiredAt', 'nextFireAt', 'status', 'recurring', 'manual', 'cronExpr', 'timezone', 'intervalMs', 'expireAt'] as const)
            .some((key) => ex[key] !== expected[key])
        ) {
          return null;
        }
        const merged: EngineSchedule = { ...ex, ...patch };
        if (patch.lastFinishedAt !== undefined) {
          merged.lastFinishedAt = Math.max(ex.lastFinishedAt ?? patch.lastFinishedAt, patch.lastFinishedAt);
        }
        schedulesMap.set(id, merged);
        return { ...merged };
      },
      async delete(id: string) {
        schedulesMap.delete(id);
      },
      async insertRun(run: ScheduleRun) {
        runsMap.set(run.id, { ...run });
        return { ...run };
      },
      async updateRun(id: string, patch: Partial<ScheduleRun>) {
        const ex = runsMap.get(id);
        if (!ex) return null;
        const merged: ScheduleRun = { ...ex, ...patch };
        runsMap.set(id, merged);
        return { ...merged };
      },
      async listRuns(scheduleId: string, limit = 50) {
        return [...runsMap.values()]
          .filter((r) => r.scheduleId === scheduleId)
          .sort((a, b) => b.firedAt - a.firedAt)
          .slice(0, limit);
      },
      async hasRunningRuns(scheduleId?: string) {
        return [...runsMap.values()].some(
          (r) => r.status === 'running' && (scheduleId === undefined || r.scheduleId === scheduleId),
        );
      },
      async hasUnfinishedRuns(scheduleId: string) {
        return [...runsMap.values()].some(
          (r) => r.scheduleId === scheduleId && (r.status === 'running' || r.status === 'interrupted'),
        );
      },
      async deleteRun(id: string) {
        const ex = runsMap.get(id);
        if (!ex) return null;
        runsMap.delete(id);
        return { ...ex };
      },
      async markRunningAsInterrupted() {
        return [];
      },
      async touchRunHeartbeats() {},
      async claimDueFire(id: string, expectedNextFireAt: number) {
        const ex = schedulesMap.get(id);
        if (!ex || ex.status !== 'active' || ex.nextFireAt !== expectedNextFireAt) return null;
        ex.nextFireAt = undefined;
        return { ...ex };
      },
    };
    const readWorld = () =>
      JSON.parse(fs.readFileSync(worldFile, 'utf8')) as {
        now: number;
        remarks: string;
        notDueSkips: number;
        probes: number;
        triggeredReads: number;
      };
    const writeWorld = (patch: Partial<ReturnType<typeof readWorld>>) => {
      const current = fs.existsSync(worldFile)
        ? readWorld()
        : { now: clock.now(), remarks: 'initial', notDueSkips: 0, probes: 0, triggeredReads: 0 };
      fs.writeFileSync(worldFile, JSON.stringify({ ...current, ...patch, now: clock.now() }));
    };
    writeWorld({ remarks: 'initial' });

    let agentWakeups = 0;
    const scheduler = new Scheduler({
      storage,
      clock,
      tickIntervalMs: 3_600_000,
      runner: {
        fire: async (sch, ctx) => {
          writeWorld({});
          const hook = await executePreRunHook({
            command: sch.preRunHook!.command,
            cwd: tmpDir,
            signal: ctx.signal,
            stdinPayload: {
              event: 'schedule-pre-run',
              scheduleId: sch.id,
              scheduleName: sch.name,
              runId: ctx.runId,
              firedAt: clock.now(),
              workingDir: tmpDir,
              ...(ctx.trigger ? { trigger: ctx.trigger } : {}),
            },
          });
          await ctx.onPreRunHookCompleted?.(hook);
          if (hook.status === 'skipped') {
            return { sessionId: '', skipped: true, resultText: hook.stdout.trim() };
          }
          if (hook.status !== 'passed') {
            throw new Error(hook.error ?? 'gate blocked');
          }
          agentWakeups += 1;
          return { sessionId: 'sess-pr-85', resultText: `woke-${agentWakeups}` };
        },
      },
    });

    await scheduler.start();
    try {
      const follow = await scheduler.create({
        name: 'Follow PR #85',
        kind: 'cron',
        cronExpr: '*/5 * * * *',
        timezone: 'UTC',
        intervalMs: 5 * 60_000,
        recurring: true,
        agentKind: 'codex',
        prompt: 'Handle PR #85',
        workingDir: tmpDir,
        useWorktree: false,
        notify: { desktop: false, feishu: false },
        preRunHook: {
          command: `${JSON.stringify(process.execPath)} ${JSON.stringify(gateScript)} ${JSON.stringify(stateFile)} ${JSON.stringify(worldFile)} ${url}`,
        },
      });

      let updatedAt: string | undefined = '2026-11-25T00:00:00Z';
      let pendingWatchRun: Promise<unknown> | null = null;
      const flushWatchRun = async () => {
        const current = pendingWatchRun;
        pendingWatchRun = null;
        await current;
      };
      const watch = new PrFollowWatch({
        now: () => clock.now(),
        listActive: () => scheduler.list({ status: 'active' }),
        inflight: (id) => scheduler.getInflightCount(id),
        hasCapacity: () => scheduler.hasFreeSlot(),
        autoRunAllowed: () => true,
        runNow: (id, trigger) => {
          const p = scheduler.runNow(id, { deferToCaller: true, trigger });
          pendingWatchRun = p;
          return p;
        },
      });
      const svc = new PrStatusService({
        readToken: TOKEN_OK,
        now: () => clock.now(),
        fetchPr: async () =>
          remote({
            head_sha: 'a1',
            metadata: updatedAt ? { updated_at: updatedAt } : {},
          }),
        onObserved: (query, result) => watch.observe(query, result),
      });

      // Initial reconnect baseline (mirrors ScheduleWebhookRemote.recoverGithubPrs on welcome):
      // establishes waiting(human) state (agentWakeups = 1) and anchors updated_at.
      await refreshGithubPrEvents(svc, watch, [url], () => true, { reason: 'reconnect', notify: [url] });
      await flushWatchRun();
      expect(agentWakeups).toBe(1);
      expect(readWorld()).toMatchObject({ notDueSkips: 0, probes: 0, triggeredReads: 1 });

      // (1) Long-term no events in waiting(human): across +10m and +20m timed ticks AND repeated
      // unrelated overflow batches, 0 probes/snapshots and 0 agent wakeups occur!
      for (const stepMinutes of [10, 10]) {
        clock.advance(2 * 60_000);
        await refreshGithubPrEvents(svc, watch, [url], () => true, { reason: 'overflow', notify: [url] });
        await flushWatchRun();
        clock.advance((stepMinutes - 2) * 60_000);
        await scheduler.tick();
      }
      expect(agentWakeups).toBe(1);
      expect(readWorld()).toMatchObject({ notDueSkips: 2, probes: 0, triggeredReads: 1 });

      // (2) Explicit new comment mid-backoff (+22m): bypasses waiting(human) immediately via stdin trigger,
      // wakes agent once, and merges/resets the 5m timer so +25m does not duplicate-fire!
      clock.advance(2 * 60_000);
      writeWorld({ remarks: 'human-comment-1' });
      await refreshGithubPrEvents(svc, watch, [url], () => true, { reason: 'event', notify: [url] });
      await flushWatchRun();
      expect(agentWakeups).toBe(2);
      expect(readWorld().triggeredReads).toBe(2);
      clock.advance(3 * 60_000);
      await scheduler.tick(); // original +25m slot skipped because explicit watch reset intervalMs to +27m
      expect(agentWakeups).toBe(2);

      // (3) Missing updated_at fallback: an unseen PR with no updated_at reconciles immediately once,
      // while a recently reconciled PR stays throttled until the 30m fallback window elapses, then reconciles once and throttles again.
      expect(watch.needsCommentReconcile({ ...Q, prNumber: 999 }, undefined)).toBe(true);
      updatedAt = undefined;
      const triggeredBeforeMissing = readWorld().triggeredReads;
      clock.advance(60_000); // +4m since step (2) reconcile -> still within 30m fallback window
      await refreshGithubPrEvents(svc, watch, [url], () => true, { reason: 'overflow', notify: [url] });
      await flushWatchRun();
      expect(readWorld().triggeredReads).toBe(triggeredBeforeMissing);
      clock.advance(27 * 60_000); // +31m since step (2) -> bounded 30m fallback reconciles once
      await refreshGithubPrEvents(svc, watch, [url], () => true, { reason: 'overflow', notify: [url] });
      await flushWatchRun();
      expect(readWorld().triggeredReads).toBe(triggeredBeforeMissing + 1);
      clock.advance(5 * 60_000); // +5m after fallback reconcile -> throttled again
      await refreshGithubPrEvents(svc, watch, [url], () => true, { reason: 'overflow', notify: [url] });
      await flushWatchRun();
      expect(readWorld().triggeredReads).toBe(triggeredBeforeMissing + 1);

      // (4a) Overflow dropped comment when updated_at advances -> immediate reconcile wakes agent!
      updatedAt = '2026-11-25T01:10:00Z';
      writeWorld({ remarks: 'dropped-comment-with-updated-at' });
      clock.advance(60_000);
      await refreshGithubPrEvents(svc, watch, [url], () => true, { reason: 'overflow', notify: [url] });
      await flushWatchRun();
      expect(agentWakeups).toBe(3);

      // (4b) Overflow dropped comment even when updated_at failed to advance -> retained timed check
      // stays backed off at +15m, then runs probe once waiting(human) 30m window matures and wakes agent!
      writeWorld({ remarks: 'dropped-comment-stale-updated-at' });
      clock.advance(60_000);
      await refreshGithubPrEvents(svc, watch, [url], () => true, { reason: 'overflow', notify: [url] });
      await flushWatchRun();
      expect(agentWakeups).toBe(3); // unchanged updated_at did not trigger immediate reconcile
      clock.advance(14 * 60_000);
      await scheduler.tick();
      expect(agentWakeups).toBe(3); // still within 30m waiting(human) backoff
      clock.advance(15 * 60_000);
      await scheduler.tick();
      expect(agentWakeups).toBe(4);
      expect(readWorld().probes).toBe(1);
      expect((await scheduler.listRuns(follow.id)).some((r) => r.triggerSource === 'pr-check' && r.status === 'success')).toBe(true);
    } finally {
      await scheduler.stop();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // 测试价值：
  // - 防退化点：主干推进触发 GitHub 重算可合并性时，mergeState 在 CLEAN↔UNKNOWN、conflicts 在 false↔null
  //   间抖动（或 GraphQL 摘要临时降级），曾导致每个打开 PR 触发两次 pr-status 误唤醒。
  // - 触发条件：同一 headSha 下连续观测 CLEAN/false → UNKNOWN/null → GraphQL 降级 → CLEAN/false，
  //   以及 UNKNOWN/null 基线分别收敛为 CLEAN/false 与 DIRTY/true。
  // - 生产入口与可观察结果：真实 PrStatusService + PrFollowWatch.observe 链路，断言瞬态抖动与无害基线收敛
  //   产生 0 次 runNow 唤醒，真实冲突 DIRTY/true（无论从 CLEAN 还是从 UNKNOWN 基线进入）立即唤醒。
  // - 依赖策略：仅替换 fetchPr 与内存 runNow 回调，无真实网络或真实时钟等待。
  // - 对应规则或根因：docs/dev-rules/server-channel-review.md（状态签名稳定，避免伪变更唤醒风暴）。
  it('ignores transient GitHub UNKNOWN mergeState and null conflicts recomputation while waking on real conflicts', async () => {
    const runNow = vi.fn(async (_id: string) => ({ runId: 'run-1' }));
    const pr1 = { ...Q, prNumber: 201 };
    const pr2 = { ...Q, prNumber: 202 };
    const pr3 = { ...Q, prNumber: 203 };
    const urlFor = (n: number) => `https://github.com/${Q.owner}/${Q.repo}/pull/${n}`;
    const schedules: EngineSchedule[] = [201, 202, 203].map((n) => ({
      id: `follow-${n}`,
      name: `Follow #${n}`,
      status: 'active',
      recurring: true,
      createdAt: 0,
      prTrigger: { url: urlFor(n), change: 'any' },
    }) as EngineSchedule);
    const watch = new PrFollowWatch({
      now: () => 1_000_000,
      listActive: async () => schedules,
      inflight: () => 0,
      hasCapacity: () => true,
      autoRunAllowed: () => true,
      runNow,
    });
    const responses = new Map<number, ReturnType<typeof remote>>();
    const svc = new PrStatusService({
      readToken: TOKEN_OK,
      fetchPr: async (_token, q) => responses.get(q.prNumber)!,
      onObserved: (query, result) => watch.observe(query, result),
    });
    const refresh = async (q: typeof Q) => {
      const [result] = await svc.getStatuses([q], { waitForFresh: true, refresh: true });
      expect(result?.ok).toBe(true);
    };

    const checks = { total: 2, passed: 2, failed: 0, pending: 0, skipped: 0 };
    // PR #201: CLEAN/false -> UNKNOWN/null -> GraphQL degraded null -> CLEAN/false -> 0 wakeups.
    responses.set(201, remote({ head_sha: 'h1', merge_state: 'CLEAN', checks, unresolved_count: 0, review_decision: 'APPROVED', metadata: { mergeable: true } }));
    await refresh(pr1);
    responses.set(201, remote({ head_sha: 'h1', merge_state: 'UNKNOWN', checks, unresolved_count: 0, review_decision: 'APPROVED', metadata: { mergeable: null } }));
    await refresh(pr1);
    responses.set(201, remote({ head_sha: 'h1', merge_state: null, checks: null, unresolved_count: null, review_decision: null, metadata: { mergeable: null } }));
    await refresh(pr1);
    responses.set(201, remote({ head_sha: 'h1', merge_state: 'CLEAN', checks, unresolved_count: 0, review_decision: 'APPROVED', metadata: { mergeable: true } }));
    await refresh(pr1);
    await Promise.resolve();
    expect(runNow).not.toHaveBeenCalled();

    // PR #202: baseline observed during recomputation (UNKNOWN/null) -> resolves benign CLEAN/false -> 0 wakeups.
    responses.set(202, remote({ head_sha: 'h2', merge_state: 'UNKNOWN', checks, unresolved_count: 0, metadata: { mergeable: null } }));
    await refresh(pr2);
    responses.set(202, remote({ head_sha: 'h2', merge_state: 'CLEAN', checks, unresolved_count: 0, metadata: { mergeable: true } }));
    await refresh(pr2);
    await Promise.resolve();
    expect(runNow).not.toHaveBeenCalled();

    // PR #201 then hits a real conflict (DIRTY / mergeable: false) -> wakes immediately.
    responses.set(201, remote({ head_sha: 'h1', merge_state: 'DIRTY', checks, unresolved_count: 0, review_decision: 'APPROVED', metadata: { mergeable: false } }));
    await refresh(pr1);
    await vi.waitFor(() => expect(runNow).toHaveBeenCalledTimes(1));
    expect(runNow.mock.calls[0]?.[0]).toBe('follow-201');

    // PR #203: baseline observed during recomputation (UNKNOWN/null) -> resolves to real conflict (DIRTY/true) -> wakes immediately!
    responses.set(203, remote({ head_sha: 'h3', merge_state: 'UNKNOWN', checks, unresolved_count: 0, metadata: { mergeable: null } }));
    await refresh(pr3);
    responses.set(203, remote({ head_sha: 'h3', merge_state: 'DIRTY', checks, unresolved_count: 0, metadata: { mergeable: false } }));
    await refresh(pr3);
    await vi.waitFor(() => expect(runNow).toHaveBeenCalledTimes(2));
    expect(runNow.mock.calls[1]?.[0]).toBe('follow-203');
  });

  // Unit regression: GitHub App push refreshes PrStatusService in main, but without a
  // main→renderer broadcast gate the UI waited up to 90s for its next polling tick (or
  // would spam identical revisions / heavy metadata). Tests production PrStatusService +
  // refreshGithubPrEvents + createPrStatusBroadcastGate with minimal changed/unchanged states.
  it('broadcasts stripped status changes on event refresh, suppresses unchanged revisions, and resets on invalidate', async () => {
    let now = 1_000;
    let current: PrRemoteState | 'error' | 'not-found' = remote({
      checks: { total: 2, passed: 1, failed: 0, pending: 1, skipped: 0 },
      metadata: { body: 'LARGE PR BODY', author: { login: 'octocat' } },
    });
    const pushed: unknown[] = [];
    const gate = createPrStatusBroadcastGate((status) => pushed.push(status));
    const svc = new PrStatusService({
      readToken: TOKEN_OK,
      now: () => now,
      fetchPr: async () => {
        if (current === 'error') throw new Error('ECONNRESET');
        if (current === 'not-found') throw Object.assign(new Error('nf'), { status: 404 });
        return current;
      },
      onInvalidated: () => gate.reset(),
      onObserved: (query, result) => gate.observe(query, result),
    });
    const url = 'https://github.com/makecindy/cindy/pull/85';

    // Initial fetch broadcasts once with metadata stripped.
    await svc.getStatuses([Q]);
    expect(pushed).toHaveLength(1);
    expect(pushed[0]).toMatchObject({ ok: true, status: 'open', checks: { passed: 1, pending: 1 } });
    expect(pushed[0]).not.toHaveProperty('metadata');

    // Identical content on a forced refresh (new observedAt/revision) must not re-broadcast.
    now += 10_000;
    await refreshGithubPrEvents(svc, { notify: vi.fn(), observedSignature: () => undefined }, [url], () => true, { reason: 'event', notify: [] });
    expect(pushed).toHaveLength(1);

    // Real check/status transition via GitHub App push broadcasts immediately without metadata.
    now += 5_000;
    current = remote({
      state: 'closed',
      merged: true,
      checks: { total: 2, passed: 2, failed: 0, pending: 0, skipped: 0 },
      metadata: { body: 'LARGE PR BODY' },
    });
    await refreshGithubPrEvents(svc, { notify: vi.fn(), observedSignature: () => undefined }, [url], () => true, { reason: 'event', notify: [] });
    expect(pushed).toHaveLength(2);
    expect(pushed[1]).toMatchObject({ ok: true, status: 'merged', checks: { passed: 2, pending: 0 } });
    expect(pushed[1]).not.toHaveProperty('metadata');

    // Transient fetch failure must not broadcast; definitive not-found must broadcast once.
    current = 'error';
    await svc.getStatuses([Q], { refresh: true });
    expect(pushed).toHaveLength(2);
    current = 'not-found';
    await svc.getStatuses([Q], { refresh: true });
    expect(pushed).toHaveLength(3);
    expect(pushed[2]).toMatchObject({ ok: false, reason: 'not-found' });

    // Invalidation (account/token switch) resets the gate so the next identical state broadcasts again.
    svc.invalidate();
    await svc.getStatuses([Q], { refresh: true });
    expect(pushed).toHaveLength(4);
  });
});
