import { describe, expect, it, vi } from 'vitest';
import {
  cachedSessionForSearchResult,
  conversationSearchActiveFilterCount,
  conversationSearchAllowsLocalWrites,
  conversationSearchOriginsFromDeviceModels,
  conversationSearchSessionCacheKey,
  isConversationSearchChannelNotAllowed,
  listConversationSearchProjects,
  nextConversationSearchProjectSelection,
  reconcileConversationSearchProjectSelection,
  scopedConversationSearchOrigins,
  searchCachedDeviceSessions,
  searchConversationsAcrossDevices,
  sessionBelongsToDevice,
  shouldReplaceListWithSearchResults,
  toSearchListItem,
  type ConversationSearchDeviceOrigin,
  type ConversationSearchInvoke,
} from '@/session/conversationSearch';
import type { ConversationSearchResponse } from '@cindy/maker-shared/conversation-search';
import type { RemoteSession } from '@/session/types';

function session(partial: Partial<RemoteSession> & Pick<RemoteSession, 'id' | 'title'>): RemoteSession {
  return {
    userId: 'u',
    workingDir: '/repo',
    workspaceKind: 'project',
    model: 'x',
    effort: 'medium',
    permissionMode: 'default',
    fastMode: false,
    userSendAt: '2026-08-19T00:00:00.000Z',
    status: 'active',
    agentKind: 'cc',
    createdAt: '2026-08-19T00:00:00.000Z',
    updatedAt: '2026-08-19T00:00:00.000Z',
    deviceLinkDeviceId: 'dev-a',
    deviceLinkDeviceName: 'Studio',
    ...partial,
  };
}

function indexedPage(ids: string[]): ConversationSearchResponse {
  return {
    query: 'needle',
    results: ids.map((id, index) => ({
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
      },
      matchKind: 'title' as const,
      titleMatchIndices: [0],
      titleScore: 1,
      contentHit: null,
      contentHits: [],
      rankScore: 10 - index,
    })),
    vectorUsed: false,
    vectorSkipReason: null,
    poolCapped: false,
  };
}

const studio: ConversationSearchDeviceOrigin = {
  deviceId: 'dev-a',
  deviceName: 'Studio',
  reachable: true,
};

describe('searchConversationsAcrossDevices', () => {
  it('stamps indexed hits and keeps one device failure from wiping the rest', async () => {
    const invoke = vi.fn(async (deviceId: string, channel: string) => {
      if (channel !== 'local-db:conversations:search') throw new Error(`unexpected ${channel}`);
      if (deviceId === 'dev-a') return indexedPage(['hit-a']);
      throw new Error('[TIMEOUT] boom');
    }) as ConversationSearchInvoke;
    const page = await searchConversationsAcrossDevices(
      [
        studio,
        { deviceId: 'dev-b', deviceName: 'Laptop', reachable: true },
      ],
      { query: 'needle' },
      {
        invoke,
        getCachedSessions: () => [
          session({ id: 'cached-b', title: 'Needle laptop', deviceLinkDeviceId: 'dev-b' }),
        ],
      },
    );
    expect(page.results.map((item) => item.session.id).sort()).toEqual(['cached-b', 'hit-a']);
    expect(page.results.find((item) => item.session.id === 'hit-a')?.session.deviceLinkDeviceName).toBe('Studio');
  });

  it('falls back to cached title search when the channel is not allowed', async () => {
    const invoke = vi.fn(async () => {
      throw Object.assign(new Error("[CHANNEL_NOT_ALLOWED] channel 'local-db:conversations:search'"), {
        code: 'DEVICE_LINK_CHANNEL_NOT_ALLOWED',
      });
    }) as ConversationSearchInvoke;
    const page = await searchConversationsAcrossDevices(
      [studio],
      { query: 'planning' },
      {
        invoke,
        getCachedSessions: () => [
          session({ id: 'hit', title: 'Remote planning' }),
          session({ id: 'worker', title: 'Planning worker', orcaRole: 'worker' }),
          session({ id: 'other', title: 'Unrelated' }),
        ],
      },
    );
    expect(page.results.map((item) => item.session.id)).toEqual(['hit']);
  });

  it('does not invoke a device that is offline or unresponsive', async () => {
    const invoke = vi.fn();
    const page = await searchConversationsAcrossDevices(
      [{ deviceId: 'dev-a', deviceName: 'Studio', reachable: false }],
      { query: 'planning' },
      {
        invoke: invoke as ConversationSearchInvoke,
        getCachedSessions: () => [session({ id: 'hit', title: 'Remote planning' })],
        isDeviceUnresponsive: () => false,
      },
    );
    expect(invoke).not.toHaveBeenCalled();
    expect(page.results.map((item) => item.session.id)).toEqual(['hit']);
  });

  it('falls back when an old host ignores workingDirs', async () => {
    const invoke = vi.fn(async () => ({
      ...indexedPage(['other']),
      results: indexedPage(['other']).results.map((item) => ({
        ...item,
        session: { ...item.session, workingDir: '/other' },
      })),
    })) as ConversationSearchInvoke;
    const page = await searchConversationsAcrossDevices(
      [studio],
      { query: 'planning', filters: { workingDirs: ['/repo'] } },
      {
        invoke,
        getCachedSessions: () => [
          session({ id: 'in-project', title: 'Planning in repo', workingDir: '/repo' }),
          session({ id: 'out', title: 'Planning elsewhere', workingDir: '/other' }),
        ],
      },
    );
    expect(page.results.map((item) => item.session.id)).toEqual(['in-project']);
  });

  it('forwards keyword search filters and sort to the remote channel', async () => {
    const invoke = vi.fn(async () => indexedPage(['hit-a'])) as ConversationSearchInvoke;
    await searchConversationsAcrossDevices(
      [studio],
      {
        query: 'needle',
        sortBy: 'activityDesc',
        filters: { agentKind: 'cc', lastActivity: '7d', status: 'archived' },
      },
      {
        invoke,
        getCachedSessions: () => [],
      },
    );
    expect(invoke).toHaveBeenCalledWith(
      'dev-a',
      'local-db:conversations:search',
      [expect.objectContaining({
        semanticMode: 'keyword',
        sortBy: 'activityDesc',
        filters: expect.objectContaining({
          agentKind: 'cc',
          lastActivity: '7d',
          status: 'archived',
        }),
      })],
    );
  });

  it('forwards agentKind=pi to the host', async () => {
    const invoke = vi.fn(async () => indexedPage(['pi-hit'])) as ConversationSearchInvoke;
    await searchConversationsAcrossDevices(
      [studio],
      { query: 'needle', filters: { agentKind: 'pi' } },
      {
        invoke,
        getCachedSessions: () => [],
      },
    );
    expect(invoke).toHaveBeenCalledWith(
      'dev-a',
      'local-db:conversations:search',
      [expect.objectContaining({
        filters: expect.objectContaining({ agentKind: 'pi' }),
      })],
    );
  });
});

describe('searchCachedDeviceSessions', () => {
  it('matches the current device only', () => {
    const page = searchCachedDeviceSessions(
      studio,
      { query: 'planning' },
      [
        session({ id: 'hit', title: 'Remote planning' }),
        session({ id: 'other-device', title: 'Remote planning', deviceLinkDeviceId: 'dev-b' }),
      ],
    );
    expect(page.results.map((item) => item.session.id)).toEqual(['hit']);
  });

  it('matches visible title or cached preview, not list metadata', () => {
    const page = searchCachedDeviceSessions(
      studio,
      { query: 'codex' },
      [
        session({ id: 'agent-only', title: 'Unrelated planning', agentKind: 'codex' }),
        session({ id: 'path-only', title: 'Unrelated planning', workingDir: '/Users/dash/codex' }),
        session({ id: 'title-hit', title: 'Try Codex later' }),
        session({
          id: 'preview-hit',
          title: 'Unrelated planning',
          preview: 'switch the task to Codex',
        }),
      ],
    );
    expect(page.results.map((item) => [item.session.id, item.matchKind])).toEqual([
      ['title-hit', 'title'],
      ['preview-hit', 'content'],
    ]);
  });
});

describe('helpers', () => {
  it('classifies CHANNEL_NOT_ALLOWED wrappers', () => {
    expect(isConversationSearchChannelNotAllowed({
      code: 'DEVICE_LINK_CHANNEL_NOT_ALLOWED',
      message: 'nope',
    })).toBe(true);
    expect(isConversationSearchChannelNotAllowed(new Error('TIMEOUT'))).toBe(false);
  });

  it('prefers canonical device id when matching cache rows', () => {
    expect(sessionBelongsToDevice({
      canonicalDeviceId: 'dev-a',
      deviceLinkDeviceId: 'legacy',
    }, 'dev-a')).toBe(true);
  });

  it('lists unique projects and toggles multi-select back to all', () => {
    const projects = listConversationSearchProjects([
      session({ id: 'a', title: 'A', workingDir: '/Users/dash/repo' }),
      session({ id: 'b', title: 'B', workingDir: '/Users/dash/repo/' }),
      session({ id: 'c', title: 'C', workingDir: '/Users/dash/other' }),
      session({ id: 'd', title: 'Chat', workspaceKind: 'dialogue', workingDir: null }),
      session({ id: 'w', title: 'Worker', orcaRole: 'worker', workingDir: '/Users/dash/hidden' }),
    ]);
    expect(projects.map((project) => project.key)).toEqual([
      'dev-a:/Users/dash/other',
      'dev-a:/Users/dash/repo',
    ]);
    expect(projects.find((project) => project.title === 'repo')?.count).toBe(2);
    const mixed = listConversationSearchProjects([
      session({ id: 'a', title: 'A', workingDir: '/Users/dash/repo' }),
      session({
        id: 'b',
        title: 'B',
        workingDir: '/Users/dash/repo',
        deviceLinkDeviceId: 'dev-b',
        deviceLinkDeviceName: 'Laptop',
      }),
    ]);
    expect(mixed.map((project) => project.key)).toEqual([
      'dev-a:/Users/dash/repo',
      'dev-b:/Users/dash/repo',
    ]);
    const scoped = scopedConversationSearchOrigins(
      [
        studio,
        { deviceId: 'dev-b', deviceName: 'Laptop', reachable: true },
      ],
      ['dev-b:/Users/dash/repo'],
      mixed,
    );
    expect(scoped).toEqual([{
      deviceId: 'dev-b',
      deviceName: 'Laptop',
      reachable: true,
      workingDirs: ['/Users/dash/repo'],
    }]);
    expect(nextConversationSearchProjectSelection('all', 'dev-a:/Users/dash/repo')).toEqual(['dev-a:/Users/dash/repo']);
    expect(nextConversationSearchProjectSelection(['dev-a:/Users/dash/repo'], 'dev-a:/Users/dash/repo')).toBe('all');
    expect(reconcileConversationSearchProjectSelection(['gone'], ['dev-a:/Users/dash/repo'])).toBe('all');
  });

  it('counts search filters like desktop: sort is ignored, locked projects are ignored', () => {
    expect(conversationSearchActiveFilterCount({
      agentKind: 'all',
      lastActivity: 'all',
      projectSelection: 'all',
      status: 'all',
    })).toBe(0);
    expect(conversationSearchActiveFilterCount({
      agentKind: 'cc',
      lastActivity: '7d',
      projectSelection: ['/repo'],
      status: 'active',
    })).toBe(4);
    expect(conversationSearchActiveFilterCount({
      lockedWorkingDirs: ['/repo'],
      projectSelection: ['/repo'],
      status: 'all',
    })).toBe(0);
  });

  it('keeps offline devices in the all-tasks search origins and drops hard-cleared peers', () => {
    const origins = conversationSearchOriginsFromDeviceModels([
      { canOpen: true, deviceId: 'dev-a', name: 'Studio', state: 'ready' },
      { canOpen: false, deviceId: 'dev-b', name: 'Laptop', state: 'offline' },
      { canOpen: false, deviceId: 'dev-c', name: 'Revoked', state: 'access_revoked' },
      { canOpen: false, deviceId: 'dev-d', name: 'Closed', state: 'remote_disabled' },
    ], {
      unresponsiveDeviceIds: new Set(['dev-a']),
    });
    expect(origins).toEqual([
      { deviceId: 'dev-a', deviceName: 'Studio', reachable: false },
      { deviceId: 'dev-b', deviceName: 'Laptop', reachable: false },
    ]);
  });

  it('keeps a selected offline device as an unreachable origin', () => {
    expect(conversationSearchOriginsFromDeviceModels([
      { canOpen: true, deviceId: 'dev-a', name: 'Studio', state: 'ready' },
      { canOpen: false, deviceId: 'dev-b', name: 'Laptop', state: 'offline' },
    ], {
      selectedDeviceId: 'dev-b',
    })).toEqual([
      { deviceId: 'dev-b', deviceName: 'Laptop', reachable: false },
    ]);
  });

  it('keeps an empty indexed search visible so filters are not silently dropped', () => {
    expect(shouldReplaceListWithSearchResults('pi', 'ready')).toBe(true);
    expect(shouldReplaceListWithSearchResults('pi', 'searching')).toBe(false);
    expect(shouldReplaceListWithSearchResults('', 'ready')).toBe(false);
  });

  it('adapts a search hit into a list item', () => {
    const page = searchCachedDeviceSessions(
      studio,
      { query: 'planning' },
      [session({ id: 'hit', title: 'Remote planning' })],
    );
    const item = toSearchListItem(page.results[0], Date.parse('2026-08-19T00:00:00.000Z'), '未命名任务');
    expect(item.session.id).toBe('hit');
    expect(item.title).toBe('Remote planning');
    expect(item.searchLocallyCached).toBe(false);
    expect(conversationSearchAllowsLocalWrites(item)).toBe(false);
  });

  it('only attaches a cached session from the same device', () => {
    const hit = searchCachedDeviceSessions(
      studio,
      { query: 'planning' },
      [session({ id: 'shared', title: 'Remote planning' })],
    ).results[0];
    const cachedByKey = new Map([
      [conversationSearchSessionCacheKey(session({
        id: 'shared',
        title: 'Laptop planning',
        deviceLinkDeviceId: 'dev-b',
        canonicalDeviceId: 'dev-b',
      })), session({
        id: 'shared',
        title: 'Laptop planning',
        deviceLinkDeviceId: 'dev-b',
        canonicalDeviceId: 'dev-b',
      })],
      [conversationSearchSessionCacheKey(session({
        id: 'shared',
        title: 'Studio planning',
        canonicalDeviceId: 'dev-a',
      })), session({
        id: 'shared',
        title: 'Studio planning',
        canonicalDeviceId: 'dev-a',
      })],
    ]);
    expect(cachedSessionForSearchResult(hit, cachedByKey)?.deviceLinkDeviceId ?? cachedSessionForSearchResult(hit, cachedByKey)?.canonicalDeviceId).toBe('dev-a');
    const item = toSearchListItem(hit, Date.parse('2026-08-19T00:00:00.000Z'), '未命名任务', cachedSessionForSearchResult(hit, cachedByKey));
    expect(item.searchLocallyCached).toBe(true);
    expect((item.session as RemoteSession).deviceLinkDeviceId).toBe('dev-a');
    expect(conversationSearchAllowsLocalWrites(item)).toBe(false);
    expect(conversationSearchAllowsLocalWrites({ session: { id: 'plain' } })).toBe(true);
  });
});
