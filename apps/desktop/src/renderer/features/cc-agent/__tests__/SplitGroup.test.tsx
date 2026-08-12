// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLayoutEffect } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { ApiError } from '@/lib/httpClient';
import { SplitGroup } from '../SplitGroup';
import { getSplitPanes, splitGroupStore } from '../splitGroupStore';

const {
  deferredRouteActionMock,
  navigateMock,
  resolveSessionRouteMock,
  routeActionMock,
  sessionGetMock,
  sessionViewRenderMock,
  useCCSessionsMock,
} = vi.hoisted(() => ({
  deferredRouteActionMock: vi.fn(),
  navigateMock: vi.fn(),
  resolveSessionRouteMock: vi.fn(async (sessionId: string) => `/cc-agent/${sessionId}`),
  routeActionMock: vi.fn(),
  sessionGetMock: vi.fn(),
  sessionViewRenderMock: vi.fn(),
  useCCSessionsMock: vi.fn(),
}));

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => navigateMock };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@/hooks/useCCSessions', () => ({
  useCCSessions: useCCSessionsMock,
}));

vi.mock('@/features/device-link/remoteProjectsStore', () => ({
  useRemoteProjectSessions: () => [],
  useRemoteBootstrapLoadingDeviceIds: () => new Set(),
  useRemoteBootstrapFailedDeviceIds: () => new Set(),
}));

vi.mock('@/lib/orcaSessionIdentity', () => ({
  getSessionRouteOwnerId: (route: string) => /^\/cc-agent\/([^/?#]+)/.exec(route)?.[1] ?? null,
  resolveSessionRoute: resolveSessionRouteMock,
}));

vi.mock('@/lib/makerTransport', () => ({
  getSessionFor: sessionGetMock,
}));

vi.mock('../CCAgentSessionView', () => ({
  CCAgentSessionView: ({
    sessionIdProp,
    routeOwner,
    sidebarTargetSessionId,
    onSessionNavigate,
    disableAutofocus,
  }: {
    sessionIdProp: string;
    routeOwner: boolean;
    sidebarTargetSessionId: string;
    onSessionNavigate?: (targetSessionId: string, routeOwnerSessionId?: string) => void;
    disableAutofocus?: boolean;
  }) => {
    sessionViewRenderMock(sessionIdProp);
    return (
      <div
        data-testid={`session-view-${sessionIdProp}`}
        data-session-id={sessionIdProp}
        data-route-owner={routeOwner ? 'true' : 'false'}
        data-sidebar-target-session-id={sidebarTargetSessionId}
        data-disable-autofocus={disableAutofocus ? 'true' : 'false'}
        onDragOver={(event) => event.stopPropagation()}
        onDrop={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          data-testid={`route-action-${sessionIdProp}`}
          data-split-pane-route-action=""
          onClick={() => {
            onSessionNavigate?.('session-c', 'session-c');
            routeActionMock();
          }}
        >
          Route action
        </button>
        <button
          type="button"
          data-testid={`worker-route-action-${sessionIdProp}`}
          data-split-pane-route-action=""
          onClick={() => {
            onSessionNavigate?.('worker-c', 'lead-c');
            routeActionMock();
          }}
        >
          Worker route action
        </button>
        <button
          type="button"
          data-testid={`deferred-route-action-${sessionIdProp}`}
          data-split-pane-route-action=""
          onClick={() => deferredRouteActionMock(onSessionNavigate)}
        >
          Deferred route action
        </button>
        <button
          type="button"
          data-testid={`composer-action-${sessionIdProp}`}
          onContextMenu={routeActionMock}
        >
          Composer action
        </button>
        <div
          data-testid={`composer-drop-target-${sessionIdProp}`}
          data-split-group-composer-drop-target=""
        >
          <span data-testid={`composer-drop-child-${sessionIdProp}`}>Composer drop</span>
        </div>
      </div>
    );
  },
}));

function renderSplitGroup(activeSessionId: string) {
  return render(
    <MemoryRouter>
      <SplitGroup activeSessionId={activeSessionId}>
        <div data-testid="route-outlet" />
      </SplitGroup>
    </MemoryRouter>,
  );
}

describe('SplitGroup', () => {
  beforeEach(() => {
    localStorage.clear();
    deferredRouteActionMock.mockClear();
    navigateMock.mockClear();
    resolveSessionRouteMock.mockClear();
    routeActionMock.mockClear();
    sessionGetMock.mockReset();
    sessionViewRenderMock.mockClear();
    useCCSessionsMock.mockReset();
    useCCSessionsMock.mockReturnValue({ sessions: [], isLoading: true, error: null });
    splitGroupStore.__resetForTest();
  });

  afterEach(() => {
    cleanup();
    splitGroupStore.__resetForTest();
  });

  it('未分屏时保留路由内容并提供任务拖入落点', () => {
    const view = renderSplitGroup('session-a');

    expect(screen.getByTestId('route-outlet')).toBeTruthy();
    expect(view.container.querySelector('[data-split-drop-target="single"]')).toBeTruthy();
  });

  it('会话目录加载完成后清理已删除 session 的持久化 pane', async () => {
    useCCSessionsMock.mockReturnValue({
      sessions: [{ id: 'session-a', title: 'Session A', status: 'active' }],
      isLoading: false,
      error: null,
    });
    sessionGetMock.mockResolvedValue({ id: 'session-deleted', status: 'deleted' });
    act(() => {
      splitGroupStore.addSession('session-deleted', 'session-a', 'right');
    });

    renderSplitGroup('session-a');

    await waitFor(() => expect(splitGroupStore.getSnapshot().root).toBeNull());
    expect(screen.getByTestId('route-outlet')).toBeTruthy();
  });

  it('权威核验确认远程 session 已归档时清理持久化 pane', async () => {
    useCCSessionsMock.mockReturnValue({
      sessions: [{ id: 'session-a', title: 'Session A', status: 'active' }],
      isLoading: false,
      error: null,
    });
    sessionGetMock.mockResolvedValue({ id: 'remote-session-archived', status: 'archived' });
    act(() => {
      splitGroupStore.addSession('remote-session-archived', 'session-a', 'right');
    });

    renderSplitGroup('session-a');

    await waitFor(() => expect(splitGroupStore.getSnapshot().root).toBeNull());
    expect(sessionGetMock).toHaveBeenCalledWith('remote-session-archived');
    expect(screen.getByTestId('route-outlet')).toBeTruthy();
  });

  it('目录刷新期间会权威核验并保留刚创建的 session pane', async () => {
    useCCSessionsMock.mockReturnValue({
      sessions: [{ id: 'session-a', title: 'Session A', status: 'active' }],
      isLoading: false,
      error: null,
    });
    sessionGetMock.mockResolvedValue({ id: 'session-new', status: 'active' });
    act(() => {
      splitGroupStore.addSession('session-new', 'session-a', 'right');
    });

    renderSplitGroup('session-new');

    await waitFor(() => expect(sessionGetMock).toHaveBeenCalledWith('session-new'));
    expect(splitGroupStore.isActive()).toBe(true);
    expect(screen.getByTestId('session-view-session-new')).toBeTruthy();
  });

  it('权威核验遇到瞬时错误时保留 session pane', async () => {
    useCCSessionsMock.mockReturnValue({
      sessions: [{ id: 'session-a', title: 'Session A', status: 'active' }],
      isLoading: false,
      error: null,
    });
    sessionGetMock.mockRejectedValue(new ApiError('UNKNOWN', 0, 'temporary failure'));
    act(() => {
      splitGroupStore.addSession('session-unavailable', 'session-a', 'right');
    });

    renderSplitGroup('session-a');

    await waitFor(() => expect(sessionGetMock).toHaveBeenCalledWith('session-unavailable'));
    expect(splitGroupStore.isActive()).toBe(true);
    expect(screen.getByTestId('session-view-session-unavailable')).toBeTruthy();
  });

  it('权威核验确认 session 不存在时清理持久化 pane', async () => {
    useCCSessionsMock.mockReturnValue({
      sessions: [{ id: 'session-a', title: 'Session A', status: 'active' }],
      isLoading: false,
      error: null,
    });
    sessionGetMock.mockRejectedValue(new ApiError('NOT_FOUND', 0, 'missing'));
    act(() => {
      splitGroupStore.addSession('session-missing', 'session-a', 'right');
    });

    renderSplitGroup('session-a');

    await waitFor(() => expect(splitGroupStore.getSnapshot().root).toBeNull());
    expect(screen.getByTestId('route-outlet')).toBeTruthy();
  });

  it('当前路由 owner 已失效时先切到存活 pane，并且不会把死 pane 回填', async () => {
    useCCSessionsMock.mockReturnValue({
      sessions: [
        { id: 'session-b', title: 'Session B', status: 'active' },
        { id: 'session-c', title: 'Session C', status: 'active' },
      ],
      isLoading: false,
      error: null,
    });
    sessionGetMock.mockResolvedValue({ id: 'session-a', status: 'deleted' });
    act(() => {
      splitGroupStore.addSession('session-b', 'session-a', 'right');
      splitGroupStore.addSession('session-c', 'session-b', 'bottom');
    });

    renderSplitGroup('session-a');

    await waitFor(() =>
      expect(navigateMock).toHaveBeenCalledWith('/cc-agent/session-b', { replace: true }),
    );
    expect(getSplitPanes(splitGroupStore.getSnapshot().root).map((pane) => pane.sessionId)).toEqual(
      ['session-b', 'session-c'],
    );
    expect(screen.queryByTestId('session-view-session-a')).toBeNull();
    expect(sessionGetMock).toHaveBeenCalledTimes(1);
  });

  it('失效 owner 的恢复路由晚到时不会覆盖用户刚切换的 pane', async () => {
    useCCSessionsMock.mockReturnValue({
      sessions: [
        { id: 'session-b', title: 'Session B', status: 'active' },
        { id: 'session-c', title: 'Session C', status: 'active' },
      ],
      isLoading: false,
      error: null,
    });
    sessionGetMock.mockResolvedValue({ id: 'session-a', status: 'deleted' });
    let resolveStaleOwnerRoute: ((route: string) => void) | undefined;
    resolveSessionRouteMock.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolveStaleOwnerRoute = resolve;
        }),
    );
    act(() => {
      splitGroupStore.addSession('session-b', 'session-a', 'right');
      splitGroupStore.addSession('session-c', 'session-b', 'bottom');
    });
    const view = renderSplitGroup('session-a');

    await waitFor(() =>
      expect(resolveSessionRouteMock).toHaveBeenCalledWith(
        'session-b',
        expect.objectContaining({ id: 'session-b' }),
      ),
    );
    view.rerender(
      <MemoryRouter>
        <SplitGroup activeSessionId="session-c">
          <div data-testid="route-outlet" />
        </SplitGroup>
      </MemoryRouter>,
    );
    await act(async () => {
      resolveStaleOwnerRoute?.('/cc-agent/session-b');
      await Promise.resolve();
    });

    expect(navigateMock).not.toHaveBeenCalledWith('/cc-agent/session-b', { replace: true });
  });

  it('清理失效 owner 后仍会完成延迟返回的存活 pane 路由恢复', async () => {
    useCCSessionsMock.mockReturnValue({
      sessions: [
        { id: 'session-b', title: 'Session B', status: 'active' },
        { id: 'session-c', title: 'Session C', status: 'active' },
      ],
      isLoading: false,
      error: null,
    });
    sessionGetMock.mockResolvedValue({ id: 'session-a', status: 'deleted' });
    let resolveStaleOwnerRoute: ((route: string) => void) | undefined;
    resolveSessionRouteMock.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolveStaleOwnerRoute = resolve;
        }),
    );
    act(() => {
      splitGroupStore.addSession('session-b', 'session-a', 'right');
      splitGroupStore.addSession('session-c', 'session-b', 'bottom');
    });
    renderSplitGroup('session-a');

    await waitFor(() =>
      expect(
        getSplitPanes(splitGroupStore.getSnapshot().root).map((pane) => pane.sessionId),
      ).toEqual(['session-b', 'session-c']),
    );
    await act(async () => {
      resolveStaleOwnerRoute?.('/cc-agent/session-b');
      await Promise.resolve();
    });

    expect(navigateMock).toHaveBeenCalledWith('/cc-agent/session-b', { replace: true });
  });

  it('两窗格因清理失效 owner 折叠后仍会完成延迟路由恢复', async () => {
    useCCSessionsMock.mockReturnValue({
      sessions: [{ id: 'session-b', title: 'Session B', status: 'active' }],
      isLoading: false,
      error: null,
    });
    sessionGetMock.mockResolvedValue({ id: 'session-a', status: 'deleted' });
    let resolveStaleOwnerRoute: ((route: string) => void) | undefined;
    resolveSessionRouteMock.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolveStaleOwnerRoute = resolve;
        }),
    );
    act(() => {
      splitGroupStore.addSession('session-b', 'session-a', 'right');
    });
    renderSplitGroup('session-a');

    await waitFor(() => expect(splitGroupStore.getSnapshot().root).toBeNull());
    await act(async () => {
      resolveStaleOwnerRoute?.('/cc-agent/session-b');
      await Promise.resolve();
    });

    expect(navigateMock).toHaveBeenCalledWith('/cc-agent/session-b', { replace: true });
  });

  it('活动 pane 接管路由主权，切换活动任务不会重建 pane 视图', () => {
    splitGroupStore.addSession('session-b', 'session-a', 'right');
    const view = renderSplitGroup('session-a');

    const sessionAView = screen.getByTestId('session-view-session-a');
    const sessionBView = screen.getByTestId('session-view-session-b');
    expect(sessionAView.dataset.routeOwner).toBe('true');
    expect(sessionBView.dataset.routeOwner).toBe('false');
    expect(sessionAView.dataset.disableAutofocus).toBe('false');
    expect(sessionBView.dataset.disableAutofocus).toBe('true');
    expect(sessionAView.dataset.sidebarTargetSessionId).toBe('session-a');
    expect(sessionBView.dataset.sidebarTargetSessionId).toBe('session-b');

    view.rerender(
      <MemoryRouter>
        <SplitGroup activeSessionId="session-b">
          <div data-testid="route-outlet" />
        </SplitGroup>
      </MemoryRouter>,
    );

    expect(screen.getByTestId('session-view-session-a')).toBe(sessionAView);
    expect(screen.getByTestId('session-view-session-b')).toBe(sessionBView);
    expect(sessionAView.dataset.routeOwner).toBe('false');
    expect(sessionBView.dataset.routeOwner).toBe('true');
    expect(sessionAView.dataset.sidebarTargetSessionId).toBe('session-a');
    expect(sessionBView.dataset.sidebarTargetSessionId).toBe('session-b');
  });

  it('在父级 layout 阶段运行前同步新路由任务到 pane 树', () => {
    act(() => {
      splitGroupStore.addSession('session-b', 'session-a', 'right');
    });
    const originalOwnerPane = getSplitPanes(splitGroupStore.getSnapshot().root).find(
      (pane) => pane.sessionId === 'session-a',
    );
    const layoutSnapshots: Array<Array<{ key: string; sessionId: string }>> = [];

    function LayoutProbe({ activeSessionId }: { activeSessionId: string }) {
      useLayoutEffect(() => {
        layoutSnapshots.push(
          getSplitPanes(splitGroupStore.getSnapshot().root).map(({ key, sessionId }) => ({
            key,
            sessionId,
          })),
        );
      }, [activeSessionId]);
      return (
        <SplitGroup activeSessionId={activeSessionId}>
          <div data-testid="route-outlet" />
        </SplitGroup>
      );
    }

    const view = render(
      <MemoryRouter>
        <LayoutProbe activeSessionId="session-a" />
      </MemoryRouter>,
    );
    layoutSnapshots.length = 0;

    view.rerender(
      <MemoryRouter>
        <LayoutProbe activeSessionId="session-c" />
      </MemoryRouter>,
    );

    expect(layoutSnapshots).toHaveLength(1);
    expect(layoutSnapshots[0]?.map((pane) => pane.sessionId)).toEqual(['session-c', 'session-b']);
    expect(layoutSnapshots[0]?.find((pane) => pane.sessionId === 'session-c')?.key).toBe(
      originalOwnerPane?.key,
    );
  });

  it('从非首个 owner 进入新建页再创建任务时保留原 owner pane', () => {
    act(() => {
      splitGroupStore.addSession('session-b', 'session-a', 'right');
    });
    const view = renderSplitGroup('session-b');

    // `/cc-agent/new` 没有 activeSessionId，SplitGroupActive 会暂时卸载，但外层
    // layout 仍在；新任务创建后路由会直接变成 session-c。
    act(() => {
      view.rerender(
        <MemoryRouter>
          <SplitGroup>
            <div data-testid="route-outlet" />
          </SplitGroup>
        </MemoryRouter>,
      );
    });

    act(() => {
      view.rerender(
        <MemoryRouter>
          <SplitGroup activeSessionId="session-c">
            <div data-testid="route-outlet" />
          </SplitGroup>
        </MemoryRouter>,
      );
    });

    expect(getSplitPanes(splitGroupStore.getSnapshot().root).map((pane) => pane.sessionId)).toEqual(
      ['session-a', 'session-c'],
    );
    expect(screen.getByTestId('session-view-session-c').dataset.routeOwner).toBe('true');
  });

  it('键盘焦点进入非活动 pane 时切换该 pane 的路由主权', async () => {
    act(() => {
      splitGroupStore.addSession('session-b', 'session-a', 'right');
    });
    renderSplitGroup('session-a');
    const sessionAView = screen.getByTestId('session-view-session-a');
    const sessionBView = screen.getByTestId('session-view-session-b');

    await act(async () => {
      fireEvent.focus(sessionBView, { relatedTarget: sessionAView });
      await Promise.resolve();
    });

    expect(resolveSessionRouteMock).toHaveBeenCalledTimes(1);
    expect(resolveSessionRouteMock).toHaveBeenCalledWith('session-b', null);
  });

  it('键盘焦点进入非活动 pane 的关闭按钮时不切换路由主权', () => {
    act(() => {
      splitGroupStore.addSession('session-b', 'session-a', 'right');
    });
    const view = renderSplitGroup('session-a');
    const sessionAView = screen.getByTestId('session-view-session-a');
    const sessionBView = screen.getByTestId('session-view-session-b');
    const closeButton = sessionBView
      .closest('[data-split-pane-key]')
      ?.querySelector<HTMLButtonElement>('[data-split-pane-no-focus]');
    expect(closeButton).toBeTruthy();

    act(() => {
      fireEvent.focus(closeButton as HTMLButtonElement, { relatedTarget: sessionAView });
    });

    expect(resolveSessionRouteMock).not.toHaveBeenCalled();

    act(() => {
      fireEvent.click(closeButton as HTMLButtonElement);
    });

    expect(view.container.querySelectorAll('[data-split-pane-key]')).toHaveLength(0);
    expect(screen.getByTestId('route-outlet')).toBeTruthy();
    expect(resolveSessionRouteMock).not.toHaveBeenCalled();
  });

  it('键盘焦点从 pane 内豁免控件移到普通控件时切换路由主权', async () => {
    act(() => {
      splitGroupStore.addSession('session-b', 'session-a', 'right');
    });
    renderSplitGroup('session-a');
    const sessionAView = screen.getByTestId('session-view-session-a');
    const routeAction = screen.getByTestId('route-action-session-b');
    const composerAction = screen.getByTestId('composer-action-session-b');

    act(() => {
      fireEvent.focus(routeAction, { relatedTarget: sessionAView });
    });
    expect(resolveSessionRouteMock).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.focus(composerAction, { relatedTarget: routeAction });
      await Promise.resolve();
    });

    expect(resolveSessionRouteMock).toHaveBeenCalledTimes(1);
    expect(resolveSessionRouteMock).toHaveBeenCalledWith('session-b', null);
  });

  it('pane 内显式子路由操作直接接管目标路由，不额外切换来源 pane', () => {
    act(() => {
      splitGroupStore.addSession('session-b', 'session-a', 'right');
    });
    renderSplitGroup('session-a');
    const sessionAView = screen.getByTestId('session-view-session-a');
    const routeAction = screen.getByTestId('route-action-session-b');

    act(() => {
      fireEvent.focus(routeAction, { relatedTarget: sessionAView });
      fireEvent.pointerDown(routeAction, { button: 0 });
      fireEvent.click(routeAction);
    });

    expect(routeActionMock).toHaveBeenCalledTimes(1);
    expect(resolveSessionRouteMock).not.toHaveBeenCalled();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('新的 pane 路由主权会取消仍在解析的旧焦点请求', async () => {
    let resolveStaleRoute: ((route: string) => void) | undefined;
    resolveSessionRouteMock.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolveStaleRoute = resolve;
        }),
    );
    act(() => {
      splitGroupStore.addSession('session-b', 'session-a', 'right');
      splitGroupStore.addSession('session-c', 'session-b', 'bottom');
    });
    const view = renderSplitGroup('session-a');

    act(() => {
      fireEvent.pointerDown(screen.getByTestId('composer-action-session-b'), { button: 0 });
    });
    view.rerender(
      <MemoryRouter>
        <SplitGroup activeSessionId="session-c">
          <div data-testid="route-outlet" />
        </SplitGroup>
      </MemoryRouter>,
    );

    await act(async () => {
      resolveStaleRoute?.('/cc-agent/session-b');
      await Promise.resolve();
    });

    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('较早的路由提交不会取消更晚的 pane 聚焦请求', async () => {
    let resolveLatestRoute: ((route: string) => void) | undefined;
    resolveSessionRouteMock.mockResolvedValueOnce('/cc-agent/session-b').mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolveLatestRoute = resolve;
        }),
    );
    act(() => {
      splitGroupStore.addSession('session-b', 'session-a', 'right');
      splitGroupStore.addSession('session-c', 'session-b', 'bottom');
    });
    const view = renderSplitGroup('session-a');

    await act(async () => {
      fireEvent.pointerDown(screen.getByTestId('composer-action-session-b'), { button: 0 });
      await Promise.resolve();
    });
    expect(navigateMock).toHaveBeenCalledWith('/cc-agent/session-b');

    act(() => {
      fireEvent.pointerDown(screen.getByTestId('composer-action-session-c'), { button: 0 });
      view.rerender(
        <MemoryRouter>
          <SplitGroup activeSessionId="session-b">
            <div data-testid="route-outlet" />
          </SplitGroup>
        </MemoryRouter>,
      );
    });
    await act(async () => {
      resolveLatestRoute?.('/cc-agent/session-c');
      await Promise.resolve();
    });

    expect(navigateMock).toHaveBeenLastCalledWith('/cc-agent/session-c');
  });

  it('分屏卸载后会取消仍在解析的 pane 焦点请求', async () => {
    let resolveStaleRoute: ((route: string) => void) | undefined;
    resolveSessionRouteMock.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolveStaleRoute = resolve;
        }),
    );
    act(() => {
      splitGroupStore.addSession('session-b', 'session-a', 'right');
    });
    const view = renderSplitGroup('session-a');

    act(() => {
      fireEvent.pointerDown(screen.getByTestId('composer-action-session-b'), { button: 0 });
    });
    view.unmount();

    await act(async () => {
      resolveStaleRoute?.('/cc-agent/session-b');
      await Promise.resolve();
    });

    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('关闭 pane 时会取消该 pane 仍在解析的焦点请求', async () => {
    let resolveClosedPaneRoute: ((route: string) => void) | undefined;
    resolveSessionRouteMock.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolveClosedPaneRoute = resolve;
        }),
    );
    act(() => {
      splitGroupStore.addSession('session-b', 'session-a', 'right');
      splitGroupStore.addSession('session-c', 'session-b', 'bottom');
    });
    const view = renderSplitGroup('session-a');

    act(() => {
      fireEvent.pointerDown(screen.getByTestId('composer-action-session-b'), { button: 0 });
    });
    const sessionBPane = view.container.querySelector('[data-split-pane-session-id="session-b"]');
    const closeButton = sessionBPane?.querySelector('button[aria-label="splitGroup.closeAria"]');
    if (!(closeButton instanceof HTMLElement)) throw new Error('session-b close button missing');

    act(() => {
      fireEvent.click(closeButton);
    });

    expect(screen.queryByTestId('session-view-session-b')).toBeNull();
    expect(screen.getByTestId('session-view-session-a')).toBeTruthy();
    expect(screen.getByTestId('session-view-session-c')).toBeTruthy();

    await act(async () => {
      resolveClosedPaneRoute?.('/cc-agent/session-b');
      await Promise.resolve();
    });

    expect(navigateMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId('session-view-session-b')).toBeNull();
  });

  it('关闭 route owner 时等待目标 pane 接管路由后再删除原 pane', async () => {
    let resolveTargetRoute: ((route: string) => void) | undefined;
    resolveSessionRouteMock.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolveTargetRoute = resolve;
        }),
    );
    act(() => {
      splitGroupStore.addSession('session-b', 'session-a', 'right');
      splitGroupStore.addSession('session-c', 'session-b', 'bottom');
    });
    const originalPanes = getSplitPanes(splitGroupStore.getSnapshot().root);
    const originalKeys = new Map(originalPanes.map((pane) => [pane.sessionId, pane.key]));
    const view = renderSplitGroup('session-a');
    const sessionAPane = view.container.querySelector('[data-split-pane-session-id="session-a"]');
    const closeButton = sessionAPane?.querySelector('button[aria-label="splitGroup.closeAria"]');
    if (!(closeButton instanceof HTMLElement)) throw new Error('session-a close button missing');

    act(() => {
      fireEvent.click(closeButton);
    });

    expect(getSplitPanes(splitGroupStore.getSnapshot().root).map((pane) => pane.sessionId)).toEqual(
      ['session-a', 'session-b', 'session-c'],
    );
    expect(screen.getByTestId('session-view-session-a')).toBeTruthy();

    await act(async () => {
      resolveTargetRoute?.('/cc-agent/session-b');
      await Promise.resolve();
    });

    expect(navigateMock).toHaveBeenCalledWith('/cc-agent/session-b');
    expect(getSplitPanes(splitGroupStore.getSnapshot().root).map((pane) => pane.sessionId)).toEqual(
      ['session-a', 'session-b', 'session-c'],
    );

    act(() => {
      view.rerender(
        <MemoryRouter>
          <SplitGroup activeSessionId="session-b">
            <div data-testid="route-outlet" />
          </SplitGroup>
        </MemoryRouter>,
      );
    });

    const remainingPanes = getSplitPanes(splitGroupStore.getSnapshot().root);
    expect(remainingPanes.map((pane) => pane.sessionId)).toEqual(['session-b', 'session-c']);
    expect(remainingPanes.find((pane) => pane.sessionId === 'session-b')?.key).toBe(
      originalKeys.get('session-b'),
    );
    expect(remainingPanes.find((pane) => pane.sessionId === 'session-c')?.key).toBe(
      originalKeys.get('session-c'),
    );
  });

  it('目标导航已发出后再关闭 owner，仍会在目标提交时完成关闭', async () => {
    act(() => {
      splitGroupStore.addSession('session-b', 'session-a', 'right');
      splitGroupStore.addSession('session-c', 'session-b', 'bottom');
    });
    const view = renderSplitGroup('session-a');

    await act(async () => {
      fireEvent.pointerDown(screen.getByTestId('composer-action-session-b'), { button: 0 });
      await Promise.resolve();
    });
    expect(navigateMock).toHaveBeenCalledWith('/cc-agent/session-b');

    const sessionAPane = view.container.querySelector('[data-split-pane-session-id="session-a"]');
    const closeButton = sessionAPane?.querySelector('button[aria-label="splitGroup.closeAria"]');
    if (!(closeButton instanceof HTMLElement)) throw new Error('session-a close button missing');
    act(() => {
      fireEvent.click(closeButton);
      view.rerender(
        <MemoryRouter>
          <SplitGroup activeSessionId="session-b">
            <div data-testid="route-outlet" />
          </SplitGroup>
        </MemoryRouter>,
      );
    });

    expect(getSplitPanes(splitGroupStore.getSnapshot().root).map((pane) => pane.sessionId)).toEqual(
      ['session-b', 'session-c'],
    );
  });

  it('关闭 route owner 的目标路由解析失败时保留原布局并允许重试', async () => {
    resolveSessionRouteMock.mockRejectedValueOnce(new Error('route unavailable'));
    act(() => {
      splitGroupStore.addSession('session-b', 'session-a', 'right');
      splitGroupStore.addSession('session-c', 'session-b', 'bottom');
    });
    const view = renderSplitGroup('session-a');
    const sessionAPane = view.container.querySelector('[data-split-pane-session-id="session-a"]');
    const closeButton = sessionAPane?.querySelector('button[aria-label="splitGroup.closeAria"]');
    if (!(closeButton instanceof HTMLElement)) throw new Error('session-a close button missing');

    await act(async () => {
      fireEvent.click(closeButton);
      await Promise.resolve();
    });

    expect(navigateMock).not.toHaveBeenCalled();
    expect(getSplitPanes(splitGroupStore.getSnapshot().root).map((pane) => pane.sessionId)).toEqual(
      ['session-a', 'session-b', 'session-c'],
    );

    await act(async () => {
      fireEvent.click(closeButton);
      await Promise.resolve();
    });

    expect(resolveSessionRouteMock).toHaveBeenCalledTimes(2);
    expect(navigateMock).toHaveBeenCalledWith('/cc-agent/session-b');
    act(() => {
      view.rerender(
        <MemoryRouter>
          <SplitGroup activeSessionId="session-b">
            <div data-testid="route-outlet" />
          </SplitGroup>
        </MemoryRouter>,
      );
    });
    expect(getSplitPanes(splitGroupStore.getSnapshot().root).map((pane) => pane.sessionId)).toEqual(
      ['session-b', 'session-c'],
    );
  });

  it('关闭 route owner 的焦点请求被后续请求取代时不会遗留陈旧关闭事务', async () => {
    let resolveOwnerCloseRoute: ((route: string) => void) | undefined;
    resolveSessionRouteMock
      .mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            resolveOwnerCloseRoute = resolve;
          }),
      )
      .mockRejectedValueOnce(new Error('new focus failed'));
    act(() => {
      splitGroupStore.addSession('session-b', 'session-a', 'right');
      splitGroupStore.addSession('session-c', 'session-b', 'bottom');
    });
    const view = renderSplitGroup('session-a');
    const sessionAPane = view.container.querySelector('[data-split-pane-session-id="session-a"]');
    const closeButton = sessionAPane?.querySelector('button[aria-label="splitGroup.closeAria"]');
    if (!(closeButton instanceof HTMLElement)) throw new Error('session-a close button missing');

    act(() => {
      fireEvent.click(closeButton);
    });
    await act(async () => {
      fireEvent.pointerDown(screen.getByTestId('composer-action-session-c'), { button: 0 });
      await Promise.resolve();
      resolveOwnerCloseRoute?.('/cc-agent/session-b');
      await Promise.resolve();
    });

    expect(navigateMock).not.toHaveBeenCalled();
    act(() => {
      view.rerender(
        <MemoryRouter>
          <SplitGroup activeSessionId="session-c">
            <div data-testid="route-outlet" />
          </SplitGroup>
        </MemoryRouter>,
      );
    });
    expect(getSplitPanes(splitGroupStore.getSnapshot().root).map((pane) => pane.sessionId)).toEqual(
      ['session-a', 'session-b', 'session-c'],
    );
  });

  it('关闭到 Orca Worker pane 时等待 canonical Lead 接管后再删除 owner', async () => {
    resolveSessionRouteMock.mockResolvedValueOnce('/cc-agent/lead-b?worker=worker-b');
    act(() => {
      splitGroupStore.addSession('worker-b', 'session-a', 'right');
      splitGroupStore.addSession('session-c', 'worker-b', 'bottom');
    });
    const workerPaneKey = getSplitPanes(splitGroupStore.getSnapshot().root).find(
      (pane) => pane.sessionId === 'worker-b',
    )?.key;
    const view = renderSplitGroup('session-a');
    const sessionAPane = view.container.querySelector('[data-split-pane-session-id="session-a"]');
    const closeButton = sessionAPane?.querySelector('button[aria-label="splitGroup.closeAria"]');
    if (!(closeButton instanceof HTMLElement)) throw new Error('session-a close button missing');

    await act(async () => {
      fireEvent.click(closeButton);
      await Promise.resolve();
    });
    act(() => {
      view.rerender(
        <MemoryRouter>
          <SplitGroup activeSessionId="lead-b">
            <div data-testid="route-outlet" />
          </SplitGroup>
        </MemoryRouter>,
      );
    });

    const remainingPanes = getSplitPanes(splitGroupStore.getSnapshot().root);
    expect(remainingPanes.map((pane) => pane.sessionId)).toEqual(['lead-b', 'session-c']);
    expect(remainingPanes.find((pane) => pane.sessionId === 'lead-b')?.key).toBe(workerPaneKey);
  });

  it('关闭 route owner 期间目标 pane 被移除会取消旧导航并保留 owner', async () => {
    let resolveRemovedTargetRoute: ((route: string) => void) | undefined;
    resolveSessionRouteMock.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolveRemovedTargetRoute = resolve;
        }),
    );
    act(() => {
      splitGroupStore.addSession('session-b', 'session-a', 'right');
      splitGroupStore.addSession('session-c', 'session-b', 'bottom');
    });
    const view = renderSplitGroup('session-a');
    const sessionAPane = view.container.querySelector('[data-split-pane-session-id="session-a"]');
    const closeButton = sessionAPane?.querySelector('button[aria-label="splitGroup.closeAria"]');
    if (!(closeButton instanceof HTMLElement)) throw new Error('session-a close button missing');

    act(() => {
      fireEvent.click(closeButton);
      splitGroupStore.removeSession('session-b');
    });
    await act(async () => {
      resolveRemovedTargetRoute?.('/cc-agent/session-b');
      await Promise.resolve();
    });

    expect(navigateMock).not.toHaveBeenCalled();
    expect(getSplitPanes(splitGroupStore.getSnapshot().root).map((pane) => pane.sessionId)).toEqual(
      ['session-a', 'session-c'],
    );
  });

  it('两个 pane 时先完成 owner 路由切换再退出分屏', async () => {
    let resolveTargetRoute: ((route: string) => void) | undefined;
    resolveSessionRouteMock.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolveTargetRoute = resolve;
        }),
    );
    act(() => {
      splitGroupStore.addSession('session-b', 'session-a', 'right');
    });
    const view = renderSplitGroup('session-a');
    const sessionAPane = view.container.querySelector('[data-split-pane-session-id="session-a"]');
    const closeButton = sessionAPane?.querySelector('button[aria-label="splitGroup.closeAria"]');
    if (!(closeButton instanceof HTMLElement)) throw new Error('session-a close button missing');

    act(() => {
      fireEvent.click(closeButton);
    });

    expect(splitGroupStore.isActive()).toBe(true);
    expect(navigateMock).not.toHaveBeenCalled();

    await act(async () => {
      resolveTargetRoute?.('/cc-agent/session-b');
      await Promise.resolve();
    });

    expect(splitGroupStore.isActive()).toBe(true);
    expect(navigateMock).toHaveBeenCalledWith('/cc-agent/session-b');

    act(() => {
      view.rerender(
        <MemoryRouter>
          <SplitGroup activeSessionId="session-b">
            <div data-testid="route-outlet" />
          </SplitGroup>
        </MemoryRouter>,
      );
    });

    expect(splitGroupStore.isActive()).toBe(false);
    expect(screen.getByTestId('route-outlet')).toBeTruthy();
  });

  it('pane 内普通 composer 按钮会先切换 pane 主权', async () => {
    act(() => {
      splitGroupStore.addSession('session-b', 'session-a', 'right');
    });
    renderSplitGroup('session-a');

    await act(async () => {
      fireEvent.pointerDown(screen.getByTestId('composer-action-session-b'), { button: 0 });
      await Promise.resolve();
    });

    expect(resolveSessionRouteMock).toHaveBeenCalledWith('session-b', null);
  });

  it('非 owner pane 的右键上下文操作会先启动 pane 主权切换', async () => {
    act(() => {
      splitGroupStore.addSession('session-b', 'session-a', 'right');
    });
    renderSplitGroup('session-a');

    await act(async () => {
      fireEvent.pointerDown(screen.getByTestId('composer-action-session-b'), { button: 2 });
      fireEvent.contextMenu(screen.getByTestId('composer-action-session-b'));
      await Promise.resolve();
    });

    expect(resolveSessionRouteMock).toHaveBeenCalledWith('session-b', null);
    expect(resolveSessionRouteMock.mock.invocationCallOrder[0]).toBeLessThan(
      routeActionMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it('中键与 no-focus 控件的右键不会切换 pane 主权', () => {
    act(() => {
      splitGroupStore.addSession('session-b', 'session-a', 'right');
    });
    const view = renderSplitGroup('session-a');
    const sessionBPane = view.container.querySelector('[data-split-pane-session-id="session-b"]');
    const closeButton = sessionBPane?.querySelector('button[aria-label="splitGroup.closeAria"]');
    if (!(closeButton instanceof HTMLElement)) throw new Error('session-b close button missing');

    act(() => {
      fireEvent.pointerDown(screen.getByTestId('composer-action-session-b'), { button: 1 });
      fireEvent.pointerDown(closeButton, { button: 2 });
    });

    expect(resolveSessionRouteMock).not.toHaveBeenCalled();
  });

  it('非 owner pane 发起子路由跳转时替换发起跳转的 pane', () => {
    act(() => {
      splitGroupStore.addSession('session-b', 'session-a', 'right');
    });
    const view = renderSplitGroup('session-a');

    act(() => {
      fireEvent.click(screen.getByTestId('route-action-session-b'));
    });

    view.rerender(
      <MemoryRouter>
        <SplitGroup activeSessionId="session-c">
          <div data-testid="route-outlet" />
        </SplitGroup>
      </MemoryRouter>,
    );

    expect(screen.getByTestId('session-view-session-a')).toBeTruthy();
    expect(screen.queryByTestId('session-view-session-b')).toBeNull();
    expect(screen.getByTestId('session-view-session-c').dataset.routeOwner).toBe('true');
    expect(resolveSessionRouteMock).not.toHaveBeenCalled();
  });

  it('Orca worker 深链规范化到 Lead 路由时仍替换来源 pane', () => {
    act(() => {
      splitGroupStore.addSession('session-b', 'session-a', 'right');
    });
    const view = renderSplitGroup('session-a');

    act(() => {
      fireEvent.click(screen.getByTestId('worker-route-action-session-b'));
    });

    view.rerender(
      <MemoryRouter>
        <SplitGroup activeSessionId="lead-c">
          <div data-testid="route-outlet" />
        </SplitGroup>
      </MemoryRouter>,
    );

    expect(screen.getByTestId('session-view-session-a')).toBeTruthy();
    expect(screen.queryByTestId('session-view-session-b')).toBeNull();
    expect(screen.getByTestId('session-view-lead-c').dataset.routeOwner).toBe('true');
  });

  it('来源 pane 已关闭时忽略延迟完成的子路由替换意图', () => {
    act(() => {
      splitGroupStore.addSession('session-b', 'session-a', 'right');
      splitGroupStore.addSession('session-c', 'session-b', 'bottom');
    });
    const view = renderSplitGroup('session-a');

    act(() => {
      fireEvent.click(screen.getByTestId('deferred-route-action-session-b'));
    });
    const reportNavigation = deferredRouteActionMock.mock.calls[0]?.[0] as
      ((targetSessionId: string, routeOwnerSessionId?: string) => void) | undefined;
    const sessionBPane = view.container.querySelector('[data-split-pane-session-id="session-b"]');
    const closeButton = sessionBPane?.querySelector('button[aria-label="splitGroup.closeAria"]');
    if (!(closeButton instanceof HTMLElement)) throw new Error('session-b close button missing');

    act(() => {
      fireEvent.click(closeButton);
      reportNavigation?.('session-d', 'session-d');
    });
    view.rerender(
      <MemoryRouter>
        <SplitGroup activeSessionId="session-d">
          <div data-testid="route-outlet" />
        </SplitGroup>
      </MemoryRouter>,
    );

    expect(getSplitPanes(splitGroupStore.getSnapshot().root).map((pane) => pane.sessionId)).toEqual(
      ['session-a', 'session-c'],
    );
  });

  it('递归渲染左一右二与左二右二混合布局', () => {
    act(() => {
      splitGroupStore.addSession('session-b', 'session-a', 'right');
      splitGroupStore.addSession('session-c', 'session-b', 'bottom');
    });
    const view = renderSplitGroup('session-a');

    const root = view.container.querySelector('[data-split-root-direction="row"]');
    expect(root).toBeTruthy();
    expect(view.container.querySelectorAll('[data-split-direction="column"]')).toHaveLength(1);
    expect(view.container.querySelectorAll('[data-split-pane-key]')).toHaveLength(3);

    act(() => {
      splitGroupStore.addSession('session-d', 'session-a', 'bottom');
    });

    expect(view.container.querySelectorAll('[data-split-direction="column"]')).toHaveLength(2);
    expect(view.container.querySelectorAll('[data-split-pane-key]')).toHaveLength(4);
  });

  it('关闭分支后提升 sibling 时保留其它 pane 的已挂载视图', () => {
    act(() => {
      splitGroupStore.addSession('session-b', 'session-a', 'right');
      splitGroupStore.addSession('session-c', 'session-b', 'bottom');
    });
    const view = renderSplitGroup('session-b');
    const sessionBView = screen.getByTestId('session-view-session-b');
    const sessionCView = screen.getByTestId('session-view-session-c');
    const sessionAPane = view.container.querySelector('[data-split-pane-session-id="session-a"]');
    const closeButton = sessionAPane?.querySelector('button[aria-label="splitGroup.closeAria"]');
    if (!(closeButton instanceof HTMLElement)) throw new Error('session-a close button missing');

    act(() => {
      fireEvent.click(closeButton);
    });

    expect(screen.getByTestId('session-view-session-b')).toBe(sessionBView);
    expect(screen.getByTestId('session-view-session-c')).toBe(sessionCView);
  });

  it('分割线可聚焦，方向键与 Home/End 调整比例并同步 ARIA 值', () => {
    act(() => {
      splitGroupStore.addSession('session-b', 'session-a', 'right');
    });
    const view = renderSplitGroup('session-a');
    const separator = view.container.querySelector('[role="separator"]') as HTMLElement;

    expect(separator).toBeTruthy();
    expect(separator.getAttribute('tabindex')).toBe('0');
    expect(separator.getAttribute('aria-valuemin')).toBe('10');
    expect(separator.getAttribute('aria-valuemax')).toBe('90');
    expect(separator.getAttribute('aria-valuenow')).toBe('50');

    act(() => {
      fireEvent.keyDown(separator, { key: 'ArrowRight' });
    });
    let root = splitGroupStore.getSnapshot().root;
    if (root?.type !== 'split') throw new Error('root split missing');
    expect(root.fraction).toBeCloseTo(0.55, 5);
    expect(separator.getAttribute('aria-valuenow')).toBe('55');

    act(() => {
      // 行方向分割线忽略纵向按键，比例保持不变。
      fireEvent.keyDown(separator, { key: 'ArrowUp' });
    });
    root = splitGroupStore.getSnapshot().root;
    if (root?.type !== 'split') throw new Error('root split missing');
    expect(root.fraction).toBeCloseTo(0.55, 5);

    act(() => {
      fireEvent.keyDown(separator, { key: 'Home' });
    });
    root = splitGroupStore.getSnapshot().root;
    if (root?.type !== 'split') throw new Error('root split missing');
    expect(root.fraction).toBeCloseTo(0.1, 5);

    act(() => {
      fireEvent.keyDown(separator, { key: 'End' });
    });
    root = splitGroupStore.getSnapshot().root;
    if (root?.type !== 'split') throw new Error('root split missing');
    expect(root.fraction).toBeCloseTo(0.9, 5);
  });

  it('窗口失焦时结束分割线拖动并清理全局 resize 状态', () => {
    act(() => {
      splitGroupStore.addSession('session-b', 'session-a', 'right');
    });
    const view = renderSplitGroup('session-a');
    const separator = view.container.querySelector('[role="separator"]') as HTMLElement;
    const branch = separator.closest('[data-split-branch]') as HTMLElement;
    vi.spyOn(branch, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      right: 1006,
      top: 0,
      bottom: 500,
      width: 1006,
      height: 500,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    const setFractionSpy = vi.spyOn(splitGroupStore, 'setSplitFraction');

    act(() => {
      fireEvent.pointerDown(separator, { button: 0, clientX: 500 });
      fireEvent.pointerMove(document, { clientX: 600 });
    });
    expect(document.body.classList.contains('resizing-pane')).toBe(true);

    act(() => {
      fireEvent.blur(window);
    });

    expect(document.body.classList.contains('resizing-pane')).toBe(false);
    expect(setFractionSpy).toHaveBeenCalledTimes(1);
    expect(setFractionSpy.mock.calls[0]?.[1]).toBeCloseTo(0.6, 5);

    act(() => {
      fireEvent.blur(window);
      fireEvent.pointerMove(document, { clientX: 800 });
    });
    expect(setFractionSpy).toHaveBeenCalledTimes(1);
  });

  it('拖动分割线时不重渲染重型 session 视图', () => {
    act(() => {
      splitGroupStore.addSession('session-b', 'session-a', 'right');
    });
    const view = renderSplitGroup('session-a');
    const separator = view.container.querySelector('[role="separator"]') as HTMLElement;
    const branch = separator.closest('[data-split-branch]') as HTMLElement;
    vi.spyOn(branch, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      right: 1006,
      top: 0,
      bottom: 500,
      width: 1006,
      height: 500,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    sessionViewRenderMock.mockClear();

    act(() => {
      fireEvent.pointerDown(separator, { button: 0, clientX: 500 });
      fireEvent.pointerMove(document, { clientX: 550 });
      fireEvent.pointerMove(document, { clientX: 600 });
    });

    expect(sessionViewRenderMock).not.toHaveBeenCalled();
    act(() => fireEvent.pointerUp(document));
  });

  it('页面隐藏后连续收到其它终止事件时只提交一次 resize', () => {
    act(() => {
      splitGroupStore.addSession('session-b', 'session-a', 'right');
    });
    const view = renderSplitGroup('session-a');
    const separator = view.container.querySelector('[role="separator"]') as HTMLElement;
    const branch = separator.closest('[data-split-branch]') as HTMLElement;
    vi.spyOn(branch, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      right: 1006,
      top: 0,
      bottom: 500,
      width: 1006,
      height: 500,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    const setFractionSpy = vi.spyOn(splitGroupStore, 'setSplitFraction');
    const visibilitySpy = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');

    act(() => {
      fireEvent.pointerDown(separator, { button: 0, clientX: 500 });
      fireEvent.pointerMove(document, { clientX: 650 });
      fireEvent(document, new Event('visibilitychange'));
      fireEvent.blur(window);
      fireEvent.pointerCancel(document);
      fireEvent.pointerMove(document, { clientX: 800 });
    });

    expect(document.body.classList.contains('resizing-pane')).toBe(false);
    expect(setFractionSpy).toHaveBeenCalledTimes(1);
    expect(setFractionSpy.mock.calls[0]?.[1]).toBeCloseTo(0.65, 5);
    visibilitySpy.mockRestore();
  });

  it('pane 内子组件阻止冒泡时仍能捕获任务拖放', async () => {
    act(() => {
      splitGroupStore.addSession('session-b', 'session-a', 'right');
    });
    const view = renderSplitGroup('session-a');
    const sessionBView = screen.getByTestId('session-view-session-b');
    const dropTarget = sessionBView.closest('[data-split-drop-target="pane"]');
    expect(dropTarget).toBeTruthy();
    vi.spyOn(dropTarget as HTMLElement, 'getBoundingClientRect').mockReturnValue({
      left: 100,
      right: 500,
      top: 50,
      bottom: 350,
      width: 400,
      height: 300,
      x: 100,
      y: 50,
      toJSON: () => ({}),
    });
    const dataTransfer = {
      types: ['application/x-cindy-session-id'],
      dropEffect: 'none',
      getData: (format: string) => (format === 'application/x-cindy-session-id' ? 'session-c' : ''),
    };

    await act(async () => {
      fireEvent.dragOver(sessionBView, { clientX: 300, clientY: 340, dataTransfer });
      fireEvent.drop(sessionBView, { clientX: 300, clientY: 340, dataTransfer });
      await Promise.resolve();
    });

    expect(view.container.querySelectorAll('[data-split-direction="column"]')).toHaveLength(1);
    expect(view.container.querySelectorAll('[data-split-pane-key]')).toHaveLength(3);
  });

  it('任务拖到输入框时不被 pane capture 抢走', async () => {
    act(() => {
      splitGroupStore.addSession('session-b', 'session-a', 'right');
    });
    const view = renderSplitGroup('session-a');
    const composerDropChild = screen.getByTestId('composer-drop-child-session-b');
    const dataTransfer = {
      types: ['application/x-cindy-session-id', 'application/x-cindy-session-link'],
      dropEffect: 'none',
      getData: (format: string) =>
        format === 'application/x-cindy-session-id' ? 'session-c' : 'cindy://session/session-c',
    };

    await act(async () => {
      fireEvent.dragOver(composerDropChild, { clientX: 300, clientY: 340, dataTransfer });
      fireEvent.drop(composerDropChild, { clientX: 300, clientY: 340, dataTransfer });
      await Promise.resolve();
    });

    expect(view.container.querySelectorAll('[data-split-pane-key]')).toHaveLength(2);
    expect(sessionViewRenderMock).not.toHaveBeenCalledWith('session-c');
  });

  it('达到窗格上限时拒绝拖入且不切换路由', async () => {
    act(() => {
      splitGroupStore.addSession('session-b', 'session-a', 'right');
      for (let index = 3; index <= 8; index += 1) {
        splitGroupStore.addSession(`session-${index}`, 'session-b', 'bottom');
      }
    });
    const view = renderSplitGroup('session-a');
    const sessionBView = screen.getByTestId('session-view-session-b');
    const dropTarget = sessionBView.closest('[data-split-drop-target="pane"]');
    expect(dropTarget).toBeTruthy();
    vi.spyOn(dropTarget as HTMLElement, 'getBoundingClientRect').mockReturnValue({
      left: 100,
      right: 500,
      top: 50,
      bottom: 350,
      width: 400,
      height: 300,
      x: 100,
      y: 50,
      toJSON: () => ({}),
    });
    const dataTransfer = {
      types: ['application/x-cindy-session-id'],
      dropEffect: 'none',
      getData: (format: string) =>
        format === 'application/x-cindy-session-id' ? 'session-over-limit' : '',
    };

    await act(async () => {
      fireEvent.dragOver(sessionBView, { clientX: 490, clientY: 200, dataTransfer });
      fireEvent.drop(sessionBView, { clientX: 490, clientY: 200, dataTransfer });
      await Promise.resolve();
    });

    expect(view.container.querySelectorAll('[data-split-pane-key]')).toHaveLength(8);
    expect(resolveSessionRouteMock).not.toHaveBeenCalled();
  });
});
