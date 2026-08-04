// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import type { MouseEvent, ReactElement, ReactNode } from 'react';
import type { NavigateFunction } from 'react-router-dom';

import { searchConversations } from '@/lib/conversationSearchService';
import { ConversationSearchBox } from '@/features/cc-agent/sidebar/ConversationSearchBox';
import type { ProjectNode as ProjectNodeData } from '@/features/cc-agent/lib/projectGrouping';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (key === 'ccAgent.search.filter.active') return `filters:${String(options?.count)}`;
      if (key === 'ccAgent.sidebar.filterSelectedProjects') {
        return `${String(options?.count)} projects`;
      }
      if (key === 'ccAgent.search.filterAria') return 'filter';
      if (key === 'ccAgent.search.sortAria') return 'sort';
      return key;
    },
  }),
}));

vi.mock('@/lib/conversationSearchService', () => ({
  searchConversations: vi.fn(),
}));

vi.mock('@/lib/orcaSessionIdentity', () => ({
  resolveSessionRoute: vi.fn(),
}));

vi.mock('@/components/ui/tooltip', async () => {
  const React = await import('react');

  return {
    Tip: ({ children }: { children: ReactNode }) => React.createElement(React.Fragment, null, children),
  };
});

vi.mock('@/components/ui/popover', async () => {
  const React = await import('react');
  const PopoverContext = React.createContext<{
    open: boolean;
    onOpenChange: (next: boolean) => void;
  } | null>(null);

  return {
    Popover: ({
      open,
      onOpenChange,
      children,
    }: {
      open: boolean;
      onOpenChange: (next: boolean) => void;
      children: ReactNode;
    }) =>
      React.createElement(
        PopoverContext.Provider,
        { value: { open, onOpenChange } },
        children,
      ),
    PopoverTrigger: ({ children }: { asChild?: boolean; children: ReactNode }) => {
      const ctx = React.useContext(PopoverContext);
      const child = React.Children.only(children) as ReactElement<{
        onClick?: (event: MouseEvent<HTMLElement>) => void;
      }>;
      return React.cloneElement(child, {
        onClick: (event: MouseEvent<HTMLElement>) => {
          child.props.onClick?.(event);
          ctx?.onOpenChange(!ctx.open);
        },
      });
    },
    PopoverContent: ({ children }: { children: ReactNode }) => {
      const ctx = React.useContext(PopoverContext);
      if (!ctx?.open) return null;
      return React.createElement('div', { 'data-testid': 'conversation-search-popover' }, children);
    },
  };
});

vi.mock('@/components/ui/dropdown-menu', async () => {
  const React = await import('react');

  type SelectEvent = {
    preventDefault: () => void;
    stopPropagation: () => void;
  };
  type MenuItemProps = {
    children: ReactNode;
    disabled?: boolean;
    onSelect?: (event: SelectEvent) => void;
  };
  const passthrough = ({ children }: { children: ReactNode }) =>
    React.createElement(React.Fragment, null, children);

  return {
    DropdownMenu: passthrough,
    DropdownMenuContent: passthrough,
    DropdownMenuSub: passthrough,
    DropdownMenuSubContent: passthrough,
    DropdownMenuTrigger: passthrough,
    DropdownMenuSeparator: () => React.createElement('hr'),
    DropdownMenuSubTrigger: ({ children }: { children: ReactNode }) =>
      React.createElement('button', { type: 'button' }, children),
    DropdownMenuItem: ({ children, disabled, onSelect }: MenuItemProps) =>
      React.createElement(
        'button',
        {
          type: 'button',
          disabled,
          onClick: (event: MouseEvent<HTMLButtonElement>) => {
            onSelect?.(event);
          },
        },
        children,
      ),
  };
});

const source = readFileSync(
  resolve(__dirname, '..', 'features', 'cc-agent', 'sidebar', 'ConversationSearchBox.tsx'),
  'utf8',
);
const projectNodeSource = readFileSync(
  resolve(__dirname, '..', 'features', 'cc-agent', 'sidebar', 'sections', 'ProjectNode.tsx'),
  'utf8',
);
const SEARCH_WAIT_TIMEOUT_MS = 1500;

const projects: ProjectNodeData[] = [
  {
    projectKey: 'local:/repo-a',
    scope: 'local',
    workingDir: '/repo-a',
    remoteHostId: null,
    deviceLinkDeviceId: null,
    deviceLinkDeviceName: null,
    deviceLinkConnectionStatus: null,
    displayName: 'Repo A',
    segments: 1,
    sessions: [
      { id: 'session-a1' } as ProjectNodeData['sessions'][number],
      { id: 'session-a2' } as ProjectNodeData['sessions'][number],
    ],
    latestActivityAt: '2026-06-14T00:00:00.000Z',
  },
  {
    projectKey: 'local:/repo-b',
    scope: 'local',
    workingDir: '/repo-b',
    remoteHostId: null,
    deviceLinkDeviceId: null,
    deviceLinkDeviceName: null,
    deviceLinkConnectionStatus: null,
    displayName: 'Repo B',
    segments: 1,
    sessions: [{ id: 'session-b1' } as ProjectNodeData['sessions'][number]],
    latestActivityAt: '2026-06-14T00:00:00.000Z',
  },
];

const navigate = vi.fn() as unknown as NavigateFunction;

function renderSearchBox({
  requestId = null,
  allKnownProjects = projects,
  sessionIds = ['session-a1', 'session-a2'],
}: {
  requestId?: number | null;
  allKnownProjects?: ProjectNodeData[];
  sessionIds?: string[];
} = {}) {
  return render(
    createElement(ConversationSearchBox, {
      navigate,
      allKnownProjects,
      projectFilterRequest:
        requestId == null
          ? null
          : {
              projectKey: 'local:/repo-a',
              projectName: 'Repo A',
              sessionIds,
              requestId,
            },
    }),
  );
}

function allProjectsOption(): HTMLButtonElement {
  return screen.getByRole('button', {
    name: 'ccAgent.search.filter.allProjects',
  }) as HTMLButtonElement;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('ConversationSearchBox live search', () => {
  it('runs the live prefix pass as keyword-only before the delayed hybrid refresh', () => {
    const keywordMode = source.indexOf("semanticMode: 'keyword'");
    const hybridMode = source.indexOf("semanticMode: 'hybrid'");

    expect(source).toContain('SEMANTIC_SEARCH_DEBOUNCE_MS');
    expect(keywordMode).toBeGreaterThan(-1);
    expect(hybridMode).toBeGreaterThan(keywordMode);
  });

  it('ignores delayed keyword results once the hybrid refresh has started', () => {
    const keywordStaleGuard = source.indexOf('if (semanticStartedSeqRef.current === seq) return;');
    const hybridStartedMark = source.indexOf('semanticStartedSeqRef.current = seq;');
    const hybridMode = source.indexOf("semanticMode: 'hybrid'");

    expect(source).toContain('semanticStartedSeqRef');
    expect(keywordStaleGuard).toBeGreaterThan(-1);
    expect(hybridStartedMark).toBeGreaterThan(keywordStaleGuard);
    expect(hybridStartedMark).toBeLessThan(hybridMode);
  });

  it('restores a terminal state if the hybrid refresh fails first', () => {
    const hybridCatch = source.indexOf("semanticMode: 'hybrid'");
    const resetSemanticGuard = source.indexOf('semanticStartedSeqRef.current = 0;', hybridCatch);
    const terminalStatus = source.indexOf(
      "setStatus((current) => current === 'searching' ? 'error' : current);",
      hybridCatch,
    );

    expect(resetSemanticGuard).toBeGreaterThan(hybridCatch);
    expect(terminalStatus).toBeGreaterThan(resetSemanticGuard);
  });

  it('opens with a locked project filter and searches only that project at runtime', async () => {
    vi.mocked(searchConversations).mockResolvedValue({
      query: 'needle',
      results: [],
      vectorUsed: false,
      vectorSkipReason: null,
      poolCapped: false,
    });

    renderSearchBox({ requestId: 1 });

    await screen.findByTestId('conversation-search-popover');
    expect(allProjectsOption().disabled).toBe(true);
    expect(
      screen
        .getAllByRole('button', { name: /Repo A/ })
        .some((button) => (button as HTMLButtonElement).disabled),
    ).toBe(true);

    fireEvent.change(screen.getByLabelText('ccAgent.search.placeholder'), {
      target: { value: 'needle' },
    });

    await waitFor(() => {
      expect(searchConversations).toHaveBeenCalledWith(
        expect.objectContaining({
          query: 'needle',
          semanticMode: 'keyword',
          filters: expect.objectContaining({
            sessionIds: ['session-a1', 'session-a2'],
          }),
        }),
      );
    }, { timeout: SEARCH_WAIT_TIMEOUT_MS });
  });

  it('falls back to the project menu session IDs before the all-project index is loaded', async () => {
    vi.mocked(searchConversations).mockResolvedValue({
      query: 'needle',
      results: [],
      vectorUsed: false,
      vectorSkipReason: null,
      poolCapped: false,
    });

    renderSearchBox({
      requestId: 1,
      allKnownProjects: [],
      sessionIds: ['visible-session-a1', 'visible-session-a2'],
    });

    await screen.findByTestId('conversation-search-popover');

    fireEvent.change(screen.getByLabelText('ccAgent.search.placeholder'), {
      target: { value: 'needle' },
    });

    await waitFor(() => {
      expect(searchConversations).toHaveBeenCalledWith(
        expect.objectContaining({
          query: 'needle',
          semanticMode: 'keyword',
          filters: expect.objectContaining({
            sessionIds: ['visible-session-a1', 'visible-session-a2'],
          }),
        }),
      );
    }, { timeout: SEARCH_WAIT_TIMEOUT_MS });
  });

  // 搜索结果行是「列表之外」的第二个标题出口:本 PR 早前只投影了侧边栏 / 会话头 / tab,
  // 结果行仍渲染原始 title,于是列表写「未命名对话」、搜索结果写 "New Maker"。
  // 匹配串(main 算下标)与渲染串(这里)必须是同一个 conversationSearchTitle 的结果。
  it('未起名会话在结果行里显示兜底文案,并把 unnamedLabel 带进请求', async () => {
    vi.mocked(searchConversations).mockResolvedValue({
      query: 'needle',
      results: [
        {
          session: {
            id: 'session-draft',
            // main 返回的 summary 仍是**原始存储值**(投影只发生在渲染这一刻)。
            title: 'New Maker',
            workingDir: '/repo-a',
            workspaceKind: 'project',
            agentKind: 'cc',
            status: 'active',
            userSendAt: null,
            updatedAt: '2026-06-14T00:00:00.000Z',
            createdAt: '2026-06-14T00:00:00.000Z',
            _count: { messages: 2 },
          },
          matchKind: 'title',
          titleMatchIndices: [],
          titleScore: 1,
          contentHit: null,
          contentHits: [],
          rankScore: 1,
        },
      ],
      vectorUsed: false,
      vectorSkipReason: null,
      poolCapped: false,
    });

    renderSearchBox({ requestId: 1 });
    await screen.findByTestId('conversation-search-popover');

    fireEvent.change(screen.getByLabelText('ccAgent.search.placeholder'), {
      target: { value: 'needle' },
    });

    await waitFor(() => {
      expect(searchConversations).toHaveBeenCalledWith(
        expect.objectContaining({ unnamedLabel: 'ccAgent.common.unnamedSession' }),
      );
    }, { timeout: SEARCH_WAIT_TIMEOUT_MS });

    // mock 的 t 对未识别 key 原样返回 key,所以兜底文案就是这个 key 串。
    await waitFor(() => {
      expect(screen.getAllByText('ccAgent.common.unnamedSession').length).toBeGreaterThan(0);
    }, { timeout: SEARCH_WAIT_TIMEOUT_MS });
    expect(screen.queryByText('New Maker')).toBeNull();
  });

  it('reapplies a same-project menu request when only requestId changes', async () => {
    const view = renderSearchBox({ requestId: 1 });

    await screen.findByTestId('conversation-search-popover');
    expect(allProjectsOption().disabled).toBe(true);

    fireEvent.click(screen.getByLabelText('ccAgent.search.open'));
    await waitFor(() => expect(screen.queryByTestId('conversation-search-popover')).toBeNull());

    fireEvent.click(screen.getByLabelText('ccAgent.search.open'));
    await screen.findByTestId('conversation-search-popover');
    expect(allProjectsOption().disabled).toBe(false);

    view.rerender(
      createElement(ConversationSearchBox, {
        navigate,
        allKnownProjects: projects,
        projectFilterRequest: {
          projectKey: 'local:/repo-a',
          projectName: 'Repo A',
          sessionIds: ['session-a1', 'session-a2'],
          requestId: 2,
        },
      }),
    );

    await waitFor(() => expect(allProjectsOption().disabled).toBe(true));
  });

  it('routes the project menu search action to the shared conversation search', () => {
    expect(projectNodeSource).toContain('onOpenConversationSearch(project);');
    expect(projectNodeSource).not.toContain('useSessionSearch');
    expect(projectNodeSource).not.toContain('search.isOpen');
    expect(projectNodeSource).not.toContain('search.open();');
  });
});
