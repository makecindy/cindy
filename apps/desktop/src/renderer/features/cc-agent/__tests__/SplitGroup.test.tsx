// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { SplitGroup } from '../SplitGroup';
import { splitGroupStore } from '../splitGroupStore';

const { navigateMock, resolveSessionRouteMock, routeActionMock, useCCSessionsMock } = vi.hoisted(
  () => ({
    navigateMock: vi.fn(),
    resolveSessionRouteMock: vi.fn(async (sessionId: string) => `/cc-agent/${sessionId}`),
    routeActionMock: vi.fn(),
    useCCSessionsMock: vi.fn(),
  }),
);

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
  resolveSessionRoute: resolveSessionRouteMock,
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
  }) => (
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
      <button type="button" data-testid={`composer-action-${sessionIdProp}`}>
        Composer action
      </button>
    </div>
  ),
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
    navigateMock.mockClear();
    resolveSessionRouteMock.mockClear();
    routeActionMock.mockClear();
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
    act(() => {
      splitGroupStore.addSession('session-deleted', 'session-a', 'right');
    });

    renderSplitGroup('session-a');

    await waitFor(() => expect(splitGroupStore.getSnapshot().root).toBeNull());
    expect(screen.getByTestId('route-outlet')).toBeTruthy();
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
