// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useConversationSearch } from '@/features/cc-agent/sidebar/ConversationSearchBox';
import { searchConversations } from '@/lib/conversationSearchService';
import type { ConversationSearchResponse } from '../../shared/conversationSearch';
import type { ProjectNode } from '@/features/cc-agent/lib/projectGrouping';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/conversationSearchService', () => ({ searchConversations: vi.fn() }));

function deferred() {
  let resolve!: (value: ConversationSearchResponse) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<ConversationSearchResponse>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function page(id?: string, remote = false): ConversationSearchResponse {
  return {
    query: 'needle',
    vectorUsed: false,
    vectorSkipReason: null,
    poolCapped: false,
    results: id
      ? [
          {
            session: {
              id,
              title: id,
              agentKind: 'cc',
              status: 'active',
              workingDir: '/repo',
              workspaceKind: 'project',
              userSendAt: null,
              createdAt: '2026-09-01',
              updatedAt: '2026-09-01',
              ...(remote ? { deviceLinkDeviceId: 'remote' } : {}),
              _count: { messages: 1 },
            },
            matchKind: 'title',
            titleMatchIndices: [],
            titleScore: 1,
            contentHit: null,
            contentHits: [],
            rankScore: 1,
          },
        ]
      : [],
  };
}
const devices = [{ deviceId: 'remote', deviceName: 'Mac', connected: true }];
function mount(machineSelection: 'all' | string[] = 'all') {
  return renderHook(
    ({ projects, searchDevices }) =>
      useConversationSearch({
        enabled: true,
        navigate: vi.fn(),
        allKnownProjects: projects,
        searchDevices,
        machineSelection,
      }),
    { initialProps: { projects: [] as ProjectNode[], searchDevices: devices } },
  );
}
async function start(view: ReturnType<typeof mount>) {
  act(() => view.result.current.setQuery('needle'));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(900);
  });
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(searchConversations).mockReset();
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { platform: 'darwin' },
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Reflect.deleteProperty(window, 'electronAPI');
});

describe('conversation search request lifecycle', () => {
  it.each(['keyword', 'hybrid'])(
    'merges both pages when %s finishes first after both start',
    async (first) => {
      const keyword = deferred();
      const hybrid = deferred();
      vi.mocked(searchConversations).mockImplementation((request) =>
        request.semanticMode === 'keyword' ? keyword.promise : hybrid.promise,
      );
      const view = mount();
      await start(view);
      const keywordPage = page('keyword');
      keywordPage.results.push(...page('remote-hit', true).results);
      await act(async () =>
        (first === 'keyword' ? keyword : hybrid).resolve(
          first === 'keyword' ? keywordPage : page('semantic'),
        ),
      );
      expect(view.result.current.results.map((item) => item.session.id)).toContain(
        first === 'keyword' ? 'keyword' : 'semantic',
      );
      await act(async () =>
        (first === 'keyword' ? hybrid : keyword).resolve(
          first === 'keyword' ? page('semantic') : keywordPage,
        ),
      );
      expect(view.result.current.results.map((item) => item.session.id).sort()).toEqual([
        'remote-hit',
        'semantic',
      ]);
    },
  );
  it('does not publish an empty local hybrid page while remote keyword results are pending', async () => {
    const keyword = deferred();
    vi.mocked(searchConversations).mockImplementation((request) =>
      request.semanticMode === 'keyword' ? keyword.promise : Promise.resolve(page()),
    );
    const view = mount();
    await start(view);
    expect(view.result.current.status).toBe('searching');
    await act(async () => keyword.resolve(page('remote-hit', true)));
    expect(view.result.current.results[0]?.session.id).toBe('remote-hit');
  });
  it('does not run a synthetic hybrid request for a remote-only search', async () => {
    const keyword = deferred();
    vi.mocked(searchConversations).mockReturnValue(keyword.promise);
    const view = mount(['remote']);
    await start(view);
    expect(searchConversations).toHaveBeenCalledTimes(1);
    expect(view.result.current.status).toBe('searching');
    await act(async () => keyword.resolve(page('remote-hit', true)));
    expect(view.result.current.status).toBe('done');
  });
  it.each(['keyword', 'hybrid'])('retains the successful page when %s fails', async (failed) => {
    vi.mocked(searchConversations).mockImplementation((request) =>
      request.semanticMode === failed
        ? Promise.reject(new Error('offline'))
        : Promise.resolve(page('hit')),
    );
    const view = mount();
    await start(view);
    expect(view.result.current.status).toBe('done');
    expect(view.result.current.results[0]?.session.id).toBe('hit');
  });
  it('reports failure when both pages fail', async () => {
    vi.mocked(searchConversations).mockRejectedValue(new Error('offline'));
    const view = mount();
    await start(view);
    expect(view.result.current.status).toBe('error');
  });
  it('keeps results and request count stable across equivalent device snapshots', async () => {
    vi.mocked(searchConversations).mockResolvedValue(page('hit'));
    const view = mount();
    await start(view);
    view.rerender({ projects: [], searchDevices: devices.map((device) => ({ ...device })) });
    expect(view.result.current.status).toBe('done');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(searchConversations).toHaveBeenCalledTimes(2);
  });
  it('ignores both late pages after the query is cleared', async () => {
    const keyword = deferred();
    const hybrid = deferred();
    vi.mocked(searchConversations).mockImplementation((request) =>
      request.semanticMode === 'keyword' ? keyword.promise : hybrid.promise,
    );
    const view = mount();
    await start(view);
    act(() => view.result.current.setQuery(''));
    await act(async () => {
      keyword.resolve(page('old'));
      hybrid.resolve(page('old'));
    });
    expect(view.result.current.status).toBe('idle');
    expect(view.result.current.results).toEqual([]);
  });
  it('keeps remote project search stable when recent activity reorders selected projects', async () => {
    vi.mocked(searchConversations).mockResolvedValue(page('hit', true));
    const projects = ['a', 'b'].map(
      (name) =>
        ({
          projectKey: `device:remote:/${name}`,
          workingDir: `/${name}`,
          deviceLinkDeviceId: 'remote',
          sessions: [],
          scope: 'local',
        }) as unknown as ProjectNode,
    );
    const view = mount();
    view.rerender({ projects, searchDevices: devices });
    act(() =>
      view.result.current.setProjectSelection(projects.map((project) => project.projectKey)),
    );
    await start(view);
    view.rerender({ projects: [...projects].reverse(), searchDevices: devices });
    expect(view.result.current.status).toBe('done');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(searchConversations).toHaveBeenCalledTimes(1);
  });
  it('keeps project search stable when task activity reorders the same sessions', async () => {
    vi.mocked(searchConversations).mockResolvedValue(page('hit'));
    const project = {
      projectKey: 'local:/repo',
      workingDir: '/repo',
      scope: 'local',
      sessions: [{ id: 'a' }, { id: 'b' }],
    } as ProjectNode;
    const view = mount();
    view.rerender({ projects: [project], searchDevices: devices });
    act(() => view.result.current.setProjectSelection(['local:/repo']));
    await start(view);
    view.rerender({
      projects: [{ ...project, sessions: [...project.sessions].reverse() }],
      searchDevices: devices,
    });
    expect(view.result.current.status).toBe('done');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(searchConversations).toHaveBeenCalledTimes(2);
    view.rerender({
      projects: [{ ...project, sessions: [project.sessions[0]] }],
      searchDevices: devices,
    });
    expect(view.result.current.status).toBe('searching');
  });
});
