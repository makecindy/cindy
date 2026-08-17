// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Sortable, { type SortableEvent } from 'sortablejs';

// react-i18next 走 key 透传(仓库同款,见 RightSidebarShell.test.ts):label 直接是 i18n key。
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { TabStrip } from '../TabBar';
import type { TabState } from '../types';

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
  iosSimulatorAvailable?: boolean;
}) {
  const onClose = vi.fn(overrides?.onClose);
  const onActivate = vi.fn(overrides?.onActivate);
  const onReorder = vi.fn(overrides?.onReorder);
  render(
    <TabStrip
      tabs={TABS}
      activeTabId={null}
      onActivate={onActivate}
      onClose={onClose}
      onReorder={onReorder}
      onAdd={vi.fn()}
      iosSimulatorAvailable={overrides?.iosSimulatorAvailable}
    />,
  );
  return { onClose, onActivate, onReorder };
}

describe('TabStrip iOS Simulator plugin gate', () => {
  it('does not expose the Host viewer before the product plugin is enabled', () => {
    renderStrip();
    fireEvent.click(screen.getByRole('button', { name: 'rightSidebar.tabs.addAria' }));
    expect(screen.queryByText('rightSidebar.tabs.kinds.iosSimulator')).toBeNull();
  });

  it('exposes the Host viewer menu item for the enabled product plugin', () => {
    renderStrip({ iosSimulatorAvailable: true });
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
    fireEvent.click(addButton);
    expect(screen.getByText('rightSidebar.tabs.kinds.iosSimulator')).toBeTruthy();
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
        onAdd={vi.fn()}
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
        onAdd={vi.fn()}
      />,
    );
    fireAux(pillFor(LABEL_UNKNOWN), 1);
    expect(onClose).toHaveBeenCalledWith('tab-future');
  });
});
