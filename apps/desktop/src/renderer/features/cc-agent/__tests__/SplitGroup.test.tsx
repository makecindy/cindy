// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { SplitGroup } from '../SplitGroup';
import { splitGroupStore } from '../splitGroupStore';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@/hooks/useCCSessions', () => ({
  useCCSessions: () => ({ sessions: [] }),
}));

vi.mock('@/features/device-link/remoteProjectsStore', () => ({
  useRemoteProjectSessions: () => [],
}));

vi.mock('@/lib/orcaSessionIdentity', () => ({
  resolveSessionRoute: async (sessionId: string) => `/cc-agent/${sessionId}`,
}));

vi.mock('../CCAgentSessionView', () => ({
  CCAgentSessionView: ({
    sessionIdProp,
    routeOwner,
  }: {
    sessionIdProp: string;
    routeOwner: boolean;
  }) => (
    <div
      data-testid={`session-view-${sessionIdProp}`}
      data-session-id={sessionIdProp}
      data-route-owner={routeOwner ? 'true' : 'false'}
      onDragOver={(event) => event.stopPropagation()}
      onDrop={(event) => event.stopPropagation()}
    />
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

  it('活动 pane 接管路由主权，切换活动任务不会重建 pane 视图', () => {
    splitGroupStore.addSession('session-b', 'session-a', 'right');
    const view = renderSplitGroup('session-a');

    const sessionAView = screen.getByTestId('session-view-session-a');
    const sessionBView = screen.getByTestId('session-view-session-b');
    expect(sessionAView.dataset.routeOwner).toBe('true');
    expect(sessionBView.dataset.routeOwner).toBe('false');

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
      getData: (format: string) =>
        format === 'application/x-cindy-session-id' ? 'session-c' : '',
    };

    await act(async () => {
      fireEvent.dragOver(sessionBView, { clientX: 300, clientY: 340, dataTransfer });
      fireEvent.drop(sessionBView, { clientX: 300, clientY: 340, dataTransfer });
      await Promise.resolve();
    });

    expect(view.container.querySelectorAll('[data-split-direction="column"]')).toHaveLength(1);
    expect(view.container.querySelectorAll('[data-split-pane-key]')).toHaveLength(3);
  });
});
