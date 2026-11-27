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
import { effectiveChatMinPx, LayoutRoot, normalizeSubMinFractions } from '../LayoutRoot';
import { usePaneAtWindowTop, usePaneFill, usePaneAtWindowLeft } from '../panePlacement';

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

  // Bug:左置 right-tabs 收起后仍挂载，曾遮蔽聊天列的窗口左边缘标记，导致上方页签组
  // 不给 ChromeActions 留 no-drag 命中洞。现有测试只有展开布局；最小输入为零宽 right-tabs
  // + 带上方页签组的聊天列。经真实 LayoutRoot 验证面板消费的边缘合同及展开恢复；tier:unit。
  it('左置 right-tabs 收起时将窗口左边缘交给聊天列，重新展开后收回', () => {
    registerPanelKind({
      kind: 'tab-group:top',
      Component: () => (
        <div
          data-testid="p-top"
          data-window-left={String(usePaneAtWindowLeft())}
          data-window-top={String(usePaneAtWindowTop())}
        />
      ),
      collapseMemory: 'none',
    });
    currentLayout = {
      ...createDefaultLayout(),
      content: {
        type: 'split',
        id: 'root',
        direction: 'row',
        children: [
          { fraction: 0.3, node: { type: 'pane', id: 'right', panelKind: 'right-tabs' } },
          {
            fraction: 0.7,
            node: {
              type: 'split',
              id: 'chat-column',
              direction: 'column',
              children: [
                { fraction: 0.35, node: { type: 'pane', id: 'top', panelKind: 'tab-group:top' } },
                { fraction: 0.65, node: { type: 'pane', id: 'chat', panelKind: 'chat-main', minWidth: 400 } },
              ],
            },
          },
        ],
      },
    };
    const view = (collapsed: boolean) => (
      <BuiltinPanelBridgeProvider value={bridge}>
        <LayoutRoot rightTabsCollapsed={collapsed} />
      </BuiltinPanelBridgeProvider>
    );
    const rendered = render(view(false));
    const retainedRight = screen.getByTestId('p-right');
    expect(screen.getByTestId('p-top').getAttribute('data-window-left')).toBe('false');

    rendered.rerender(view(true));
    expect(screen.getByTestId('p-top').getAttribute('data-window-left')).toBe('true');
    expect(screen.getByTestId('p-top').getAttribute('data-window-top')).toBe('true');
    expect(screen.getByTestId('p-right')).toBe(retainedRight);

    rendered.rerender(view(false));
    expect(screen.getByTestId('p-top').getAttribute('data-window-left')).toBe('false');
    expect(screen.getByTestId('p-right')).toBe(retainedRight);
    expect(setLayoutMock).not.toHaveBeenCalled();
  });

  // 测试价值
  // - 生产入口与可观察结果:LayoutRoot 渲染「聊天列」(chat-main 与上下页签组同在一层
  //   column split);可观察的是聊天列作为根级弹性区域(flex-1、不吃像素宽)、列内有横缝、
  //   下方页签组填满格;接管态(设置页)只剩聊天区且撑满整列。
  // - Bug / 规则依据:页签组可停在聊天区上 / 下边(页签组模型);根横排里只有包着聊天区
  //   的那块是弹性的,否则聊天列会按份额被钉成固定宽、页签组在设置页冒出来。
  // - 现有覆盖缺口:此前 column split 只有插件 grid 用例,聊天区从不在列里。
  // - 最小失败输入:chat-column{chat-main, tab-group:bottom} + right-tabs。
  // - tier:unit(jsdom)。
  it('聊天列:chat-main 与下方页签组同列,列是根级弹性区域;接管态只剩聊天区', () => {
    registerPanelKind({
      kind: 'tab-group:bottom',
      Component: () => (
        <div
          data-testid="p-bottom"
          data-fill={String(usePaneFill())}
          data-window-left={String(usePaneAtWindowLeft())}
        />
      ),
      collapseMemory: 'none',
    });
    registerPanelKind({
      kind: 'tab-group:probe-right',
      Component: () => <div data-testid="p-probe" data-window-left={String(usePaneAtWindowLeft())} />,
      collapseMemory: 'none',
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
            node: {
              type: 'split',
              id: 'chat-column',
              direction: 'column',
              children: [
                { fraction: 0.65, node: { type: 'pane', id: 'chat', panelKind: 'chat-main', minWidth: 400 } },
                { fraction: 0.35, node: { type: 'pane', id: 'tab-group-bottom', panelKind: 'tab-group:bottom' } },
              ],
            },
          },
          { fraction: 0.2, node: { type: 'pane', id: 'right', panelKind: 'right-tabs' } },
          { fraction: 0.1, node: { type: 'pane', id: 'probe', panelKind: 'tab-group:probe-right' } },
        ],
      },
    };
    const rendered = renderLayoutRoot();
    // 聊天列是最左的根级区域:列里的下方组贴着内容区左边(左栏收起时就是窗口左上角,
    // 顶栏要给红绿灯让位);右边的面板不贴。
    expect(screen.getByTestId('p-bottom').getAttribute('data-window-left')).toBe('true');
    expect(screen.getByTestId('p-probe').getAttribute('data-window-left')).toBe('false');
    const column = document.querySelector<HTMLElement>('[data-layout-root-child-id="chat-column"]');
    expect(column).not.toBeNull();
    expect(column!.className).toContain('flex-1');
    expect(column!.style.width).toBe('');
    expect(screen.getByTestId('p-chat')).toBeTruthy();
    expect(screen.getByTestId('p-bottom').getAttribute('data-fill')).toBe('true');
    // 列内一条横缝 + 根级一条竖缝。
    expect(screen.getAllByTestId('layout-divider')).toHaveLength(3);

    rendered.rerender(
      <BuiltinPanelBridgeProvider value={bridge}>
        <div data-testid="row">
          <LayoutRoot suppressNonChatPanels />
        </div>
      </BuiltinPanelBridgeProvider>,
    );
    expect(screen.queryByTestId('p-bottom')).toBeNull();
    expect(screen.queryByTestId('p-right')).toBeNull();
    expect(screen.getByTestId('p-chat')).toBeTruthy();
    expect(screen.queryAllByTestId('layout-divider')).toHaveLength(0);
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

    // 注册表变更会同步通知 LayoutRoot(页签组 pane 动态注册走同一信号),包进 act。
    act(() => {
      registerPanelKind({
        kind: 'ghost:restored',
        Component: () => <div data-testid="restored-panel" />,
        collapseMemory: 'global',
      });
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
    act(() => {
      registerPanelKind({
        kind: 'ghost:updated',
        Component: () => <div data-testid="updated-panel">after</div>,
        collapseMemory: 'global',
      });
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


describe('LayoutRoot sidebar window growth', () => {
  it('expands once on open, restores on close, and leaves startup alone', async () => {
    const expand = vi.fn(async () => undefined);
    window.electronAPI.windowSidebarExpansion = expand;
    const view = (collapsed: boolean) => (
      <BuiltinPanelBridgeProvider value={bridge}>
        <LayoutRoot rightTabsCollapsed={collapsed} />
      </BuiltinPanelBridgeProvider>
    );
    const rendered = render(view(true));
    vi.spyOn(screen.getByTestId('layout-root-content'), 'getBoundingClientRect')
      .mockReturnValue({ width: 800 } as DOMRect);
    expect(expand).not.toHaveBeenCalled();
    rendered.rerender(view(false));
    expect(expand).toHaveBeenLastCalledWith(802);
    rendered.rerender(view(false));
    expect(expand).toHaveBeenCalledTimes(1);
    await act(async () => { rendered.rerender(view(true)); });
    expect(expand).toHaveBeenLastCalledWith(0);
  });
  it('does not grow rightwards for a panel docked on the left', () => {
    if (currentLayout.content.type === 'split') currentLayout.content.children.reverse();
    const expand = vi.fn(async () => undefined);
    window.electronAPI.windowSidebarExpansion = expand;
    const view = (collapsed: boolean) => (
      <BuiltinPanelBridgeProvider value={bridge}>
        <LayoutRoot rightTabsCollapsed={collapsed} />
      </BuiltinPanelBridgeProvider>
    );
    const rendered = render(view(true));
    rendered.rerender(view(false));
    expect(expand).not.toHaveBeenCalled();
  });
});


it('expands the saved standalone window when the initial session restores an open sidebar', async () => {
  const expand = vi.fn(async () => undefined);
  window.electronAPI.windowSidebarExpansion = expand;
  const view = (ready: boolean) => (
    <BuiltinPanelBridgeProvider value={bridge}>
      <LayoutRoot rightTabsCollapsed={!ready} sidebarExpansionReady={ready} />
    </BuiltinPanelBridgeProvider>
  );
  const rendered = render(view(false));
  vi.spyOn(screen.getByTestId('layout-root-content'), 'getBoundingClientRect')
    .mockReturnValue({ width: 800 } as DOMRect);
  await act(async () => { rendered.rerender(view(true)); });
  expect(expand).toHaveBeenCalledExactlyOnceWith(802);
});

// 回归 PR #13160 P1：360px 窄副窗下展开右栏或存在根级页签组/插件列时，若聊天区仍强占
// min(400px, 100%) 且嵌套非 chat 列保持 flex-none，右栏会被挤成 0 宽、根级多面板会顶出
// overflow-hidden 裁切右缘。经 LayoutRoot 真实渲染验证 --layout-chat-min 与 shrink 协同。
describe('LayoutRoot · 窄副窗多面板下限让步', () => {
  it('effectiveChatMinPx 在宽窗保持 400px，窄窗按兄弟下限之和让步且不小于 0', () => {
    expect(effectiveChatMinPx(800, 121)).toBe(400);
    expect(effectiveChatMinPx(521, 121)).toBe(400);
    expect(effectiveChatMinPx(360, 0)).toBe(360);
    expect(effectiveChatMinPx(360, 121)).toBe(239);
    expect(effectiveChatMinPx(360, 242)).toBe(118);
    expect(effectiveChatMinPx(180, 242)).toBe(0);
  });

  it('按展开中的非 chat 根级兄弟为 --layout-chat-min 预留地板，嵌套非 chat 列可收缩', () => {
    registerPanelKind({
      kind: 'ghost:narrow-grid',
      Component: () => <div data-testid="narrow-grid" />,
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
            fraction: 0.3,
            node: {
              type: 'split',
              id: 'grid-narrow',
              direction: 'column',
              children: [
                { fraction: 1, node: { type: 'pane', id: 'ng', panelKind: 'ghost:narrow-grid' } },
              ],
            },
          },
          { fraction: 0.4, node: { type: 'pane', id: 'chat', panelKind: 'chat-main', minWidth: 400 } },
          { fraction: 0.3, node: { type: 'pane', id: 'right', panelKind: 'right-tabs' } },
        ],
      },
    };

    const view = (collapsed: boolean) => (
      <BuiltinPanelBridgeProvider value={bridge}>
        <LayoutRoot rightTabsCollapsed={collapsed} />
      </BuiltinPanelBridgeProvider>
    );
    const rendered = render(view(false));
    const root = screen.getByTestId('layout-root-content');
    // grid-narrow(120+1) + right-tabs(120+1) = 242px → 360px 窄窗下聊天区让步到 118px，三栏均不被裁
    expect(root.style.getPropertyValue('--layout-chat-min')).toBe(
      'min(400px, max(0px, calc(100cqw - 242px)))',
    );
    const grid = document.querySelector<HTMLElement>('[data-layout-root-child-id="grid-narrow"]');
    expect(grid?.className).toContain('shrink');
    expect(grid?.className).not.toContain('flex-none');

    // 收起右栏后，只剩 grid-narrow(121px) 占地板
    rendered.rerender(view(true));
    expect(root.style.getPropertyValue('--layout-chat-min')).toBe(
      'min(400px, max(0px, calc(100cqw - 121px)))',
    );

    // 接管态（设置页）隐藏所有非 chat 面板，聊天区独享 100cqw
    rendered.rerender(
      <BuiltinPanelBridgeProvider value={bridge}>
        <LayoutRoot suppressNonChatPanels />
      </BuiltinPanelBridgeProvider>,
    );
    expect(root.style.getPropertyValue('--layout-chat-min')).toBe('min(400px, 100cqw)');
  });
});
