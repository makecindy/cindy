// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDefaultLayout, type Layout, type SplitNode } from '../../../shared/layoutTree';
import { BuiltinPanelBridgeProvider, type BuiltinPanelBridge } from '../../panels/BuiltinPanelBridge';
import { __resetBuiltinPanelsForTest } from '../../panels/builtinPanels';
import { __resetPanelRegistryForTest } from '../../panels/registry';
import { LayoutRoot } from '../LayoutRoot';
import { ContentAvailableWidthProvider, usePanelWidth } from '../paneWidths';

/**
 * 引擎分割线拖宽 —— 锁"在场份额"口径(2026-07-29 Lizi 实测回归)。
 *
 * 现场:userData/layout.v1.json 里躺着一条**已卸载插件**的残留 pane(占 22% 份额)。
 * 它不渲染,那块地方被弹性的 chat 吸收,于是账面(fraction)与画面严重脱钩:
 * chat 账面 45.9%、画面 67.9%。旧实现按树上原始 fraction 算拖缝余量,右栏拖到最大
 * 时夹取值恰好压在 transferSplitFraction 的 0.05 下限上,松手写树被**整单拒绝**
 * (浮点残差算出 0.04999999999999999),整段位移作废 → 右栏弹回原宽,而且中间的
 * 聊天流永远压不到 400px 硬下限。
 */

const AVAIL = 1660; // 1920 窗口 − 260 左栏
const CHAT_MIN = 400;

let currentLayout: Layout;
let setCalls: Layout[];

function stubElectronLayoutApi(): void {
  setCalls = [];
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    layout: {
      getStateSync: () => ({ layout: currentLayout }),
      set: (next: Layout) => {
        setCalls.push(next);
        currentLayout = next;
        return Promise.resolve({ layout: next });
      },
      onChanged: () => () => undefined,
    },
  };
}

/** 用户现场树:已卸载的 ghost:project-opener 残留 0.22 + chat 0.4589 + 右栏 0.3211。 */
function treeWithUninstalledResidue(): Layout {
  const layout = createDefaultLayout();
  const split = layout.content as SplitNode;
  split.children[0].fraction = 0.4589135021784424; // chat
  split.children[1].fraction = 0.32108649782155757; // right-tabs
  split.children.unshift({
    fraction: 0.22,
    node: { type: 'pane', id: 'ghost-project-opener', panelKind: 'ghost:project-opener', minWidth: 240 },
  });
  return layout;
}

function WidthProbe({ kind }: { kind: string }): React.ReactNode {
  return <span data-testid={`w-${kind}`}>{usePanelWidth(kind) ?? 'null'}</span>;
}

const bridge: BuiltinPanelBridge = {
  sessionList: null,
  // data-panel-drag-root 与真机一致(起拖实测口径);jsdom 里矩形恒为 0,
  // 引擎自动回落账本估值 —— 正是"量不到元素时兜底"这条路径。
  chatMain: <div data-testid="p-chat" data-panel-drag-root="chat-main" />,
  rightTabs: (
    <div data-testid="p-right" data-panel-drag-root="right-tabs">
      <WidthProbe kind="right-tabs" />
    </div>
  ),
};

function renderLayoutRoot() {
  return render(
    <BuiltinPanelBridgeProvider value={bridge}>
      <ContentAvailableWidthProvider value={AVAIL}>
        <div data-testid="row">
          <LayoutRoot />
        </div>
      </ContentAvailableWidthProvider>
    </BuiltinPanelBridgeProvider>,
  );
}

/** 把缝一路拖向左(右侧面板变宽)到抓不动为止,松手。 */
function dragDividerLeft(container: HTMLElement, byPx: number): void {
  const grab = container.querySelector('[data-testid="layout-divider"] > div');
  expect(grab).not.toBeNull();
  fireEvent.pointerDown(grab!, { button: 0, pointerId: 1, clientX: 1000 });
  fireEvent.pointerMove(document, { pointerId: 1, clientX: 1000 - byPx });
  fireEvent.pointerUp(document, { pointerId: 1, clientX: 1000 - byPx });
}

function committedShares(): Record<string, { fraction: number; share: number; px: number }> {
  const children = (setCalls.at(-1)!.content as SplitNode).children;
  // 在场份额 = fraction / Σ在场 fraction(未注册的 ghost 残留不在场)。
  const scale = children
    .filter((c) => c.node.type === 'pane' && c.node.panelKind !== 'ghost:project-opener')
    .reduce((sum, c) => sum + c.fraction, 0);
  const out: Record<string, { fraction: number; share: number; px: number }> = {};
  for (const child of children) {
    if (child.node.type !== 'pane') continue;
    out[child.node.panelKind] = {
      fraction: child.fraction,
      share: child.fraction / scale,
      px: (child.fraction / scale) * AVAIL,
    };
  }
  return out;
}

beforeEach(() => {
  currentLayout = createDefaultLayout();
  stubElectronLayoutApi();
});

afterEach(() => {
  cleanup();
  __resetPanelRegistryForTest();
  __resetBuiltinPanelsForTest();
});

describe('RootDivider 拖宽 · 在场份额口径', () => {
  it('已卸载插件的残留份额不参与分配:右栏宽按在场份额算', () => {
    currentLayout = treeWithUninstalledResidue();
    renderLayoutRoot();
    // 在场份额 0.3211 / 0.78 = 0.4117 → 683px。按树上原始 fraction 只有 533px。
    expect(Number(screen.getByTestId('w-right-tabs').textContent)).toBe(683);
  });

  it('有卸载残留时把右栏拖到最大:松手后写树成功(不回弹),聊天流正好落在最小宽', () => {
    currentLayout = treeWithUninstalledResidue();
    const { container } = renderLayoutRoot();
    dragDividerLeft(container, 1000); // 远超余量,靠夹取到头

    expect(setCalls).toHaveLength(1); // 提交没被整单拒绝 —— 回弹的直接判据
    const after = committedShares();
    expect(after['chat-main'].px).toBeCloseTo(CHAT_MIN, 0); // 真的挤到 400px
    expect(after['right-tabs'].px).toBeCloseTo(AVAIL - CHAT_MIN, 0);
    expect(after['chat-main'].fraction).toBeGreaterThanOrEqual(0.05); // 树份额仍合法
    // 隐藏面板的位置与宽度记忆一字不动(architecture-invariants §3)。
    expect(after['ghost:project-opener'].fraction).toBe(0.22);
    const sum = (setCalls[0].content as SplitNode).children.reduce((s, c) => s + c.fraction, 0);
    expect(sum).toBeCloseTo(1, 6);
  });

  it('干净的两栏树:同样能把聊天流拖到最小宽,且写树成功', () => {
    currentLayout = createDefaultLayout(); // chat 0.5 / right 0.5
    const { container } = renderLayoutRoot();
    dragDividerLeft(container, 1000);

    expect(setCalls).toHaveLength(1);
    const children = (setCalls[0].content as SplitNode).children;
    expect(children[0].fraction * AVAIL).toBeCloseTo(CHAT_MIN, 0);
    expect(children[1].fraction * AVAIL).toBeCloseTo(AVAIL - CHAT_MIN, 0);
  });

  it('往反方向拖(压缩右栏):停在非 chat 面板的 120px 防拖丢兜底', () => {
    currentLayout = treeWithUninstalledResidue();
    const { container } = renderLayoutRoot();
    dragDividerLeft(container, -1000); // 负向 = 缝往右,右栏变窄

    expect(setCalls).toHaveLength(1);
    expect(committedShares()['right-tabs'].px).toBeCloseTo(120, 0);
  });
});
