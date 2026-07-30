/**
 * myIssuesService 单测 —— 三路输入合并、来源标记、平台通道降级、可选增强的独立性、缓存。
 *
 * 最重要的一条口径:**没有 GitHub 身份是正常状态**,列表必须照常出来,
 * degraded 只由平台通道决定。依赖全注入,不碰网络 / electron。
 */

import { describe, expect, it, vi } from 'vitest';

import type { SubmittedIssueRecord } from '../../../shared/myIssues';
import {
  MyIssuesService,
  issueTypeFromLabels,
  mergeIssues,
  type GithubEnhancementViewer,
  type MyIssuesServiceDeps,
  type RemoteIssue,
} from '../myIssuesService';

const GHOST_VIEWER: GithubEnhancementViewer = { source: 'ghost', login: 'octocat' };

function ledgerRecord(over: Partial<SubmittedIssueRecord> = {}): SubmittedIssueRecord {
  return {
    number: 1001,
    url: 'https://github.com/makecindy/cindy/issues/1001',
    title: '账本里记的标题',
    type: 'bug',
    submittedAt: '2026-07-01T00:00:00.000Z',
    identity: 'platform',
    publicName: 'shuji',
    ...over,
  };
}

function remoteIssue(over: Partial<RemoteIssue> = {}): RemoteIssue {
  return {
    number: 2002,
    title: 'GitHub 上的标题',
    htmlUrl: 'https://github.com/makecindy/cindy/issues/2002',
    state: 'open',
    labels: ['feature'],
    createdAt: '2026-07-10T00:00:00.000Z',
    updatedAt: '2026-07-12T00:00:00.000Z',
    commentCount: 3,
    ...over,
  };
}

function makeDeps(over: Partial<MyIssuesServiceDeps> = {}): MyIssuesServiceDeps {
  return {
    readLedger: () => [],
    fetchPlatformIssues: async () => ({
      ok: true,
      page: { issues: [], totalCount: 0 },
    }),
    resolveGithubEnhancement: async () => null,
    searchAuthoredIssues: async () => ({ issues: [], totalCount: 0 }),
    ...over,
  };
}

describe('mergeIssues', () => {
  it('账本 only 的条目状态标 unknown,标题用账本记的那一版', () => {
    const [item] = mergeIssues([ledgerRecord()], []);
    expect(item).toMatchObject({
      number: 1001,
      title: '账本里记的标题',
      state: 'unknown',
      updatedAt: null,
      commentCount: null,
      sources: ['cindy-tool'],
    });
  });

  it('平台通道返回的条目只打 cindy-tool —— 平台代发的 GitHub 作者不是本人', () => {
    const [item] = mergeIssues(
      [],
      [],
      [remoteIssue({ number: 9, state: 'closed', title: '远端标题' })],
    );
    expect(item).toMatchObject({ state: 'closed', title: '远端标题', sources: ['cindy-tool'] });
  });

  it('账本 + 平台同号时远端字段覆盖账本,标签被清掉时类型回退账本', () => {
    const [item] = mergeIssues(
      [ledgerRecord({ number: 5, title: '提交时的旧标题', type: 'bug' })],
      [],
      [remoteIssue({ number: 5, title: '被维护者改过的标题', state: 'closed', labels: [] })],
    );
    expect(item).toMatchObject({
      title: '被维护者改过的标题',
      state: 'closed',
      type: 'bug',
      sources: ['cindy-tool'],
    });
  });

  it('author 搜到的打 github-account;同时命中两路时两个来源都标上且顺序稳定', () => {
    const [onlyAuthored] = mergeIssues([], [remoteIssue({ number: 7 })]);
    expect(onlyAuthored.sources).toEqual(['github-account']);

    const [both] = mergeIssues(
      [ledgerRecord({ number: 7 })],
      [remoteIssue({ number: 7 })],
      [remoteIssue({ number: 7 })],
    );
    expect(both.sources).toEqual(['cindy-tool', 'github-account']);
  });

  it('按创建时间倒序;同一时间戳按 issue 号兜底,顺序稳定', () => {
    const items = mergeIssues(
      [],
      [
        remoteIssue({ number: 1, createdAt: '2026-07-01T00:00:00.000Z' }),
        remoteIssue({ number: 3, createdAt: '2026-07-20T00:00:00.000Z' }),
        remoteIssue({ number: 2, createdAt: '2026-07-20T00:00:00.000Z' }),
      ],
    );
    expect(items.map((i) => i.number)).toEqual([3, 2, 1]);
  });
});

describe('issueTypeFromLabels', () => {
  it('识别 bug / feature,大小写不敏感;都没有时为 null', () => {
    expect(issueTypeFromLabels(['Bug'])).toBe('bug');
    expect(issueTypeFromLabels(['feature'])).toBe('feature');
    expect(issueTypeFromLabels(['needs-triage'])).toBeNull();
    expect(issueTypeFromLabels([])).toBeNull();
  });
});

describe('MyIssuesService.list', () => {
  it('平台通道就绪时给出实时状态,不需要任何 GitHub 身份', async () => {
    const searchAuthoredIssues = vi.fn();
    const service = new MyIssuesService(
      makeDeps({
        readLedger: () => [ledgerRecord({ number: 1001 })],
        fetchPlatformIssues: async () => ({
          ok: true,
          page: {
            issues: [remoteIssue({ number: 1001, state: 'closed', title: '远端标题' })],
            totalCount: 1,
          },
        }),
        resolveGithubEnhancement: async () => null,
        searchAuthoredIssues,
      }),
    );
    const result = await service.list();
    expect(result).toMatchObject({
      githubEnhancement: null,
      degraded: null,
      truncated: false,
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ state: 'closed', title: '远端标题' });
    // 没有 GitHub 身份时不该去搜 GitHub。
    expect(searchAuthoredIssues).not.toHaveBeenCalled();
  });

  it('平台读接口未就绪时降级 platform-unavailable,账本记录照常渲染', async () => {
    const service = new MyIssuesService(
      makeDeps({
        readLedger: () => [ledgerRecord()],
        fetchPlatformIssues: async () => ({ ok: false, reason: 'platform-unavailable' }),
      }),
    );
    const result = await service.list();
    expect(result.degraded).toBe('platform-unavailable');
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.state).toBe('unknown');
  });

  it('未登录 / 取数失败各自映射到对应 degraded', async () => {
    for (const reason of ['not-signed-in', 'fetch-failed'] as const) {
      const service = new MyIssuesService(
        makeDeps({
          readLedger: () => [ledgerRecord()],
          fetchPlatformIssues: async () => ({ ok: false, reason }),
        }),
      );
      await expect(service.list()).resolves.toMatchObject({ degraded: reason });
    }
  });

  it('平台通道意外抛错时归到 fetch-failed,不把整页打挂', async () => {
    const service = new MyIssuesService(
      makeDeps({
        readLedger: () => [ledgerRecord()],
        fetchPlatformIssues: async () => {
          throw new Error('boom');
        },
      }),
    );
    const result = await service.list();
    expect(result.degraded).toBe('fetch-failed');
    expect(result.items).toHaveLength(1);
  });

  it('可选增强把用户自己 GitHub 名下的 issue 并进来,并回传身份', async () => {
    const service = new MyIssuesService(
      makeDeps({
        fetchPlatformIssues: async () => ({
          ok: true,
          page: { issues: [remoteIssue({ number: 1 })], totalCount: 1 },
        }),
        resolveGithubEnhancement: async () => GHOST_VIEWER,
        searchAuthoredIssues: async () => ({
          issues: [remoteIssue({ number: 2, createdAt: '2026-07-20T00:00:00.000Z' })],
          totalCount: 1,
        }),
      }),
    );
    const result = await service.list();
    expect(result.githubEnhancement).toEqual({ login: 'octocat', source: 'ghost' });
    expect(result.items.map((i) => i.number)).toEqual([2, 1]);
    expect(result.items.find((i) => i.number === 2)!.sources).toEqual(['github-account']);
  });

  it('增强身份解析或搜索失败都不算列表降级', async () => {
    const throwingResolve = new MyIssuesService(
      makeDeps({
        resolveGithubEnhancement: async () => {
          throw new Error('ghost pipe exploded');
        },
      }),
    );
    await expect(throwingResolve.list()).resolves.toMatchObject({
      degraded: null,
      githubEnhancement: null,
    });

    const throwingSearch = new MyIssuesService(
      makeDeps({
        resolveGithubEnhancement: async () => GHOST_VIEWER,
        searchAuthoredIssues: async () => {
          throw new Error('HTTP 403');
        },
      }),
    );
    const result = await throwingSearch.list();
    expect(result.degraded).toBeNull();
    // 身份查到了就如实回传,只是这一次没并进内容。
    expect(result.githubEnhancement).toEqual({ login: 'octocat', source: 'ghost' });
    expect(result.items).toEqual([]);
  });

  it('任一路远端总数多于返回条数时标 truncated', async () => {
    const platformTruncated = new MyIssuesService(
      makeDeps({
        fetchPlatformIssues: async () => ({
          ok: true,
          page: { issues: [remoteIssue()], totalCount: 240 },
        }),
      }),
    );
    await expect(platformTruncated.list()).resolves.toMatchObject({ truncated: true });

    const enhancementTruncated = new MyIssuesService(
      makeDeps({
        resolveGithubEnhancement: async () => GHOST_VIEWER,
        searchAuthoredIssues: async () => ({ issues: [remoteIssue()], totalCount: 240 }),
      }),
    );
    await expect(enhancementTruncated.list()).resolves.toMatchObject({ truncated: true });
  });

  it('TTL 内复用缓存;force 绕过 TTL;invalidate 后重新拉', async () => {
    let clock = 0;
    const fetchPlatformIssues = vi.fn(async () => ({
      ok: true as const,
      page: { issues: [remoteIssue()], totalCount: 1 },
    }));
    const service = new MyIssuesService(
      makeDeps({ fetchPlatformIssues, cacheTtlMs: 1000, now: () => clock }),
    );

    await service.list();
    await service.list();
    expect(fetchPlatformIssues).toHaveBeenCalledTimes(1);

    await service.list({ force: true });
    expect(fetchPlatformIssues).toHaveBeenCalledTimes(2);

    service.invalidate();
    await service.list();
    expect(fetchPlatformIssues).toHaveBeenCalledTimes(3);

    clock += 2000;
    await service.list();
    expect(fetchPlatformIssues).toHaveBeenCalledTimes(4);
  });

  it('并发调用只打一次远端(in-flight 去重)', async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchPlatformIssues = vi.fn(async () => {
      await gate;
      return { ok: true as const, page: { issues: [remoteIssue()], totalCount: 1 } };
    });
    const service = new MyIssuesService(makeDeps({ fetchPlatformIssues }));
    const both = Promise.all([service.list(), service.list()]);
    release!();
    const [first, second] = await both;
    expect(fetchPlatformIssues).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
  });
});
