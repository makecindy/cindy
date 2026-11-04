// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HomeViewSession } from '@/session/homeViewSession';
import { useConversationSearch } from '@/session/useConversationSearch';
import {
  searchConversationsAcrossDevices,
  shouldReplaceListWithSearchResults,
  type ConversationSearchDeviceOrigin,
} from '@/session/conversationSearch';
import type { ConversationSearchRequest, ConversationSearchResponse } from '@cindy/maker-shared/conversation-search';

vi.mock('react-i18next', async (original) => ({
  ...(await original<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/device-link/DeviceLinkContext', () => ({
  useDeviceLink: () => ({ invoke }),
}));
vi.mock('@/session/remoteSessionStore', () => ({
  remoteSessionStore: { getSessions: () => [] },
}));
vi.mock('@/session/conversationSearch', async (original) => ({
  ...(await original<typeof import('@/session/conversationSearch')>()),
  searchConversationsAcrossDevices: vi.fn(),
}));
const invoke = vi.fn();
const { searchConversationsAcrossDevices: realSearch } = await vi.importActual<typeof import('@/session/conversationSearch')>(
  '@/session/conversationSearch',
);
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let search: ReturnType<typeof useConversationSearch>;
function Probe({ count = 1, reachable = true, retainedState, origins }: {
  count?: number; reachable?: boolean; retainedState?: HomeViewSession;
  origins?: ConversationSearchDeviceOrigin[];
}) {
  search = useConversationSearch({
    enabled: true,
    retainedState,
    origins: origins ?? [{ deviceId: 'mac', deviceName: 'Mac', reachable }],
    projects: [
      {
        deviceId: 'mac',
        deviceName: 'Mac',
        key: 'mac:/repo',
        title: 'Repo',
        workingDir: '/repo',
        count,
      },
    ],
  });
  return createElement(
    'div',
    null,
    shouldReplaceListWithSearchResults(search.query, search.status) ? 'indexed' : 'fallback',
  );
}
const page: ConversationSearchResponse = {
  query: 'needle',
  vectorUsed: false,
  vectorSkipReason: null,
  poolCapped: false,
  results: [
    {
      session: {
        id: 'body-match',
        title: 'Unrelated title',
        agentKind: 'cc',
        status: 'active',
        workingDir: '/repo',
        deviceLinkDeviceId: 'mac',
        workspaceKind: 'project',
        userSendAt: null,
        deviceLinkDeviceName: 'Mac',
        createdAt: '2026-09-01',
        updatedAt: '2026-09-01',
        _count: { messages: 1 },
      },
      matchKind: 'title',
      titleMatchIndices: [],
      titleScore: 1,
      contentHit: null,
      contentHits: [],
      rankScore: 1,
    },
  ],
};
beforeEach(() => {
  vi.useFakeTimers();
  invoke.mockReset();
  vi.mocked(searchConversationsAcrossDevices).mockReset().mockResolvedValue(page);
  root = createRoot(document.createElement('div'));
});
afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
});
async function render(count = 1, reachable = true) {
  await act(async () => root.render(createElement(Probe, { count, reachable })));
}
async function start() {
  await render();
  act(() => search.setQuery('needle'));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250);
  });
}
describe('mobile search scope refresh', () => {
  // Test value (unit): mount the real hook and fan-out, mocking only the network.
  // Final-only mock pages miss partial result visibility and request invalidation.
  // Minimal inputs: two devices with deferred responses, then a changed query
  // while a prior invoke is queued. No real timers, sockets, or source assertions.
  // Standalone Vitest runtime: 1.82s (2026-11-04).
  it('shows the fast device before the slow device and stays loading until both finish', async () => {
    vi.mocked(searchConversationsAcrossDevices).mockImplementation(realSearch);
    const replies = new Map<string, (value: ConversationSearchResponse) => void>();
    invoke.mockImplementation((deviceId: string) => new Promise<ConversationSearchResponse>((resolve) => {
      replies.set(deviceId, resolve);
    }));
    await act(async () => root.render(<Probe origins={[
      { deviceId: 'mac', deviceName: 'Mac', reachable: true },
      { deviceId: 'slow', deviceName: 'Slow', reachable: true },
    ]} />));
    act(() => search.setQuery('needle'));
    expect(search.status).toBe('searching');
    expect(search.results).toEqual([]);
    await act(async () => vi.advanceTimersByTimeAsync(250));
    await act(async () => replies.get('mac')!(page));
    expect(search.status).toBe('searching');
    expect(search.results.map((result) => result.session.deviceLinkDeviceId)).toEqual(['mac']);
    expect(shouldReplaceListWithSearchResults(search.query, search.status)).toBe(true);
    await act(async () => replies.get('slow')!(page));
    expect(search.status).toBe('ready');
    expect(search.results.map((result) => result.session.deviceLinkDeviceId)).toEqual(['mac', 'slow']);
  });

  it('drops old queued sends and late replies when a new query replaces the visible partial page', async () => {
    vi.mocked(searchConversationsAcrossDevices).mockImplementation(realSearch);
    const sent: string[] = [];
    let releaseQueued!: () => void;
    let releaseLate!: (value: ConversationSearchResponse) => void;
    invoke.mockImplementation((deviceId: string, _channel: string, args: unknown[], opts?: { preSend?: () => void }) => {
      const query = (args[0] as ConversationSearchRequest).query;
      if (query === 'needle' && deviceId === 'queued') {
        return new Promise<ConversationSearchResponse>((resolve, reject) => {
          releaseQueued = () => {
            try {
              opts?.preSend?.();
              sent.push(`${query}:${deviceId}`);
              resolve(page);
            } catch (error) { reject(error); }
          };
        });
      }
      opts?.preSend?.();
      sent.push(`${query}:${deviceId}`);
      if (query === 'needle' && deviceId === 'late') {
        return new Promise<ConversationSearchResponse>((resolve) => { releaseLate = resolve; });
      }
      return Promise.resolve({ ...page, results: page.results.map((item) => ({
        ...item, session: { ...item.session, id: query },
      })) });
    });
    await act(async () => root.render(<Probe origins={[
      { deviceId: 'mac', deviceName: 'Mac', reachable: true },
      { deviceId: 'queued', deviceName: 'Queued', reachable: true },
      { deviceId: 'late', deviceName: 'Late', reachable: true },
    ]} />));
    act(() => search.setQuery('needle'));
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(search.results.map((result) => result.session.id)).toEqual(['needle']);
    act(() => search.setQuery('latest'));
    expect(search.results).toEqual([]);
    expect(search.status).toBe('searching');
    await act(async () => { releaseQueued(); releaseLate(page); });
    expect(sent).not.toContain('needle:queued');
    expect(search.results).toEqual([]);
    expect(search.status).toBe('searching');
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(search.status).toBe('ready');
    expect(search.results).toHaveLength(3);
    expect(search.results.every((result) => result.session.id === 'latest')).toBe(true);
  });

  it('keeps the real search query and filters when Home moves between hosts', async () => {
    const retainedState = new HomeViewSession();
    vi.mocked(searchConversationsAcrossDevices).mockResolvedValue(page);
    await act(async () => root.render(<Probe key="page" retainedState={retainedState} />));
    act(() => {
      search.setQuery('needle');
      search.setSortBy('activityDesc');
      search.setStatusFilter('active');
      search.setProjectSelection(['mac:/repo']);
    });
    await act(async () => root.render(<Probe key="sidebar" retainedState={retainedState} />));
    expect(search.query).toBe('needle');
    expect(search.sortBy).toBe('activityDesc');
    expect(search.statusFilter).toBe('active');
    expect(search.projectSelection).toEqual(['mac:/repo']);
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(search.results.map((result) => result.session.id)).toEqual(['body-match']);
  });
  it('keeps the indexed page visible when project counts and object references refresh', async () => {
    await start();
    expect(search.status).toBe('ready');
    await render(2);
    expect(shouldReplaceListWithSearchResults(search.query, search.status)).toBe(true);
    expect(search.results[0]?.session.id).toBe('body-match');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(searchConversationsAcrossDevices).toHaveBeenCalledTimes(1);
  });
  it('does not starve a pending search when equivalent snapshots arrive within the debounce', async () => {
    await render();
    act(() => search.setQuery('needle'));
    for (let count = 2; count <= 5; count++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
      await render(count);
    }
    expect(searchConversationsAcrossDevices).toHaveBeenCalledTimes(1);
    expect(search.status).toBe('ready');
  });
  it('still searches again for actual query and connectivity changes', async () => {
    await start();
    await render(1, false);
    expect(search.status).toBe('searching');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    act(() => search.setQuery('different'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(searchConversationsAcrossDevices).toHaveBeenCalledTimes(3);
  });
  it('ignores a late response after the query is cleared', async () => {
    let resolve!: (value: ConversationSearchResponse) => void;
    vi.mocked(searchConversationsAcrossDevices).mockReturnValue(
      new Promise((yes) => {
        resolve = yes;
      }),
    );
    await start();
    act(() => search.setQuery(''));
    await act(async () => resolve(page));
    expect(search.status).toBe('idle');
    expect(search.results).toEqual([]);
  });
});
