// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useConversationSearch } from '@/session/useConversationSearch';
import {
  searchConversationsAcrossDevices,
  shouldReplaceListWithSearchResults,
} from '@/session/conversationSearch';
import type { ConversationSearchResponse } from '@cindy/maker-shared/conversation-search';

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
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let search: ReturnType<typeof useConversationSearch>;
function Probe({ count = 1, reachable = true }: { count?: number; reachable?: boolean }) {
  search = useConversationSearch({
    enabled: true,
    origins: [{ deviceId: 'mac', deviceName: 'Mac', reachable }],
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
