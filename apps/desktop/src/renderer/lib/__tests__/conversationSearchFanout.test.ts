import { describe, expect, it, vi } from 'vitest';

import type { Session } from '@/lib/ccAgent.types';
import {
  conversationSearchResultKey,
  emptyConversationSearchResponse,
  filterResultsByRequestFilters,
  filterResultsByWorkingDirs,
  remoteIndexedSearchIgnoredWorkingDirs,
  mergeConversationSearchFanout,
  remoteResultsFromFanoutPages,
  requestForOrigin,
  resolveConversationSearchOrigins,
  searchCachedSessionsByTitle,
  searchDevicesFromSwitcher,
  shouldReleaseConversationSearchLock,
  stampRemoteSearchResponse,
} from '@/lib/conversationSearchFanout';
import { searchConversationsAcrossOrigins } from '@/lib/conversationSearchService';
import type {
  ConversationSearchRequest,
  ConversationSearchResponse,
  ConversationSearchResultItem,
} from '../../../shared/conversationSearch';
import { MACHINE_ALL, MACHINE_LOCAL } from '@/features/device-link/selectedMachineStore';

function session(partial: Partial<Session> & Pick<Session, 'id' | 'title'>): Session {
  return {
    workingDir: '/repo',
    workspaceKind: 'project',
    model: 'x',
    effort: 'medium',
    permissionMode: 'default',
    sdkSessionId: null,
    totalTokenUsage: 0,
    totalCostUsd: 0,
    contextTokens: 0,
    contextWindow: 0,
    fastMode: false,
    clearedAt: null,
    pinnedAt: null,
    userSendAt: '2026-08-19T00:00:00.000Z',
    status: 'active',
    agentKind: 'cc',
    extraDirs: [],
    createdAt: '2026-08-19T00:00:00.000Z',
    updatedAt: '2026-08-19T00:00:00.000Z',
    userId: 'u',
    ...partial,
  } as Session;
}

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

const devices = [
  { deviceId: 'dev-a', deviceName: 'Studio', connected: true },
  { deviceId: 'dev-b', deviceName: 'Laptop', connected: false },
];

describe('resolveConversationSearchOrigins', () => {
  it('searches local plus every known device when the machine filter is all', () => {
    expect(
      resolveConversationSearchOrigins({
        machineSelection: MACHINE_ALL,
        sessionIds: null,
        devices,
        getSessionDeviceId: () => undefined,
      }),
    ).toEqual([
      { kind: 'local', sessionIds: null },
      {
        kind: 'remote',
        deviceId: 'dev-a',
        deviceName: 'Studio',
        connected: true,
        sessionIds: null,
      },
      {
        kind: 'remote',
        deviceId: 'dev-b',
        deviceName: 'Laptop',
        connected: false,
        sessionIds: null,
      },
    ]);
  });

  it('keeps a single-machine filter on that device only', () => {
    expect(
      resolveConversationSearchOrigins({
        machineSelection: ['dev-a'],
        sessionIds: null,
        devices,
        getSessionDeviceId: () => undefined,
      }),
    ).toEqual([
      {
        kind: 'remote',
        deviceId: 'dev-a',
        deviceName: 'Studio',
        connected: true,
        sessionIds: null,
      },
    ]);
  });

  it('partitions an explicit project session set by origin', () => {
    expect(
      resolveConversationSearchOrigins({
        machineSelection: [MACHINE_LOCAL],
        sessionIds: ['local-1', 'remote-1', 'remote-2'],
        devices,
        getSessionDeviceId: (id) => (id.startsWith('remote') ? 'dev-a' : undefined),
      }),
    ).toEqual([
      { kind: 'local', sessionIds: ['local-1'] },
      {
        kind: 'remote',
        deviceId: 'dev-a',
        deviceName: 'Studio',
        connected: true,
        sessionIds: ['remote-1', 'remote-2'],
      },
    ]);
  });

  it('returns no origins for an empty explicit session set', () => {
    expect(
      resolveConversationSearchOrigins({
        machineSelection: MACHINE_ALL,
        sessionIds: [],
        devices,
        getSessionDeviceId: () => undefined,
      }),
    ).toEqual([]);
  });

  it('scopes a remote project by workingDir instead of mirrored session ids', () => {
    expect(
      resolveConversationSearchOrigins({
        machineSelection: [MACHINE_LOCAL],
        sessionIds: ['mirrored-only'],
        projectTargets: [{ deviceId: 'dev-a', workingDir: '/repo-remote' }],
        devices,
        getSessionDeviceId: () => 'dev-a',
      }),
    ).toEqual([
      {
        kind: 'remote',
        deviceId: 'dev-a',
        deviceName: 'Studio',
        connected: true,
        sessionIds: null,
        workingDirs: ['/repo-remote'],
      },
    ]);
  });

  it('keeps local/SSH session ids when mixed with a device-link project target', () => {
    expect(
      resolveConversationSearchOrigins({
        machineSelection: MACHINE_ALL,
        sessionIds: ['ssh-hit'],
        projectTargets: [{ deviceId: 'dev-a', workingDir: '/workspace/repo' }],
        devices,
        getSessionDeviceId: () => undefined,
      }),
    ).toEqual([
      {
        kind: 'remote',
        deviceId: 'dev-a',
        deviceName: 'Studio',
        connected: true,
        sessionIds: null,
        workingDirs: ['/workspace/repo'],
      },
      { kind: 'local', sessionIds: ['ssh-hit'] },
    ]);
  });

  it('does not fall back to local when only a connecting device is selected', () => {
    const connecting = searchDevicesFromSwitcher([
      { deviceId: 'dev-connecting', name: 'New Box', status: 'connecting' },
    ]);
    expect(
      resolveConversationSearchOrigins({
        machineSelection: ['dev-connecting'],
        sessionIds: null,
        devices: connecting,
        getSessionDeviceId: () => undefined,
      }),
    ).toEqual([
      {
        kind: 'remote',
        deviceId: 'dev-connecting',
        deviceName: 'New Box',
        connected: true,
        sessionIds: null,
      },
    ]);
  });
});

describe('shouldReleaseConversationSearchLock', () => {
  it('releases a lock when the project leaves the current machine scope', () => {
    expect(
      shouldReleaseConversationSearchLock({
        lockedProjectKey: 'device:dev-a:/repo',
        visibleProjects: [{ projectKey: 'local:/other' }],
        localPlatform: 'darwin',
      }),
    ).toBe(true);
  });

  it('keeps a lock while the project catalogue has not loaded', () => {
    expect(
      shouldReleaseConversationSearchLock({
        lockedProjectKey: 'device:dev-a:/repo',
        visibleProjects: [],
        localPlatform: 'darwin',
        machineSelection: ['dev-a'],
      }),
    ).toBe(false);
  });

  it('releases a lock when switching to a settled empty machine that does not own it', () => {
    expect(
      shouldReleaseConversationSearchLock({
        lockedProjectKey: 'device:dev-a:/repo',
        visibleProjects: [],
        localPlatform: 'darwin',
        machineSelection: ['dev-b'],
      }),
    ).toBe(true);
  });

  it('keeps a lock while the project is still visible', () => {
    expect(
      shouldReleaseConversationSearchLock({
        lockedProjectKey: 'device:dev-a:/repo',
        visibleProjects: [{ projectKey: 'device:dev-a:/repo' }],
        localPlatform: 'darwin',
      }),
    ).toBe(false);
  });
});

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
});

describe('searchCachedSessionsByTitle', () => {
  it('matches visible titles and skips workers', () => {
    const request: ConversationSearchRequest = { query: 'remote', limit: 10 };
    const page = searchCachedSessionsByTitle(
      [
        session({ id: 'hit', title: 'Remote planning', deviceLinkDeviceId: 'dev-a' }),
        session({
          id: 'worker',
          title: 'Remote worker',
          orcaRole: 'worker',
          deviceLinkDeviceId: 'dev-a',
        }),
        session({ id: 'miss', title: 'Local notes' }),
      ],
      request,
    );
    expect(page.results.map((item) => item.session.id)).toEqual(['hit']);
    expect(page.results[0]?.matchKind).toBe('title');
  });
});

describe('searchConversationsAcrossOrigins', () => {
  const request: ConversationSearchRequest = {
    query: 'needle',
    limit: 10,
    sortBy: 'relevance',
    semanticMode: 'hybrid',
  };

  it('fans out, forces keyword on remotes, and survives a failed device', async () => {
    const invokeRemote = vi.fn(async (deviceId: string) => {
      if (deviceId === 'dev-b') throw new Error('[DEVICE_LINK_NOT_CONNECTED] closed');
      return response([result('remote-hit', 50)]);
    });
    const page = await searchConversationsAcrossOrigins(request, {
      origins: [
        { kind: 'local', sessionIds: null },
        {
          kind: 'remote',
          deviceId: 'dev-a',
          deviceName: 'Studio',
          connected: true,
          sessionIds: null,
        },
        {
          kind: 'remote',
          deviceId: 'dev-b',
          deviceName: 'Laptop',
          connected: true,
          sessionIds: null,
        },
      ],
      searchLocal: async () => response([result('local-hit', 20)]),
      invokeRemote,
      listCachedRemoteSessions: (deviceId) => [
        session({
          id: 'cached-hit',
          title: 'Needle on laptop',
          deviceLinkDeviceId: deviceId,
          deviceLinkDeviceName: 'Laptop',
        }),
      ],
    });

    expect(invokeRemote).toHaveBeenCalledWith('dev-a', 'local-db:conversations:search', [
      expect.objectContaining({ semanticMode: 'keyword' }),
    ]);
    expect(page.results.map((item) => item.session.id).sort()).toEqual([
      'cached-hit',
      'local-hit',
      'remote-hit',
    ]);
  });

  it('falls back to sessions:list when the search channel is missing', async () => {
    const invokeRemote = vi.fn(async (_deviceId: string, channel: string) => {
      if (channel === 'local-db:conversations:search') {
        throw new Error('[DEVICE_LINK_CHANNEL_NOT_ALLOWED] not allowlisted');
      }
      return [session({ id: 'legacy', title: 'Needle legacy', deviceLinkDeviceId: 'dev-a' })];
    });
    const page = await searchConversationsAcrossOrigins(request, {
      origins: [
        {
          kind: 'remote',
          deviceId: 'dev-a',
          deviceName: 'Studio',
          connected: true,
          sessionIds: null,
        },
      ],
      searchLocal: async () => emptyConversationSearchResponse('needle'),
      invokeRemote,
      listCachedRemoteSessions: () => [],
    });
    expect(invokeRemote).toHaveBeenNthCalledWith(2, 'dev-a', 'local-db:sessions:list', [
      100,
      'all',
    ]);
    expect(page.results.map((item) => item.session.id)).toEqual(['legacy']);
  });

  it('falls back to sessions:list when the indexed page ignored workingDirs', async () => {
    const invokeRemote = vi.fn(async (_deviceId: string, channel: string) => {
      if (channel === 'local-db:conversations:search') {
        return response([result('other-project', 50, { workingDir: '/other' })]);
      }
      return [session({ id: 'legacy', title: 'Needle legacy', workingDir: '/repo-remote' })];
    });
    const page = await searchConversationsAcrossOrigins(request, {
      origins: [
        {
          kind: 'remote',
          deviceId: 'dev-a',
          deviceName: 'Studio',
          connected: true,
          sessionIds: null,
          workingDirs: ['/repo-remote'],
        },
      ],
      searchLocal: async () => emptyConversationSearchResponse('needle'),
      invokeRemote,
      listCachedRemoteSessions: () => [],
    });
    expect(invokeRemote).toHaveBeenCalledWith('dev-a', 'local-db:sessions:list', [100, 'all']);
    expect(page.results.map((item) => item.session.id)).toEqual(['legacy']);
  });

  it('skips remote invokes when hybrid reuses the first remote page', async () => {
    const invokeRemote = vi.fn();
    const page = await searchConversationsAcrossOrigins(
      { ...request, semanticMode: 'hybrid' },
      {
        origins: [
          { kind: 'local', sessionIds: null },
          {
            kind: 'remote',
            deviceId: 'dev-a',
            deviceName: 'Studio',
            connected: true,
            sessionIds: null,
          },
        ],
        reuseRemoteResults: [result('remote-hit', 50, { deviceLinkDeviceId: 'dev-a' })],
        searchLocal: async () => response([result('local-hit', 20)]),
        invokeRemote,
        listCachedRemoteSessions: () => [],
      },
    );
    expect(invokeRemote).not.toHaveBeenCalled();
    expect(page.results.map((item) => item.session.id).sort()).toEqual([
      'local-hit',
      'remote-hit',
    ]);
  });

  it('keeps remote hits for hybrid reuse after the merged page is truncated', async () => {
    const locals = Array.from({ length: 24 }, (_, index) => result(`local-${index}`, 100 - index));
    const page = await searchConversationsAcrossOrigins(
      { ...request, limit: 24 },
      {
        origins: [
          { kind: 'local', sessionIds: null },
          {
            kind: 'remote',
            deviceId: 'dev-a',
            deviceName: 'Studio',
            connected: true,
            sessionIds: null,
          },
        ],
        searchLocal: async () => response(locals),
        invokeRemote: async () => response([
          result('remote-squeezed', 1, { deviceLinkDeviceId: 'dev-a' }),
        ]),
        listCachedRemoteSessions: () => [],
      },
    );
    expect(page.results.map((item) => item.session.id)).not.toContain('remote-squeezed');
    expect(page.remoteResults?.map((item) => item.session.id)).toEqual(['remote-squeezed']);
    expect(
      remoteResultsFromFanoutPages([
        response(locals),
        response([result('remote-squeezed', 1, { deviceLinkDeviceId: 'dev-a' })]),
      ]).map((item) => item.session.id),
    ).toEqual(['remote-squeezed']);
  });

  it('rejects a failed local hybrid instead of publishing an empty reuse page', async () => {
    await expect(
      searchConversationsAcrossOrigins(
        { ...request, semanticMode: 'hybrid' },
        {
          origins: [{ kind: 'local', sessionIds: null }],
          reuseRemoteResults: [],
          searchLocal: async () => {
            throw new Error('hybrid down');
          },
          invokeRemote: vi.fn(),
          listCachedRemoteSessions: () => [],
        },
      ),
    ).rejects.toMatchObject({ code: 'UNKNOWN' });
  });

  it('returns an empty page when there are no origins', async () => {
    const page = await searchConversationsAcrossOrigins(request, {
      origins: [],
      searchLocal: async () => response([result('local-hit', 1)]),
      invokeRemote: vi.fn(),
      listCachedRemoteSessions: () => [],
    });
    expect(page.results).toEqual([]);
  });
});

describe('requestForOrigin', () => {
  it('does not send a mixed session id set to a remote origin', () => {
    const next = requestForOrigin(
      { query: 'x', semanticMode: 'hybrid', filters: { sessionIds: ['a', 'b'] } },
      {
        kind: 'remote',
        deviceId: 'dev-a',
        deviceName: 'Studio',
        connected: true,
        sessionIds: ['b'],
      },
    );
    expect(next.semanticMode).toBe('keyword');
    expect(next.filters?.sessionIds).toEqual(['b']);
  });

  it('sends workingDirs so the host can search outside the controller mirror', () => {
    const next = requestForOrigin(
      { query: 'x', semanticMode: 'keyword' },
      {
        kind: 'remote',
        deviceId: 'dev-a',
        deviceName: 'Studio',
        connected: true,
        sessionIds: null,
        workingDirs: ['/repo-remote'],
      },
    );
    expect(next.filters?.sessionIds).toBeNull();
    expect(next.filters?.workingDirs).toEqual(['/repo-remote']);
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
