import { describe, expect, it } from 'vitest';
import {
  conversationSearchResultKey,
  emptyConversationSearchResponse,
  filterResultsByRequestFilters,
  filterResultsByWorkingDirs,
  mergeConversationSearchFanout,
  remoteIndexedSearchIgnoredWorkingDirs,
  remoteResultsFromFanoutPages,
  stampRemoteSearchResponse,
  type ConversationSearchResponse,
  type ConversationSearchResultItem,
} from '../conversationSearch.js';

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

describe('merge and stamp', () => {
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
    expect(page.results.map((item) => item.session.id)).toEqual(['keep']);
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
});
