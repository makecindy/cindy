/**
 * git-context/prStatusService 单测 — 状态映射、TTL 缓存、in-flight 去重、
 * no-token 降级(不缓存)、404/网络错误映射。依赖全注入,零网络零 Electron。
 */

import { describe, it, expect, vi } from 'vitest';

import {
  PrStatusService,
  filterPrStatusQueriesForRefs,
  mapRemoteToStatus,
  type PrRemoteState,
} from '../git-context/prStatusService';

const Q = { owner: 'makecindy', repo: 'cindy', prNumber: 85 };

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
    expect(mapRemoteToStatus(remote({ state: 'closed', merged_at: '2026-06-12T00:00:00Z' }))).toBe('merged');
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
  it('正常查询返回状态与标题', async () => {
    const svc = new PrStatusService({
      readToken: async () => 'ghp_x',
      fetchPr: async () => remote({ merged: true, state: 'closed' }),
    });
    const [r] = await svc.getStatuses([Q]);
    expect(r).toMatchObject({ ok: true, status: 'merged', prNumber: 85 });
  });

  it('PR 源分支(head.ref)透传到结果', async () => {
    const svc = new PrStatusService({
      readToken: async () => 'ghp_x',
      fetchPr: async () => remote({ branch: 'fix/voice-input-enter-send' }),
    });
    expect((await svc.getStatuses([Q]))[0]).toMatchObject({
      ok: true,
      branch: 'fix/voice-input-enter-send',
    });
  });

  it('未解决 review thread 数透传;fetch 端缺省时归一为 null', async () => {
    const withCount = new PrStatusService({
      readToken: async () => 'ghp_x',
      fetchPr: async () => remote({ unresolved_count: 3 }),
    });
    expect((await withCount.getStatuses([Q]))[0]).toMatchObject({ ok: true, unresolvedCount: 3 });

    const withoutCount = new PrStatusService({
      readToken: async () => 'ghp_x',
      fetchPr: async () => remote({}),
    });
    expect((await withoutCount.getStatuses([Q]))[0]).toMatchObject({ ok: true, unresolvedCount: null });
  });

  it('TTL 内命中缓存,过期后重新拉取', async () => {
    let now = 0;
    const fetchPr = vi.fn(async () => remote({}));
    const svc = new PrStatusService({
      readToken: async () => 'ghp_x',
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

  it('并发同一 PR 只发一次请求(in-flight 去重)', async () => {
    let resolveFetch!: (v: PrRemoteState) => void;
    const fetchPr = vi.fn(
      () => new Promise<PrRemoteState>((res) => (resolveFetch = res)),
    );
    const svc = new PrStatusService({ readToken: async () => 'ghp_x', fetchPr });
    const p1 = svc.getStatuses([Q]);
    const p2 = svc.getStatuses([Q]);
    // readToken 是 async,等微任务推进到 fetchPr 真正被调用后再放行
    await vi.waitFor(() => expect(fetchPr).toHaveBeenCalled());
    resolveFetch(remote({}));
    await Promise.all([p1, p2]);
    expect(fetchPr).toHaveBeenCalledTimes(1);
  });

  it('无 token 返回 no-token 且不缓存(配完 PAT 立即生效)', async () => {
    let token: string | null = null;
    const fetchPr = vi.fn(async () => remote({}));
    const svc = new PrStatusService({ readToken: async () => token, fetchPr });
    const [r1] = await svc.getStatuses([Q]);
    expect(r1).toMatchObject({ ok: false, reason: 'no-token' });
    token = 'ghp_x';
    const [r2] = await svc.getStatuses([Q]);
    expect(r2).toMatchObject({ ok: true, status: 'open' });
  });

  it('fetch-failed 不缓存:瞬时网络错误后下一次查询立即重试', async () => {
    let failing = true;
    const fetchPr = vi.fn(async () => {
      if (failing) throw new Error('ECONNRESET');
      return remote({});
    });
    const svc = new PrStatusService({ readToken: async () => 'ghp_x', fetchPr });
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
    const svc = new PrStatusService({ readToken: async () => 'ghp_x', fetchPr });
    await svc.getStatuses([Q]);
    await svc.getStatuses([Q]);
    expect(fetchPr).toHaveBeenCalledTimes(1);
  });

  it('404 映射 not-found,其它错误映射 fetch-failed', async () => {
    const svc404 = new PrStatusService({
      readToken: async () => 'ghp_x',
      fetchPr: async () => {
        throw Object.assign(new Error('nf'), { status: 404 });
      },
    });
    expect((await svc404.getStatuses([Q]))[0]).toMatchObject({ ok: false, reason: 'not-found' });

    const svcNet = new PrStatusService({
      readToken: async () => 'ghp_x',
      fetchPr: async () => {
        throw new Error('ECONNRESET');
      },
    });
    expect((await svcNet.getStatuses([Q]))[0]).toMatchObject({ ok: false, reason: 'fetch-failed' });
  });

  it('批量查询上限 10 条,超出忽略', async () => {
    const fetchPr = vi.fn(async () => remote({}));
    const svc = new PrStatusService({ readToken: async () => 'ghp_x', fetchPr });
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
