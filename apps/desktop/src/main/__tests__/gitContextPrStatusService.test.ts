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
import type { GithubClient } from '@cindy/github-client';

const Q = { owner: 'makecindy', repo: 'cindy', prNumber: 85 };
const TOKEN_OK = async (): Promise<GhCliTokenReadResult> => ({ ok: true, token: 'ghp_x' });

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
