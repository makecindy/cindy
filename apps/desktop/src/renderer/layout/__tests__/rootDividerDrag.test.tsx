// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDefaultLayout, type Layout, type SplitNode } from '../../../shared/layoutTree';
import {
  BuiltinPanelBridgeProvider,
  type BuiltinPanelBridge,
} from '../../panels/BuiltinPanelBridge';
import { __resetBuiltinPanelsForTest } from '../../panels/builtinPanels';
import { __resetPanelRegistryForTest, registerPanelKind } from '../../panels/registry';
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
    node: {
      type: 'pane',
      id: 'ghost-project-opener',
      panelKind: 'ghost:project-opener',
      minWidth: 240,
    },
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

function renderLayoutRoot(availableWidth = AVAIL) {
  return render(
    <BuiltinPanelBridgeProvider value={bridge}>
      <ContentAvailableWidthProvider value={availableWidth}>
        <div data-testid="row">
          <LayoutRoot />
        </div>
      </ContentAvailableWidthProvider>
    </BuiltinPanelBridgeProvider>,
  );
}

function renderLayoutRootWithoutWidthHint() {
  return render(
    <BuiltinPanelBridgeProvider value={bridge}>
      <div data-testid="row">
        <LayoutRoot />
      </div>
    </BuiltinPanelBridgeProvider>,
  );
}

function mockElementWidth(element: HTMLElement, width: number): void {
  element.getBoundingClientRect = () =>
    ({
      width,
      height: 0,
      top: 0,
      left: 0,
      right: width,
      bottom: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
}

/**
 * 覆盖 jsdom 恒为 0 的矩形:给某 panelKind 的元素钉死一个实测宽,让起拖时
 * measuredPanePx 拿到真机口径的宽度(而非回落账面)。
 */
function mockPaneWidth(kind: string, width: number): void {
  const el = document.querySelector(`[data-panel-drag-root="${kind}"]`) as HTMLElement | null;
  expect(el).not.toBeNull();
  mockElementWidth(el!, width);
}

/** 把缝一路拖向左(右侧面板变宽)到抓不动为止,松手。 */
function dragDividerLeft(container: HTMLElement, byPx: number): void {
  dragDividerLeftAt(container, byPx, 0);
}

/** 同上,指定第几条缝(多面板在场时缝不止一条)。 */
function dragDividerLeftAt(container: HTMLElement, byPx: number, dividerIndex: number): void {
  const grabs = container.querySelectorAll('[data-testid="layout-divider"] > div');
  const grab = grabs[dividerIndex];
  expect(grab).not.toBeFalsy();
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
  it('生产路径没有宽度提示时按内容区宽度换算拖动份额', () => {
    const { container } = renderLayoutRootWithoutWidthHint();
    mockElementWidth(screen.getByTestId('layout-root-content'), AVAIL);
    const divider = screen.getByTestId('layout-divider');
    mockElementWidth(divider, 1);

    dragDividerLeft(container, AVAIL * 0.1);

    expect(setCalls).toHaveLength(1);
    const children = (setCalls[0].content as SplitNode).children;
    expect(children[0].fraction).toBeCloseTo(0.4, 6);
    expect(children[1].fraction).toBeCloseTo(0.6, 6);
  });

  it('已卸载插件的残留份额不参与分配:右栏宽按在场份额算', () => {
    currentLayout = treeWithUninstalledResidue();
    renderLayoutRoot();
    // 在场份额 0.3211 / 0.78 = 0.4117 → 683px。按树上原始 fraction 只有 533px。
    const width = screen.getByTestId('w-right-tabs').textContent ?? '';
    const preferredPercent = width.match(
      /^clamp\(120px, ([\d.]+)cqw, calc\(100cqw - 400px\)\)$/,
    )?.[1];
    expect(preferredPercent).toBeDefined();
    expect((Number(preferredPercent) / 100) * AVAIL).toBeCloseTo(683, 0);
    expect(screen.getByTestId('layout-root-content').style.containerType).toBe('inline-size');
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

  it('120px clamp 自愈尚未执行时起拖，也从眼前宽度第一像素跟手', () => {
    const layout = createDefaultLayout();
    const split = layout.content as SplitNode;
    split.children[0].fraction = 0.9;
    split.children[1].fraction = 0.1;
    currentLayout = layout;
    const { container } = renderLayoutRoot(800);
    mockPaneWidth('chat-main', 680);
    mockPaneWidth('right-tabs', 120);

    const grab = container.querySelector('[data-testid="layout-divider"] > div');
    expect(grab).not.toBeNull();
    fireEvent.pointerDown(grab!, { button: 0, pointerId: 1, clientX: 1000 });
    fireEvent.pointerMove(document, { pointerId: 1, clientX: 992 });

    const liveWidth = screen.getByTestId('w-right-tabs').textContent ?? '';
    const liveShare = liveWidth.match(
      /^clamp\(120px, ([\d.]+)cqw, calc\(100cqw - 400px\)\)$/,
    )?.[1];
    expect(Number(liveShare)).toBeCloseTo(16, 6);

    fireEvent.pointerUp(document, { pointerId: 1, clientX: 992 });
    expect(setCalls).toHaveLength(1);
    const committed = (setCalls[0].content as SplitNode).children;
    expect(committed[0].fraction).toBeCloseTo(0.84, 6);
    expect(committed[1].fraction).toBeCloseTo(0.16, 6);
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

  // 2026-07-31 Lizi 实测:右侧栏折叠成 0 宽时拖 chat 变小(反向即拖别的面板变大),
  // chat 到一半就卡。根因:折叠邻居让出的地方被弹性 chat 吸收,chat 实测宽远大于账面
  // (share × avail),旧实现取 min(账面, 实测) 用了低估的账面,把 chat 真实可让空间压没了。
  it('实测宽 > 账面宽(折叠邻居把份额让给了弹性 chat):按实测算可让空间,不被账面卡住', () => {
    currentLayout = createDefaultLayout(); // chat / right 各半
    const split = currentLayout.content as SplitNode;
    split.children[0].fraction = 0.6; // chat:账面 0.6 → 账面宽 996px
    split.children[1].fraction = 0.4; // right-tabs
    const { container } = renderLayoutRoot();
    // 真机:右栏折叠成 ~0,那 0.4 的地方被 chat 吸收 → chat 实测 1200px(账面才 996)。
    const realChatPx = 1200;
    mockPaneWidth('chat-main', realChatPx);
    mockPaneWidth('right-tabs', 0);
    dragDividerLeft(container, 1000); // 一路压缩 chat 到抓不动

    expect(setCalls).toHaveLength(1); // 写树成功,没回弹
    // 修复后按实测算:chat 能让 realPx − 400 = 800px(份额 800/1660),chat 落到约 0.118。
    // 旧实现被账面 996 卡住:只让 min(996,1200)−400 = 596px(份额 0.359),chat 停在 0.241。
    const givenShare = (realChatPx - CHAT_MIN) / AVAIL;
    expect(committedShares()['chat-main'].fraction).toBeCloseTo(0.6 - givenShare, 3);
  });

  // 2026-08-17 实测:装了带面板的插件(insertRootSplitPane 把 chat 份额 0.5→0.4)
  // 且右栏折叠成 0 宽 —— 右栏的 0.4 份额还记在账上,画面那块被弹性 chat 吸收
  // (chat 实测 1328px)。旧口径里 chat 的可让空间被自己的 0.05 账本地板提前夹死,
  // 缝停在 chat ≈ 747px 处,压不到 400px 产品下限;修复后差额由折叠右栏接力出账。
  it('装插件 + 右栏折叠:chat 压到 400px,差额从折叠右栏的账上接力出账', () => {
    const layout = createDefaultLayout();
    const split = layout.content as SplitNode;
    split.children[0].fraction = 0.4; // chat(装入 ghost ×0.8)
    split.children[1].fraction = 0.4; // right-tabs
    split.children.splice(1, 0, {
      fraction: 0.2,
      node: { type: 'pane', id: 'ghost-repro', panelKind: 'ghost:repro' },
    });
    currentLayout = layout;
    registerPanelKind({
      kind: 'ghost:repro',
      collapseMemory: 'global',
      Component: () => <div data-panel-drag-root="ghost:repro" />,
    });
    const { container } = renderLayoutRoot();
    mockPaneWidth('chat-main', 1328); // 吸收了折叠右栏的空间
    mockPaneWidth('right-tabs', 0); // 折叠成 0 宽,账上仍占 0.4
    mockPaneWidth('ghost:repro', 332);
    dragDividerLeft(container, 1000);

    expect(setCalls).toHaveLength(1); // 接力写树成功,没回弹
    const children = (setCalls[0].content as SplitNode).children;
    expect(children[0].fraction).toBeCloseTo(0.05, 3); // chat 先扣到账本下限
    expect(children[1].fraction).toBeCloseTo(0.759, 3); // 收方全额进账
    expect(children[2].fraction).toBeCloseTo(0.191, 3); // 折叠右栏接力出账,仍 ≥ 0.05
    expect(children.reduce((s, c) => s + c.fraction, 0)).toBeCloseTo(1, 6);
    // 画面:chat = AVAIL − ghost 1260 − 折叠右栏 0 = 400,正好产品下限。
    expect((1 - children[1].fraction) * AVAIL).toBeCloseTo(CHAT_MIN, 0);
  });

  // 用户现场树:chat 树份额已被历史拖动顶死在 0.05 下限,右栏折叠着(0.206)。
  // 旧口径下压缩 chat 的账本余量为 0,缝一个像素都拖不动;修复后差额全部由
  // 折叠右栏出账,chat 保住下限、画面落到 400px。
  it('chat 树份额已顶死 0.05 的现场树:缝解冻,差额全部由折叠右栏出账', () => {
    const layout = createDefaultLayout();
    (layout.content as SplitNode).children = [
      { fraction: 0.206, node: { type: 'pane', id: 'right', panelKind: 'right-tabs' } },
      { fraction: 0.122, node: { type: 'pane', id: 'ghost-pr', panelKind: 'ghost:pr' } },
      { fraction: 0.05, node: { type: 'pane', id: 'chat', panelKind: 'chat-main', minWidth: 400 } },
      { fraction: 0.622, node: { type: 'pane', id: 'ghost-canvas', panelKind: 'ghost:canvas' } },
    ];
    currentLayout = layout;
    for (const kind of ['ghost:pr', 'ghost:canvas']) {
      registerPanelKind({
        kind,
        collapseMemory: 'global',
        Component: () => <div data-panel-drag-root={kind} />,
      });
    }
    const { container } = renderLayoutRoot();
    mockPaneWidth('right-tabs', 0); // 折叠
    mockPaneWidth('ghost:pr', 202);
    mockPaneWidth('ghost:canvas', 1033);
    mockPaneWidth('chat-main', 425); // 高于 400,但旧口径一个像素都拖不动
    dragDividerLeftAt(container, 1000, 2); // 第 3 条缝 = chat | ghost:canvas

    expect(setCalls).toHaveLength(1);
    const children = (setCalls[0].content as SplitNode).children;
    const moved = 25 / AVAIL; // chat 实测 425 → 只让 25px 就到产品下限
    expect(children[2].fraction).toBeCloseTo(0.05, 6); // chat 无账可出,保下限
    expect(children[0].fraction).toBeCloseTo(0.206 - moved, 6); // 折叠右栏接力出账
    expect(children[3].fraction).toBeCloseTo(0.622 + moved, 6);
    expect(children.reduce((s, c) => s + c.fraction, 0)).toBeCloseTo(1, 6);
  });
});
