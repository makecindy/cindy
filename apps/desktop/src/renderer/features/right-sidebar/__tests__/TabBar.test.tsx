// @vitest-environment jsdom
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';
import type { RenderOptions } from '@testing-library/react';
import { act, cleanup, fireEvent, render as testingRender, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Sortable, { type SortableEvent } from 'sortablejs';
import type { ComponentProps } from 'react';

const render = (ui: ReactElement, options?: RenderOptions) =>
  testingRender(ui, { wrapper: MemoryRouter, ...options });

// react-i18next 走 key 透传(仓库同款,见 RightSidebarShell.test.ts):label 直接是 i18n key。
// 「+」菜单的插件分组:声明面板 / mainView 的已启用插件。无桥环境下用桩供数据。
const installedGhostsMock = vi.hoisted(() => ({ list: [] as unknown[] }));
vi.mock('@/cindy-brain/useInstalledGhosts', () => ({
  useInstalledGhosts: () => installedGhostsMock.list,
  readInstalledGhostsSnapshot: () => installedGhostsMock.list,
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/features/bots/botStore', () => ({ useBotProfiles: () => [] }));
vi.mock('@/lib/sessionsStore', () => ({ sessionsStore: { subscribe: () => () => {}, findById: () => null } }));
vi.mock('@/features/device-link/remoteProjectsStore', () => ({ useRemoteProjectSessions: () => [] }));
vi.mock('../lib/openSideChatTab', () => ({ canOpenSideChat: () => false, openSideChatTab: vi.fn() }));

import { TabStrip } from '../TabBar';
import { useTabCreationMenu } from '../lib/useTabCreationMenu';
import type { TabState } from '../types';

function StripWithMenu(props: Omit<ComponentProps<typeof TabStrip>, 'creationMenu'>) {
  const menu = useTabCreationMenu({ sessionId: 'task-1', subagentsAvailable: false, onSelect: vi.fn() });
  return <TabStrip {...props} creationMenu={menu} />;
}

// 两个不同 kind 的 tab —— 未注册 plugin 时走 fallback 图标/标题,label 即 KIND_LABEL_KEY。
const TABS: TabState[] = [
  { id: 'tab-file', kind: 'file-browser', state: null },
  { id: 'tab-web', kind: 'web-browser', state: null },
  { id: 'tab-orca', kind: 'orca-workers', state: null },
];
const LABEL_FILE = 'rightSidebar.tabs.kinds.fileBrowser';
const LABEL_WEB = 'rightSidebar.tabs.kinds.browser';
const LABEL_ORCA = 'rightSidebar.tabs.kinds.collaboration';

/** 由 tab 的可见标题回溯到它所在的 pill 根节点(带 onAuxClick 的那层 `.group` div)。 */
function pillFor(labelKey: string): HTMLElement {
  const pill = screen.getByText(labelKey).closest('.group');
  if (!pill) throw new Error(`未找到 label=${labelKey} 对应的 tab pill`);
  return pill as HTMLElement;
}

// @testing-library 当前版本无 fireEvent.auxClick 简写;真实中键/右键在 Chromium 里派发的
// 是冒泡的原生 `auxclick`(button 1/2),React 的 onAuxClick 监听它 —— 这里手动构造派发,
// 与真实手势一致。
function fireAux(el: HTMLElement, button: number): void {
  fireEvent(el, new MouseEvent('auxclick', { button, bubbles: true, cancelable: true }));
}

function renderStrip(overrides?: {
  onClose?: () => void;
  onActivate?: () => void;
  onReorder?: (orderedIds: string[]) => void;
}) {
  const onClose = vi.fn(overrides?.onClose);
  const onActivate = vi.fn(overrides?.onActivate);
  const onReorder = vi.fn(overrides?.onReorder);
  render(
    <StripWithMenu
      tabs={TABS}
      activeTabId={null}
      onActivate={onActivate}
      onClose={onClose}
      onReorder={onReorder}
    />,
  );
  return { onClose, onActivate, onReorder };
}

describe('TabStrip Cindy Make menu visibility', () => {
  it('keeps Cindy Make out of the add menu', () => {
    renderStrip();
    const addButton = screen.getByRole('button', { name: 'rightSidebar.tabs.addAria' });
    vi.spyOn(addButton.parentElement as HTMLElement, 'getBoundingClientRect').mockReturnValue({
      x: 20,
      y: 20,
      top: 20,
      right: 44,
      bottom: 44,
      left: 20,
      width: 24,
      height: 24,
      toJSON: () => ({}),
    });
    fireEvent.pointerDown(addButton, { button: 0, ctrlKey: false });
    expect(screen.queryByText('settings.cindyMake.title')).toBeNull();
  });
});

// 测试价值
// - 生产入口与可观察结果:TabStrip 的「+」菜单;可观察的是声明停靠面板的已启用插件出现在
//   「插件」分组里,点选后成为右侧栏全局页签(globalTabs),再次打开菜单标「已打开」。
// - Bug / 规则依据:停靠面板收束为右侧栏全局页签后,没有左侧栏入口的面板插件(如只声明
//   panel 的 Mivo)关掉页签后必须仍有重开入口,否则用户视角等于插件不可用(插件兼容红线)。
// - 现有覆盖缺口:其余「+」菜单用例只覆盖内置 kind。
// - 最小失败输入:一个 enabled 且 panel.position 缺省的插件。
// - tier:unit(jsdom)。
describe('TabStrip add menu · plugins group', () => {
  it('lists panel plugins and pins the chosen one as a global tab', async () => {
    const { __resetGlobalTabsForTest, getGlobalTabs } = await import('../globalTabs');
    __resetGlobalTabsForTest();
    window.localStorage.clear();
    installedGhostsMock.list = [
      { manifest: { id: 'xd-mivo', name: 'XD Mivo', panel: { html: 'panel.html', title: 'Mivo 资产库' } }, enabled: true },
      { manifest: { id: 'tool-only', name: 'Tool Only' }, enabled: true },
    ];
    renderStrip();
    const addButton = screen.getByRole('button', { name: 'rightSidebar.tabs.addAria' });
    vi.spyOn(addButton.parentElement as HTMLElement, 'getBoundingClientRect').mockReturnValue({
      x: 20, y: 20, top: 20, right: 44, bottom: 44, left: 20, width: 24, height: 24, toJSON: () => ({}),
    });
    fireEvent.pointerDown(addButton, { button: 0, ctrlKey: false });
    expect(screen.getByText('rightSidebar.tabs.menu.pluginsLabel')).toBeTruthy();
    expect(screen.queryByText('Tool Only')).toBeNull();
    fireEvent.click(screen.getByText('Mivo 资产库'));
    expect(getGlobalTabs().map((tab) => (tab.state as { instanceId: string }).instanceId)).toEqual(['xd-mivo']);
    installedGhostsMock.list = [];
    __resetGlobalTabsForTest();
    window.localStorage.clear();
  });
});

// 测试价值
// - 生产入口与可观察结果:页签右键菜单的「移到 …」项;可观察的是列出除本组外的三个
//   目标组、点选回调带目标组 id、未提供 onMoveTab(弹出窗口)时不出现。
// - Bug / 规则依据:页签组模型——页签可移到聊天区左 / 上 / 下边。
// - 现有覆盖缺口:右键菜单此前无用例。
// - 最小失败输入:groupId='right' + 一个页签,右键。
// - tier:unit(jsdom)。
describe('TabStrip context menu · move to group', () => {
  it('lists the other three groups and reports the chosen target', () => {
    const onMoveTab = vi.fn();
    render(
      <TabStrip
        tabs={TABS}
        activeTabId={null}
        onActivate={vi.fn()}
        onClose={vi.fn()}
        onReorder={vi.fn()}
        creationMenu={{ items: [], select: vi.fn() }}
        groupId="right"
        onMoveTab={onMoveTab}
      />,
    );
    fireEvent.contextMenu(pillFor(LABEL_WEB));
    expect(screen.queryByTestId('right-sidebar-tab-move-right')).toBeNull();
    expect(screen.getByTestId('right-sidebar-tab-move-top')).toBeTruthy();
    expect(screen.getByTestId('right-sidebar-tab-move-bottom')).toBeTruthy();
    fireEvent.click(screen.getByTestId('right-sidebar-tab-move-left'));
    expect(onMoveTab).toHaveBeenCalledWith('tab-web', 'left');
  });

  it('offers no move items when the host does not support moving (popped-out window)', () => {
    renderStrip();
    fireEvent.contextMenu(pillFor(LABEL_FILE));
    expect(screen.getByText('rightSidebar.tabs.contextMenu.close')).toBeTruthy();
    expect(screen.queryByTestId('right-sidebar-tab-move-left')).toBeNull();
  });
});

// 测试价值
// - 生产入口与可观察结果:页签右键菜单的「移到窗口 …」(主窗,按已弹出窗口列出)与
//   「合并回侧边栏」(弹出窗口);可观察的是回调带被点页签与目标窗口 id。
// - Bug / 规则依据:弹出窗口 = 多页签的页签组(本 PR),主窗能把页签搬进已有窗口。
// - 现有覆盖缺口:右键菜单此前只有关闭 / 移组用例。
// - 最小失败输入:一扇弹出窗口选项 + 右键一个页签。
// - tier:unit(jsdom)。
describe('TabStrip context menu · popped-out windows', () => {
  it('offers existing popped-out windows as move targets and merge-back inside a window', () => {
    const onDetachTab = vi.fn();
    const onMergeBackTab = vi.fn();
    render(
      <TabStrip
        tabs={TABS}
        activeTabId={null}
        onActivate={vi.fn()}
        onClose={vi.fn()}
        onReorder={vi.fn()}
        creationMenu={{ items: [], select: vi.fn() }}
        onDetachTab={onDetachTab}
        popoutWindows={[{ windowId: 'w7', label: <span>Docs</span> }]}
        onMergeBackTab={onMergeBackTab}
      />,
    );
    fireEvent.contextMenu(pillFor(LABEL_FILE));
    fireEvent.click(screen.getByTestId('right-sidebar-tab-move-window-w7'));
    expect(onDetachTab).toHaveBeenCalledWith('tab-file', 'w7');
    fireEvent.contextMenu(pillFor(LABEL_ORCA));
    fireEvent.click(screen.getByTestId('right-sidebar-tab-merge-back'));
    expect(onMergeBackTab).toHaveBeenCalledWith('tab-orca');
  });
});

afterEach(() => cleanup());

describe('TabStrip 中键关闭 tab', () => {
  it('renders the collaboration tab fallback label when the plugin is not registered', () => {
    renderStrip();
    expect(screen.getByText(LABEL_ORCA)).toBeTruthy();
  });

  it('中键(button === 1)关闭被点击的 tab,并传入正确的 tab id', () => {
    const { onClose, onActivate } = renderStrip();
    fireAux(pillFor(LABEL_FILE), 1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith('tab-file');
    // 中键不应误触发激活(激活是 pill 内主键 onClick)。
    expect(onActivate).not.toHaveBeenCalled();
  });

  it('中键关闭第二个 tab 时传入的是它自己的 id(而非首个)', () => {
    const { onClose } = renderStrip();
    fireAux(pillFor(LABEL_WEB), 1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith('tab-web');
  });

  it('右键(button === 2)不关闭 tab —— 右键仍归右键菜单', () => {
    const { onClose } = renderStrip();
    fireAux(pillFor(LABEL_FILE), 2);
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('TabStrip 拖拽重排', () => {
  it('drop 后按新顺序上报全部 tab id,并让 React 保持 DOM 唯一写入者', () => {
    const { onReorder } = renderStrip();
    const firstRow = document.querySelector<HTMLElement>('[data-sortable-id="tab-file"]');
    const list = firstRow?.parentElement;
    if (!firstRow || !list) throw new Error('sortable tab list not found');

    const sortable = Sortable.get(list);
    const onEnd = sortable?.option('onEnd') as ((evt: SortableEvent) => void) | undefined;
    if (!onEnd) throw new Error('Sortable onEnd handler not found');

    // 模拟 SortableJS 在 drop 前已把首项移到末尾;onEnd 应先还原 DOM,
    // 再把目标顺序交给 React/store,避免 Sortable 与 React 同时改 children。
    list.appendChild(firstRow);
    act(() => {
      onEnd({ item: firstRow, from: list, oldIndex: 0, newIndex: 2 } as SortableEvent);
    });

    expect(onReorder).toHaveBeenCalledWith(['tab-web', 'tab-orca', 'tab-file']);
    expect(Array.from(list.children).map((row) => row.getAttribute('data-sortable-id'))).toEqual([
      'tab-file',
      'tab-web',
      'tab-orca',
    ]);
  });

  it('关闭按钮不作为拖拽起点', () => {
    renderStrip();
    const close = screen.getAllByRole('button', {
      name: 'rightSidebar.tabs.tabCloseAria',
    })[0];
    expect(close?.hasAttribute('data-no-drag')).toBe(true);
  });
});

describe('TabStrip 未知 kind 前向兼容(2026-07-09 React #130 事故回归)', () => {
  // DB 里的 kind 是自由文本:更新版本 / 并行 dev 分支可能写入本版本不认识的
  // kind(事故实例:'orca-workers',该 kind 现已注册,用例改用仍未注册的假想
  // kind 保持回归意图)。老版本渲染时必须兜底,不能崩整棵路由树。
  const UNKNOWN_TAB = {
    id: 'tab-future',
    kind: 'kind-from-future-version',
    state: null,
  } as unknown as TabState;
  const LABEL_UNKNOWN = 'rightSidebar.tabs.kinds.unknown';

  it('未知 kind 的 tab 正常渲染为「未知标签页」pill,不抛 React #130', () => {
    render(
      <TabStrip
        tabs={[...TABS, UNKNOWN_TAB]}
        activeTabId={null}
        onActivate={vi.fn()}
        onClose={vi.fn()}
        onReorder={vi.fn()}
        creationMenu={{ items: [], select: vi.fn() }}
      />,
    );
    // 已知 tab 不受影响,未知 tab 以 fallback label 显示
    expect(screen.getByText(LABEL_FILE)).toBeTruthy();
    expect(screen.getByText(LABEL_UNKNOWN)).toBeTruthy();
  });

  it('未知 kind 的 tab 可以被关闭(用户能自行清掉新版本留下的 tab)', () => {
    const onClose = vi.fn();
    render(
      <TabStrip
        tabs={[UNKNOWN_TAB]}
        activeTabId={null}
        onActivate={vi.fn()}
        onClose={onClose}
        onReorder={vi.fn()}
        creationMenu={{ items: [], select: vi.fn() }}
      />,
    );
    fireAux(pillFor(LABEL_UNKNOWN), 1);
    expect(onClose).toHaveBeenCalledWith('tab-future');
  });
});
