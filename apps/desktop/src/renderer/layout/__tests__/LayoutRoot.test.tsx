// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDefaultLayout, type Layout } from '../../../shared/layoutTree';
import {
  BuiltinPanelBridgeProvider,
  type BuiltinPanelBridge,
} from '../../panels/BuiltinPanelBridge';
import { __resetBuiltinPanelsForTest } from '../../panels/builtinPanels';
import { __resetPanelRegistryForTest, registerPanelKind } from '../../panels/registry';
import { LayoutRoot, normalizeSubMinFractions } from '../LayoutRoot';
import { usePaneAtWindowTop, usePaneFill } from '../panePlacement';

const ghostPanelSyncMock = vi.hoisted(() => ({ version: 0 }));

vi.mock('../../cindy-brain/ghostPanels', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../cindy-brain/ghostPanels')>();
  return {
    ...actual,
    useGhostPanelsSync: () => ghostPanelSyncMock.version,
  };
});

/** stub electronAPI.layout:同步返回给定树 + 可手动触发 onChanged。 */
let currentLayout: Layout;
let changedListeners: Array<(payload: { layout: Layout }) => void>;
const setLayoutMock = vi.fn<(layout: Layout) => Promise<void>>(async () => undefined);

function stubElectronLayoutApi(): void {
  changedListeners = [];
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    layout: {
      getStateSync: () => ({ layout: currentLayout }),
      onChanged: (cb: (payload: { layout: Layout }) => void) => {
        changedListeners.push(cb);
        return () => {
          changedListeners = changedListeners.filter((l) => l !== cb);
        };
      },
      set: setLayoutMock,
    },
  };
}

function emitLayoutChanged(next: Layout): void {
  currentLayout = next;
  act(() => {
    changedListeners.forEach((cb) => cb({ layout: next }));
  });
}

const bridge: BuiltinPanelBridge = {
  sessionList: <div data-testid="p-sessions" />,
  chatMain: <div data-testid="p-chat" />,
  rightTabs: <div data-testid="p-right" />,
};

function renderLayoutRoot() {
  return render(
    <BuiltinPanelBridgeProvider value={bridge}>
      <div data-testid="row">
        <LayoutRoot />
      </div>
    </BuiltinPanelBridgeProvider>,
  );
}

/** row 容器 direct children 的 testid 顺序 —— 断言"顺序由树驱动"。 */
function rowChildTestIds(): string[] {
  return [...screen.getByTestId('layout-root-content').children].map(
    (el) => el.getAttribute('data-testid') ?? '?',
  );
}

beforeEach(() => {
  ghostPanelSyncMock.version = 0;
  currentLayout = createDefaultLayout();
  setLayoutMock.mockClear();
  stubElectronLayoutApi();
});

afterEach(() => {
  cleanup();
  document.body.classList.remove('resizing-pane');
  vi.useRealTimers();
  __resetPanelRegistryForTest();
  __resetBuiltinPanelsForTest();
});

describe('LayoutRoot · 树驱动的顺序与在场', () => {
  it('用独立 flex-1 内容区承载根 split，让百分比不包含左侧栏宽度', () => {
    renderLayoutRoot();
    const row = screen.getByTestId('row');
    const content = screen.getByTestId('layout-root-content');
    expect([...row.children]).toEqual([content]);
    expect(content.className).toContain('flex-1');
    expect(rowChildTestIds()).toEqual(['p-chat', 'layout-divider', 'p-right']);
  });

  it('默认树:chat 在前、right 在后,相邻可见面板之间有引擎分割线', () => {
    renderLayoutRoot();
    expect(rowChildTestIds()).toEqual(['p-chat', 'layout-divider', 'p-right']);
  });

  it('交换 children 顺序的树:渲染顺序跟随(第 5 步 dev 交换命令的引擎基础)', () => {
    const swapped = createDefaultLayout();
    (swapped.content as { children: unknown[] }).children.reverse();
    currentLayout = swapped;
    renderLayoutRoot();
    expect(rowChildTestIds()).toEqual(['p-right', 'layout-divider', 'p-chat']);
  });

  it('layout:changed 热更新:收到新树后重排,无需重新挂载', () => {
    renderLayoutRoot();
    expect(rowChildTestIds()).toEqual(['p-chat', 'layout-divider', 'p-right']);

    const swapped = createDefaultLayout();
    (swapped.content as { children: unknown[] }).children.reverse();
    emitLayoutChanged(swapped);
    expect(rowChildTestIds()).toEqual(['p-right', 'layout-divider', 'p-chat']);
  });

  it('未注册 panelKind(未安装意识残留)整个 pane 隐藏,不留孤儿分割线', () => {
    const withGhost = createDefaultLayout();
    (
      withGhost.content as { children: { node: { panelKind: string } }[] }
    ).children[1].node.panelKind = 'ghost:not-installed';
    currentLayout = withGhost;
    renderLayoutRoot();
    expect(rowChildTestIds()).toEqual(['p-chat']);
  });

  it('接管态(suppressNonChatPanels):只渲染 chat-main,其余面板与分割线歇业', () => {
    render(
      <BuiltinPanelBridgeProvider value={bridge}>
        <div data-testid="row-suppressed">
          <LayoutRoot suppressNonChatPanels />
        </div>
      </BuiltinPanelBridgeProvider>,
    );
    const ids = [...screen.getByTestId('layout-root-content').children].map(
      (el) => el.getAttribute('data-testid') ?? '?',
    );
    expect(ids).toEqual(['p-chat']);
  });

  it('live resize 停稳后只在 120px clamp 命中时自愈份额账本', async () => {
    vi.useFakeTimers();
    currentLayout = {
      ...createDefaultLayout(),
      content: {
        type: 'split',
        id: 'root',
        direction: 'row',
        children: [
          {
            fraction: 0.9,
            node: { type: 'pane', id: 'chat', panelKind: 'chat-main', minWidth: 400 },
          },
          {
            fraction: 0.1,
            node: { type: 'pane', id: 'right', panelKind: 'right-tabs', minWidth: 120 },
          },
        ],
      },
    };
    renderLayoutRoot();
    const content = screen.getByTestId('layout-root-content');
    content.getBoundingClientRect = () =>
      ({
        width: 800,
        height: 600,
        top: 0,
        right: 800,
        bottom: 600,
        left: 0,
        x: 0,
        y: 0,
        toJSON() {},
      }) as DOMRect;

    await act(async () => {
      vi.advanceTimersByTime(120);
      await Promise.resolve();
    });

    expect(setLayoutMock).toHaveBeenCalledTimes(1);
    const fixed = setLayoutMock.mock.calls[0][0];
    expect(fixed.content.type).toBe('split');
    if (fixed.content.type !== 'split') throw new Error('expected split layout');
    expect(fixed.content.children[0].fraction).toBeCloseTo(0.85);
    expect(fixed.content.children[1].fraction).toBeCloseTo(0.15);
  });

  it('分割线拖动期间暂停 120px clamp 自愈，松手后再执行', async () => {
    vi.useFakeTimers();
    currentLayout = {
      ...createDefaultLayout(),
      content: {
        type: 'split',
        id: 'root',
        direction: 'row',
        children: [
          {
            fraction: 0.9,
            node: { type: 'pane', id: 'chat', panelKind: 'chat-main', minWidth: 400 },
          },
          {
            fraction: 0.1,
            node: { type: 'pane', id: 'right', panelKind: 'right-tabs', minWidth: 120 },
          },
        ],
      },
    };
    renderLayoutRoot();
    const content = screen.getByTestId('layout-root-content');
    content.getBoundingClientRect = () =>
      ({
        width: 800,
        height: 600,
        top: 0,
        right: 800,
        bottom: 600,
        left: 0,
        x: 0,
        y: 0,
        toJSON() {},
      }) as DOMRect;

    document.body.classList.add('resizing-pane');
    await act(async () => {
      vi.advanceTimersByTime(240);
      await Promise.resolve();
    });
    expect(setLayoutMock).not.toHaveBeenCalled();

    document.body.classList.remove('resizing-pane');
    await act(async () => {
      vi.advanceTimersByTime(120);
      await Promise.resolve();
    });
    expect(setLayoutMock).toHaveBeenCalledTimes(1);
  });

  it('卸载后重新 mount 不泄漏 onChanged 订阅', () => {
    const { unmount } = renderLayoutRoot();
    expect(changedListeners).toHaveLength(1);
    unmount();
    expect(changedListeners).toHaveLength(0);
  });

  it('根级 column split 渲染为插件 grid，两个 pane 填满各自格并带横向分割线', () => {
    const GridPane = ({ name }: { name: string }) => (
      <div
        data-testid={`grid-${name}`}
        data-fill={String(usePaneFill())}
        data-window-top={String(usePaneAtWindowTop())}
      />
    );
    registerPanelKind({
      kind: 'ghost:alpha',
      Component: () => <GridPane name="alpha" />,
      collapseMemory: 'global',
    });
    registerPanelKind({
      kind: 'ghost:beta',
      Component: () => <GridPane name="beta" />,
      collapseMemory: 'global',
    });
    currentLayout = {
      ...createDefaultLayout(),
      content: {
        type: 'split',
        id: 'root',
        direction: 'row',
        children: [
          {
            fraction: 0.35,
            node: { type: 'pane', id: 'chat', panelKind: 'chat-main', minWidth: 400 },
          },
          {
            fraction: 0.35,
            node: {
              type: 'split',
              id: 'grid-alpha',
              direction: 'column',
              children: [
                { fraction: 0.5, node: { type: 'pane', id: 'alpha', panelKind: 'ghost:alpha' } },
                { fraction: 0.5, node: { type: 'pane', id: 'beta', panelKind: 'ghost:beta' } },
              ],
            },
          },
          { fraction: 0.3, node: { type: 'pane', id: 'right', panelKind: 'right-tabs' } },
        ],
      },
    };

    renderLayoutRoot();

    expect(screen.getByTestId('grid-alpha').getAttribute('data-fill')).toBe('true');
    expect(screen.getByTestId('grid-beta').getAttribute('data-fill')).toBe('true');
    expect(screen.getByTestId('grid-alpha').getAttribute('data-window-top')).toBe('true');
    expect(screen.getByTestId('grid-beta').getAttribute('data-window-top')).toBe('false');
    expect(document.querySelector('[data-layout-root-child-id="grid-alpha"]')).not.toBeNull();
    expect(screen.getAllByTestId('layout-divider')).toHaveLength(3);
  });

  it('插件重新注册但布局树未变化时，恢复 grid 列', () => {
    currentLayout = {
      ...createDefaultLayout(),
      content: {
        type: 'split',
        id: 'root',
        direction: 'row',
        children: [
          {
            fraction: 0.5,
            node: { type: 'pane', id: 'chat', panelKind: 'chat-main', minWidth: 400 },
          },
          {
            fraction: 0.3,
            node: {
              type: 'split',
              id: 'grid-restored',
              direction: 'column',
              children: [
                {
                  fraction: 1,
                  node: { type: 'pane', id: 'restored', panelKind: 'ghost:restored' },
                },
              ],
            },
          },
          { fraction: 0.2, node: { type: 'pane', id: 'right', panelKind: 'right-tabs' } },
        ],
      },
    };

    const rendered = renderLayoutRoot();
    expect(document.querySelector('[data-layout-root-child-id="grid-restored"]')).toBeNull();

    registerPanelKind({
      kind: 'ghost:restored',
      Component: () => <div data-testid="restored-panel" />,
      collapseMemory: 'global',
    });
    ghostPanelSyncMock.version += 1;
    rendered.rerender(
      <BuiltinPanelBridgeProvider value={bridge}>
        <div data-testid="row">
          <LayoutRoot />
        </div>
      </BuiltinPanelBridgeProvider>,
    );

    const grid = document.querySelector<HTMLElement>('[data-layout-root-child-id="grid-restored"]');
    expect(grid).not.toBeNull();
    expect(screen.getByTestId('restored-panel')).not.toBeNull();
  });

  it('插件 manifest 更新但布局树未变化时，刷新已挂载面板定义', () => {
    registerPanelKind({
      kind: 'ghost:updated',
      Component: () => <div data-testid="updated-panel">before</div>,
      collapseMemory: 'global',
    });
    currentLayout = {
      ...createDefaultLayout(),
      content: {
        type: 'split',
        id: 'root',
        direction: 'row',
        children: [
          {
            fraction: 0.7,
            node: { type: 'pane', id: 'chat', panelKind: 'chat-main', minWidth: 400 },
          },
          {
            fraction: 0.3,
            node: { type: 'pane', id: 'updated', panelKind: 'ghost:updated' },
          },
        ],
      },
    };

    const rendered = renderLayoutRoot();
    expect(screen.getByTestId('updated-panel').textContent).toBe('before');

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    registerPanelKind({
      kind: 'ghost:updated',
      Component: () => <div data-testid="updated-panel">after</div>,
      collapseMemory: 'global',
    });
    expect(warn).toHaveBeenCalledWith(
      '[panels] duplicate registration overwrites kind: ghost:updated',
    );
    warn.mockRestore();
    ghostPanelSyncMock.version += 1;
    rendered.rerender(
      <BuiltinPanelBridgeProvider value={bridge}>
        <div data-testid="row">
          <LayoutRoot />
        </div>
      </BuiltinPanelBridgeProvider>,
    );

    expect(screen.getByTestId('updated-panel').textContent).toBe('after');
  });
});

describe('normalizeSubMinFractions', () => {
  it('全隐藏 grid 不进入在场比例尺，也不会触发布局自愈写回', () => {
    const layout: Layout = {
      ...createDefaultLayout(),
      content: {
        type: 'split',
        id: 'root',
        direction: 'row',
        children: [
          {
            fraction: 0.35,
            node: { type: 'pane', id: 'chat', panelKind: 'chat-main', minWidth: 400 },
          },
          {
            fraction: 0.6,
            node: {
              type: 'split',
              id: 'hidden-grid',
              direction: 'column',
              children: [
                { fraction: 1, node: { type: 'pane', id: 'hidden', panelKind: 'ghost:hidden' } },
              ],
            },
          },
          { fraction: 0.05, node: { type: 'pane', id: 'right', panelKind: 'right-tabs' } },
        ],
      },
    };

    const fixed = normalizeSubMinFractions(
      layout,
      2000,
      (kind) => kind === 'chat-main' || kind === 'right-tabs',
    );

    expect(fixed).toBeNull();
  });
});
