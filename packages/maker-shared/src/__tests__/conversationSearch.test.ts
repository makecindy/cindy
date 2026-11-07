import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  conversationSearchResultKey,
  emptyConversationSearchResponse,
  filterResultsByRequestFilters,
  filterResultsByWorkingDirs,
  mergeConversationSearchFanout,
  remoteConversationSearchRequest,
  remoteIndexedSearchIgnoredWorkingDirs,
  remoteResultsFromFanoutPages,
  stampRemoteSearchResponse,
  type ConversationSearchRequest,
  type ConversationSearchResponse,
  type ConversationSearchResultItem,
} from '../conversationSearch.js';

const feature = vi.hoisted(() => ({ enabled: false }));
vi.mock('../cindyMakeFeature.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../cindyMakeFeature.js')>(),
  get CINDY_MAKE_ENABLED() { return feature.enabled; },
}));

function result(
  id: string,
  rankScore: number,
  extras: Partial<ConversationSearchResultItem['session']> = {},
): ConversationSearchResultItem {
  return {
    session: {
      id,
      title: id,
      workingDir: '/repo',
      workspaceKind: 'project',
      agentKind: 'cc',
      status: 'active',
      userSendAt: '2026-08-19T00:00:00.000Z',
      updatedAt: '2026-08-19T00:00:00.000Z',
      createdAt: '2026-08-19T00:00:00.000Z',
      _count: { messages: 1 },
      ...extras,
    },
    matchKind: 'title',
    titleMatchIndices: [0],
    titleScore: 1,
    contentHit: null,
    contentHits: [],
    rankScore,
  };
}

function response(results: ConversationSearchResultItem[]): ConversationSearchResponse {
  return {
    query: 'needle',
    results,
    vectorUsed: false,
    vectorSkipReason: null,
    poolCapped: false,
  };
}

describe('remoteConversationSearchRequest', () => {
  it('filters by explicit project membership while preserving the execution directory', () => {
    const page = response([result('checkout', 1, { projectDir: '/project', workingDir: '/tmp/checkout' }), result('legacy', 2)]);
    expect(filterResultsByWorkingDirs(page, ['/project']).results.map(item => item.session.id)).toEqual(['checkout']);
    expect(filterResultsByWorkingDirs(page, ['/repo']).results.map(item => item.session.id)).toEqual(['legacy']);
    expect(remoteIndexedSearchIgnoredWorkingDirs(response([page.results[0]!]), ['/project'])).toBe(false);
    expect(page.results[0]?.session.workingDir).toBe('/tmp/checkout');
  });
  afterEach(() => { feature.enabled = false; });

  it.each([undefined, 1, 3, 24, 50, 100])('uses the bounded remote candidate pool for limit %s', (limit) => {
    const request = { query: 'needle', limit };
    expect(remoteConversationSearchRequest(request)).toEqual({ query: 'needle', limit: 50 });
    expect(request.limit).toBe(limit);
  });

  it('preserves origin filters and search options without mutating the caller', () => {
    const request = Object.freeze<ConversationSearchRequest>({
      query: 'needle',
      limit: 3,
      sortBy: 'activityDesc',
      semanticMode: 'keyword',
      includeArchived: true,
      unnamedLabel: 'Untitled',
      filters: { sessionIds: ['ordinary'], workingDirs: ['/repo'], agentKind: 'pi', status: 'archived', lastActivity: '7d' },
    });
    const remoteRequest = remoteConversationSearchRequest(request);
    expect(remoteRequest).toEqual({ ...request, limit: 50 });
    expect(remoteRequest.filters).toBe(request.filters);
    expect(request.limit).toBe(3);
  });

  it('returns ordinary hits after an older host truncates the expanded request', () => {
    const request = { query: 'needle', limit: 1 };
    const candidates = [
      result('make', 100, { source: 'cindy-make', deviceLinkDeviceId: 'dev-a' }),
      result('merge', 99, { source: 'cindy-make-merge', deviceLinkDeviceId: 'dev-a' }),
      result('ordinary', 2, { source: 'desktop', deviceLinkDeviceId: 'dev-a' }),
      result('ordinary-next', 1, { source: 'desktop', deviceLinkDeviceId: 'dev-a' }),
    ];
    const remoteRequest = remoteConversationSearchRequest(request);
    const page = response(candidates.slice(0, remoteRequest.limit));
    expect(mergeConversationSearchFanout([page], request.limit).results.map((item) => item.session.id)).toEqual(['ordinary']);
    expect(remoteResultsFromFanoutPages([page]).map((item) => item.session.id)).toEqual(['ordinary', 'ordinary-next']);
  });

  it('leaves the original request unchanged when Cindy Make is enabled', () => {
    feature.enabled = true;
    const request = { query: 'needle', limit: 3 };
    expect(remoteConversationSearchRequest(request)).toBe(request);
  });
});

describe('merge and stamp', () => {
  it('excludes hidden Make sources before limiting indexed or reused remote hits', () => {
    const page = response([
      result('make', 100, { source: 'cindy-make', deviceLinkDeviceId: 'dev-a' }),
      result('merge', 99, { source: 'cindy-make-merge', deviceLinkDeviceId: 'dev-a' }),
      result('ordinary', 1, { source: 'desktop', deviceLinkDeviceId: 'dev-a' }),
    ]);
    expect(mergeConversationSearchFanout([page], 1).results.map(item => item.session.id)).toEqual(['ordinary']);
    expect(remoteResultsFromFanoutPages([page]).map(item => item.session.id)).toEqual(['ordinary']);
    expect(filterResultsByRequestFilters(page, {}).results.map(item => item.session.id)).toEqual(['ordinary']);
  });
  it('keeps same-id hits from different devices and stamps origin', () => {
    const remote = stampRemoteSearchResponse(response([result('same', 10)]), {
      deviceId: 'dev-a',
      deviceName: 'Studio',
    });
    const merged = mergeConversationSearchFanout([response([result('same', 3)]), remote], 24);
    expect(merged.results.map((item) => conversationSearchResultKey(item)).sort()).toEqual([
      'dev-a:same',
      'local:same',
    ]);
    expect(
      merged.results.find((item) => item.session.deviceLinkDeviceId === 'dev-a')?.session
        .deviceLinkDeviceName,
    ).toBe('Studio');
  });

  it('returns an empty page shape', () => {
    expect(emptyConversationSearchResponse('q')).toEqual({
      query: 'q',
      results: [],
      vectorUsed: false,
      vectorSkipReason: null,
      poolCapped: false,
    });
  });

  it('keeps remote hits after the merged page is truncated', () => {
    const locals = Array.from({ length: 24 }, (_, index) => result(`local-${index}`, 100 - index));
    const pages = [
      response(locals),
      response([result('remote-squeezed', 1, { deviceLinkDeviceId: 'dev-a' })]),
    ];
    const merged = mergeConversationSearchFanout(pages, 24);
    expect(merged.results.map((item) => item.session.id)).not.toContain('remote-squeezed');
    expect(remoteResultsFromFanoutPages(pages).map((item) => item.session.id)).toEqual([
      'remote-squeezed',
    ]);
  });
});

describe('filterResultsByWorkingDirs', () => {
  it('drops remote hits that belong to another project', () => {
    const page = filterResultsByWorkingDirs(
      response([
        result('keep', 1, { workingDir: '/repo-remote' }),
        result('drop', 1, { workingDir: '/other' }),
      ]),
      ['/repo-remote'],
    );
    expect(page.results.map((item) => item.session.id)).toEqual(['keep']);
  });

  // 回归价值：两个公开过滤入口必须保留同目录、排除异目录；现有 POSIX 用例未覆盖
  // Windows 大小写变体被误排除的 bug。最小失败输入为仅盘符/UNC 大小写不同的目录（unit）。
  it.each([
    {
      name: 'drive',
      selected: 'c:\\Work\\Repo',
      matching: 'C:/work/repo',
      different: 'C:/Work/Other',
    },
    {
      name: 'UNC',
      selected: '\\\\Server\\Share\\Repo',
      matching: '//server/share/repo',
      different: '//server/share/other',
    },
    // #7644 (unit): remote search must keep worktrees when filtering by their base
    // project; the earlier case-variant fixtures never varied a container name.
    {
      name: 'worktree drive',
      selected: 'c:/Work/Repo',
      matching: 'C:/work/repo/.CINDY-WORKTREES/topic',
      different: 'C:/work/other/.CINDY-WORKTREES/topic',
    },
    {
      name: 'worktree UNC',
      selected: '//Server/Share/Repo',
      matching: '//server/share/repo/.CLAUDE/Worktrees/topic',
      different: '//server/share/other/.CLAUDE/Worktrees/topic',
    },
  ])('keeps Windows $name case variants but drops genuinely different directories', ({ selected, matching, different }) => {
    const page = filterResultsByWorkingDirs(
      response([
        result('keep', 1, { workingDir: matching }),
        result('drop', 1, { workingDir: different }),
      ]),
      [selected],
    );
    expect(page.results.map((item) => item.session.id)).toEqual(['keep']);
  });

  it('keeps POSIX directory matching case-sensitive', () => {
    const page = filterResultsByWorkingDirs(
      response([
        result('keep', 1, { workingDir: '/Work/Repo' }),
        result('drop', 1, { workingDir: '/work/repo' }),
      ]),
      ['/Work/Repo'],
    );
    expect(page.results.map((item) => item.session.id)).toEqual(['keep']);
  });
});

describe('filterResultsByRequestFilters', () => {
  it('drops remote hits that ignore status, agent, or activity filters', () => {
    const recent = new Date().toISOString();
    const page = filterResultsByRequestFilters(
      response([
        result('keep', 1, {
          agentKind: 'codex',
          status: 'archived',
          userSendAt: recent,
        }),
        result('wrong-agent', 1, {
          agentKind: 'cc',
          status: 'archived',
          userSendAt: recent,
        }),
        result('wrong-status', 1, {
          agentKind: 'codex',
          status: 'active',
          userSendAt: recent,
        }),
        result('too-old', 1, {
          agentKind: 'codex',
          status: 'archived',
          userSendAt: '2020-01-01T00:00:00.000Z',
          updatedAt: '2020-01-01T00:00:00.000Z',
        }),
        result('worker', 1, {
          agentKind: 'codex',
          status: 'archived',
          userSendAt: recent,
          orcaRole: 'worker',
        }),
      ]),
      {
        filters: {
          status: 'archived',
          agentKind: 'codex',
          lastActivity: '7d',
        },
      },
    );
    expect(page.results.map((item) => item.session.id)).toEqual(['keep', 'worker']);
  });

  it('keeps a remote hit when updatedAt is recent but userSendAt is old', () => {
    const page = filterResultsByRequestFilters(
      response([
        result('keep', 1, {
          userSendAt: '2020-01-01T00:00:00.000Z',
          updatedAt: new Date().toISOString(),
        }),
      ]),
      { filters: { lastActivity: '7d' } },
    );
    expect(page.results.map((item) => item.session.id)).toEqual(['keep']);
  });
});

describe('remoteIndexedSearchIgnoredWorkingDirs', () => {
  it('detects an old host that searched globally and filled the page from other projects', () => {
    expect(
      remoteIndexedSearchIgnoredWorkingDirs(
        response([
          result('other', 1, { workingDir: '/other' }),
          result('keep', 1, { workingDir: '/repo-remote' }),
        ]),
        ['/repo-remote'],
      ),
    ).toBe(true);
  });

  it('does not treat an in-project page as unsupported', () => {
    expect(
      remoteIndexedSearchIgnoredWorkingDirs(
        response([result('keep', 1, { workingDir: '/repo-remote' })]),
        ['/repo-remote'],
      ),
    ).toBe(false);
  });

  it.each([
    {
      name: 'drive',
      selected: 'c:\\Work\\Repo',
      matching: 'C:/work/repo',
      different: 'C:/Work/Other',
    },
    {
      name: 'UNC',
      selected: '\\\\Server\\Share\\Repo',
      matching: '//server/share/repo',
      different: '//server/share/other',
    },
  ])('uses Windows $name case-insensitive matching when detecting ignored filters', ({ selected, matching, different }) => {
    expect(
      remoteIndexedSearchIgnoredWorkingDirs(
        response([result('keep', 1, { workingDir: matching })]),
        [selected],
      ),
    ).toBe(false);
    expect(
      remoteIndexedSearchIgnoredWorkingDirs(
        response([result('drop', 1, { workingDir: different })]),
        [selected],
      ),
    ).toBe(true);
  });

  it('uses POSIX case-sensitive matching when detecting ignored filters', () => {
    expect(
      remoteIndexedSearchIgnoredWorkingDirs(
        response([result('keep', 1, { workingDir: '/Work/Repo' })]),
        ['/Work/Repo'],
      ),
    ).toBe(false);
    expect(
      remoteIndexedSearchIgnoredWorkingDirs(
        response([result('drop', 1, { workingDir: '/work/repo' })]),
        ['/Work/Repo'],
      ),
    ).toBe(true);
  });
});
