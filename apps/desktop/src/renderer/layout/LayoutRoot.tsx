import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';

import {
  MIN_SPLIT_CHILD_FRACTION,
  transferSplitFraction,
  type Layout,
  type LayoutNode,
  type PaneNode,
} from '../../shared/layoutTree';
import { installGhostDevTools } from '../cindy-brain/ghostDevTools';
import { ensureGhostPanelsRegistered, useGhostPanelsSync } from '../cindy-brain/ghostPanels';
import { isGhostPanelKindMinimized, useGhostPanelBubbleState } from '../lib/ghostPanelBubbleState';
import { isGhostPanelKindDetached, useGhostPanelWindowsState } from '../lib/ghostPanelWindowState';
import { registerBuiltinPanels } from '../panels/builtinPanels';
import { getPanelKind } from '../panels/registry';
import { installLayoutDevTools } from './layoutDevTools';
import { PanelMaximizeContext, type PanelMaximizeState } from './panelMaximize';
import { PaneAtWindowTopProvider, PaneFillProvider } from './panePlacement';
import { PaneWidthProvider, useContentAvailableWidth } from './paneWidths';

/**
 * LayoutRoot —— 主界面布局树的渲染引擎入口。
 *
 * 布局树不变量见 docs/dev-rules/architecture-invariants.md。
 *
 * 职责(随 Step B / C 逐步扩展):
 * - 首帧同步拉取布局(sendSync,规则 7:第一帧就是用户布局,禁止默认→用户布局跳变);
 * - 订阅 layout:changed 热更新(set/reset 后全窗口广播);
 * - 按 content 树渲染 pane 的**顺序与在场**;未注册 kind(未安装的意识残留)
 *   整个 pane 不渲染、空间自然回流;
 * - **分割线与宽度主权**:相邻可见面板之间有且仅有一条引擎分割线,每条
 *   分割线都是拖宽把手 —— 拖动把 delta 在缝两侧邻居的份额之间转移
 *   (只动邻居,其余面板不受影响),拖动中走本地瞬时值实时跟手,松手才写树
 *   持久化;双击缝 = 两侧份额均分。非 chat 面板的像素宽 = **在场份额** × 可用宽
 *   (经 PaneWidthContext 下发,面板消费);chat-main 弹性吸收剩余(flex-1)。
 * - **在场份额(active share)**:树上的 fraction 是"全体 pane"的账本,而不渲染的
 *   pane(未安装残留 / 已抽离 / 已最小化成气泡)那份地方实际被弹性的 chat 吸收 ——
 *   账本与画面脱钩后,像素换算与拖缝余量全都失真。引擎因此一律按
 *   `share = fraction / Σ在场 fraction` 计算(见 activeSplitLedger),隐藏面板的
 *   fraction 一字不动(位置与宽度记忆保留,重装/合并/恢复即原位复活,
 *   architecture-invariants §3)。
 *
 * 实现细节 —— root split 扁平化:根分割不产生容器 div,children(含分割线)
 * 直接吐进父容器(MainLayout 的 row flex div)。嵌套 split 走通用容器渲染,
 * 其分割线暂为静态(嵌套布局今天不存在,交互化随真实需求补)。
 */

/** 可用宽兜底(MainLayout 测量尚未就绪的首帧)。 */
const AVAILABLE_WIDTH_FALLBACK = 1200;
/** chat-main 的最小像素宽(与 <main> 的 min-w-[400px] 对齐)。 */
const CHAT_MIN_PX = 400;
/**
 * 非 chat 面板的兜底最小宽(2026-07-09 Lizi 定案:**只有聊天区有硬下限,
 * 其它面板一律自由拉**)。这个值不是产品下限,只防"拖到窄得抓不住把手/
 * 标准头挤爆";manifest 与树上的 minWidth 自此降级为注入时的初始宽度参考,
 * 不再参与拖缝钳制与渲染 clamp。
 */
const NON_CHAT_FLOOR_PX = 120;

/**
 * pane 是否在本窗口渲染:未注册 kind(未安装/停用的插件残留)、已抽离进
 * 独立窗口、以及已最小化为浮动气泡的面板都不渲染 —— 树数据一律保留,
 * 重装/合并/恢复即原位复活(architecture-invariants「已抽离的面板允许保留
 * 在存档中但不渲染」)。
 */
function isPanelKindVisible(kind: string): boolean {
  return (
    getPanelKind(kind) !== null &&
    !isGhostPanelKindDetached(kind) &&
    !isGhostPanelKindMinimized(kind)
  );
}

/** 单个 pane 的挂载点:查注册表渲染;不可见 kind = 隐藏(数据保留在树里)。 */
function PanelHost({
  node,
  fill = false,
  atWindowTop = true,
}: {
  node: PaneNode;
  fill?: boolean;
  atWindowTop?: boolean;
}): ReactNode {
  const def = getPanelKind(node.panelKind);
  if (!def || !isPanelKindVisible(node.panelKind)) return null;
  const Component = def.Component;
  return (
    <PaneAtWindowTopProvider value={atWindowTop}>
      <PaneFillProvider value={fill}>
        <Component paneId={node.id} />
      </PaneFillProvider>
    </PaneAtWindowTopProvider>
  );
}

interface SplitChildEntry {
  treeIndex: number;
  /** 树上的原始份额(写树寻址用)。 */
  fraction: number;
  /** 在场份额:只在渲染中的兄弟之间分配 100%(Σ在场 share = 1)。渲染与拖缝都用它。 */
  share: number;
  node: LayoutNode;
}

interface ActiveSplitLedger {
  /** 在场子项(未注册/已抽离/已最小化的 pane 已剔除),保留树内原始下标。 */
  entries: SplitChildEntry[];
  /**
   * Σ在场 fraction —— 在场份额与树份额之间的比例尺:`树份额 = share × scale`。
   * 缝把手把份额增量写回树时必须乘它,否则隐藏面板占着的那份会被重复计算。
   */
  scale: number;
}

/** split 只有至少一个后代 pane 在场时才占布局空间。 */
function isLayoutNodeVisible(node: LayoutNode): boolean {
  if (node.type === 'pane') return isPanelKindVisible(node.panelKind);
  return node.children.some((child) => isLayoutNodeVisible(child.node));
}

/**
 * 在场份额账本:过滤出可见子项并把份额在它们之间归一化(见文件头「在场份额」)。
 * 隐藏子项的 fraction 不参与分配、也不被改写。
 */
function activeSplitLedger(children: { fraction: number; node: LayoutNode }[]): ActiveSplitLedger {
  const visible = children
    .map((c, treeIndex) => ({ treeIndex, fraction: c.fraction, node: c.node }))
    .filter((e) => isLayoutNodeVisible(e.node));
  const scale = visible.reduce((sum, e) => sum + e.fraction, 0);
  return {
    scale,
    entries: visible.map((e) => ({
      ...e,
      // scale 异常(空分割 / 全零份额)时退化为均分,不产出 NaN 宽度。
      share: scale > 0 ? e.fraction / scale : 1 / Math.max(1, visible.length),
    })),
  };
}

/** 过滤出可见子项(未注册/已抽离 kind 的 pane 不可见),保留树内原始下标供 fraction 操作寻址。 */
function visibleSplitChildren(
  children: { fraction: number; node: LayoutNode }[],
): SplitChildEntry[] {
  return activeSplitLedger(children).entries;
}

/** 面板的最小像素宽:chat 硬下限 400,其余只有防拖丢兜底(见 NON_CHAT_FLOOR_PX)。 */
function paneMinPx(node: LayoutNode): number {
  if (node.type === 'pane' && node.panelKind === 'chat-main') return CHAT_MIN_PX;
  if (node.type === 'pane') return NON_CHAT_FLOOR_PX;
  const childMins = node.children.map((child) => paneMinPx(child.node));
  return node.direction === 'row'
    ? childMins.reduce((sum, value) => sum + value, 0)
    : Math.max(NON_CHAT_FLOOR_PX, ...childMins);
}

/**
 * 布局自愈(纯函数):把"份额折算像素低于面板最小宽"的非 chat 面板份额抬到
 * 最小宽对应值,差额由弹性的 chat 捐出;无需修正返回 null。
 *
 * 为什么需要:树里的份额可以合法地低于最小宽折算值(装入时的初始份额在小
 * 窗口下不够、历史操作残留等),渲染端的 clamp 保底会让**画面(240px)与
 * 账本(fraction)对不上** —— 拖缝按账本起步,就出现"先空拖一段、面板突然
 * 跳大"的体感(2026-07-08 Lizi 实测)。自愈让两者始终一致,拖动从第一像素
 * 就跟手。chat 捐到自身最小宽以下时放弃(极端小窗口,保底 clamp 兜底)。
 *
 * 判定与写回都在**在场份额**口径上做(见文件头):隐藏 pane 占着的份额不算在
 * 谁头上,否则会把画面其实够宽的面板误判成"吃不饱"而无谓改写账本。
 */
export function normalizeSubMinFractions(
  layout: Layout,
  avail: number,
  isRegistered: (kind: string) => boolean,
): Layout | null {
  if (layout.content.type !== 'split' || layout.content.direction !== 'row') return null;
  const children = layout.content.children;
  const chatIndex = children.findIndex(
    (c) => c.node.type === 'pane' && c.node.panelKind === 'chat-main',
  );
  if (chatIndex < 0) return null;
  const nodeIsRegistered = (node: LayoutNode): boolean =>
    node.type === 'pane'
      ? isRegistered(node.panelKind)
      : node.children.some((child) => nodeIsRegistered(child.node));
  // 在场份额的比例尺(share × scale = 树份额)。此处不能复用 activeSplitLedger:
  // 自愈是纯函数,可见性判定由入参 isRegistered 提供(测试注入)。
  const scale = children
    .filter((c) => nodeIsRegistered(c.node))
    .reduce((sum, c) => sum + c.fraction, 0);
  if (!(scale > 0)) return null;

  let neededTotal = 0; // 在场份额口径的缺口总额
  const bumps = new Map<number, number>(); // treeIndex → 目标在场份额
  children.forEach((child, index) => {
    const node = child.node;
    if (node.type === 'pane' && node.panelKind === 'chat-main') return;
    if (!nodeIsRegistered(node)) return; // 隐藏面板/空 grid 不渲染,不参与自愈
    const minShare = paneMinPx(node) / avail;
    const share = child.fraction / scale;
    if (share >= minShare) return;
    bumps.set(index, minShare);
    neededTotal += minShare - share;
  });
  if (bumps.size === 0) return null;

  const chatAfter = children[chatIndex].fraction / scale - neededTotal;
  if (chatAfter * avail < CHAT_MIN_PX) return null; // 窗口真不够宽,维持 clamp 保底

  const next = structuredClone(layout);
  const nextChildren = (next.content as { children: { fraction: number }[] }).children;
  // 回写乘 scale:在场份额之和保持为 scale,隐藏面板那份不受影响,整树仍归一。
  for (const [index, target] of bumps) nextChildren[index].fraction = target * scale;
  nextChildren[chatIndex].fraction = chatAfter * scale;
  return next;
}

/**
 * 按树(+ 拖动中的瞬时覆盖)计算根分割里各非 chat 面板的像素宽 = **在场份额** ×
 * 可用宽。chat-main 不进表(弹性 flex-1 吸收剩余);上限给中间留出 chat 的最小宽。
 * live 覆盖里存的同样是在场份额(拖动与渲染同一口径)。
 */
interface RootWidthState {
  panelWidths: Record<string, number>;
  splitWidths: Record<string, number>;
}

function computeRootWidths(
  layout: Layout,
  live: Record<string, number> | null,
  avail: number,
): RootWidthState {
  const panelWidths: Record<string, number> = {};
  const splitWidths: Record<string, number> = {};
  if (layout.content.type !== 'split' || layout.content.direction !== 'row') {
    return { panelWidths, splitWidths };
  }
  for (const entry of visibleSplitChildren(layout.content.children)) {
    const node = entry.node;
    if (node.type === 'pane' && node.panelKind === 'chat-main') continue;
    const share = live?.[node.id] ?? entry.share;
    const min = paneMinPx(node);
    const max = Math.max(min, avail - CHAT_MIN_PX);
    const width = Math.min(max, Math.max(min, Math.round(share * avail)));
    if (node.type === 'pane') panelWidths[node.panelKind] = width;
    else splitWidths[node.id] = width;
  }
  return { panelWidths, splitWidths };
}

/** 嵌套 split 用的静态分割线(嵌套布局今天不存在;交互化随真实需求补)。 */
function StaticDivider({ direction, id }: { direction: 'row' | 'column'; id: string }): ReactNode {
  return (
    <div
      aria-hidden
      data-testid="layout-divider"
      key={`divider-${id}`}
      className={direction === 'row' ? 'layout-divider-v' : 'layout-divider-h'}
    />
  );
}

function containsPanelKind(node: LayoutNode, kind: string): boolean {
  if (node.type === 'pane') return node.panelKind === kind;
  return node.children.some((child) => containsPanelKind(child.node, kind));
}

interface NodeViewProps {
  node: LayoutNode;
  fillPane?: boolean;
  atWindowTop?: boolean;
  liveFractions: Record<string, number> | null;
  maximizedKind: string | null;
  onLive: (live: Record<string, number> | null) => void;
  onCommitted: (layout: Layout) => void;
}

/** 递归节点渲染:pane → PanelHost;column split → 插件 grid + 可拖横缝。 */
function NodeView({
  node,
  fillPane = false,
  atWindowTop = true,
  liveFractions,
  maximizedKind,
  onLive,
  onCommitted,
}: NodeViewProps): ReactNode {
  const splitRef = useRef<HTMLDivElement>(null);
  if (node.type === 'pane') {
    return <PanelHost node={node} fill={fillPane} atWindowTop={atWindowTop} />;
  }
  const ledger = activeSplitLedger(node.children);
  const visible = ledger.entries;
  const items: ReactNode[] = [];
  visible.forEach((entry, i) => {
    const entryHasMaximized =
      maximizedKind !== null && containsPanelKind(entry.node, maximizedKind);
    if (i > 0 && maximizedKind === null) {
      const previous = visible[i - 1];
      items.push(
        node.direction === 'column' ? (
          <ColumnDivider
            key={`divider-${entry.node.id}`}
            splitId={node.id}
            top={previous}
            bottom={entry}
            containerRef={splitRef}
            shareScale={ledger.scale}
            onLive={onLive}
            onCommitted={onCommitted}
          />
        ) : (
          <StaticDivider
            key={`divider-${entry.node.id}`}
            direction={node.direction}
            id={entry.node.id}
          />
        ),
      );
    }
    const share = liveFractions?.[entry.node.id] ?? entry.share;
    const hiddenByMaximize = maximizedKind !== null && !entryHasMaximized;
    const childAtWindowTop =
      atWindowTop &&
      (node.direction === 'row' ||
        (maximizedKind !== null ? entryHasMaximized : i === 0));
    items.push(
      <div
        key={entry.node.id}
        data-layout-node-id={entry.node.id}
        className={`flex min-h-0 min-w-0 overflow-hidden ${
          node.direction === 'column' ? 'w-full flex-col' : 'h-full flex-row'
        } ${entryHasMaximized ? 'flex-1' : 'flex-none'}`}
        style={
          hiddenByMaximize
            ? node.direction === 'column'
              ? { height: 0 }
              : { width: 0 }
            : entryHasMaximized
              ? undefined
              : { flexBasis: `${share * 100}%` }
        }
      >
        <NodeView
          node={entry.node}
          fillPane
          atWindowTop={childAtWindowTop}
          liveFractions={liveFractions}
          maximizedKind={maximizedKind}
          onLive={onLive}
          onCommitted={onCommitted}
        />
      </div>,
    );
  });
  return (
    <div
      ref={splitRef}
      data-layout-node-id={node.id}
      className={`flex min-h-0 min-w-0 flex-1 ${node.direction === 'row' ? 'flex-row' : 'flex-col'}`}
    >
      {items}
    </div>
  );
}

interface RootDividerPropsExtra {
  /**
   * chat-main 渲染宽的**账本估值**(px,仅兜底用):可用宽 − 各在场非 chat 面板
   * 宽度之和。起拖时优先实测 chat-main 元素矩形(一次布局读取,符合起拖测量
   * 口径),量不到(测试环境等)才回落本值。
   */
  chatRenderedPx: number;
  /**
   * 在场份额与树份额的比例尺(Σ在场 fraction)。份额增量写回树时要乘它 ——
   * 隐藏面板占着的那份不参与分配,也不该被拖动改写(见文件头「在场份额」)。
   */
  shareScale: number;
}

interface RootDividerProps extends RootDividerPropsExtra {
  splitId: string;
  left: SplitChildEntry;
  right: SplitChildEntry;
  avail: number;
  /** 拖动中的瞬时**在场份额**覆盖(paneId → share);null = 结束。 */
  onLive: (live: Record<string, number> | null) => void;
  /** 提交后的乐观本地树更新(广播随后回声同一棵树)。 */
  onCommitted: (layout: Layout) => void;
}

/** 起拖时实测某布局节点的宽；split 量自己的 grid 列壳，pane 量标准拖拽根。 */
function measuredPanePx(node: LayoutNode): number | null {
  const selector =
    node.type === 'pane'
      ? `[data-panel-drag-root="${node.panelKind}"]`
      : `[data-layout-node-id="${node.id}"]`;
  const width = document.querySelector(selector)?.getBoundingClientRect().width;
  return typeof width === 'number' && width > 0 ? width : null;
}

/**
 * 根分割的交互式分割线:1px 缝 + 7px 隐形抓握区。拖动在缝两侧邻居之间转移
 * 在场份额(三重余量夹取,见 sideRoomShare),拖动中只更新瞬时覆盖(不写 IPC),
 * 松手经 transferSplitFraction 一次性写树;双击 = 两侧份额均分。
 */
function RootDivider({
  splitId,
  left,
  right,
  avail,
  chatRenderedPx,
  shareScale,
  onLive,
  onCommitted,
}: RootDividerProps): ReactNode {
  const [hover, setHover] = useState(false);
  const draggingRef = useRef(false);

  /** amountToLeft:**在场份额**增量(> 0 = 左侧变宽);写树前乘 shareScale 换成树份额。 */
  const commit = (amountToLeft: number) => {
    const treeAmount = amountToLeft * shareScale;
    if (treeAmount === 0) return;
    try {
      const current = window.electronAPI.layout.getStateSync().layout;
      const op =
        treeAmount > 0
          ? transferSplitFraction(current, splitId, right.treeIndex, left.treeIndex, treeAmount)
          : transferSplitFraction(current, splitId, left.treeIndex, right.treeIndex, -treeAmount);
      if (!op.applied) return;
      onCommitted(op.layout);
      void window.electronAPI.layout.set(op.layout).catch(() => undefined);
    } catch {
      // IPC 不可用 —— 放弃本次持久化,界面维持树值
    }
  };

  /**
   * 一侧能让出的份额余量 = min(可让像素余量, 账本地板余量),两条都不能越:
   * - **可让像素余量** 该面板当前宽 − 面板最小宽。**量得到实测宽就以实测为准** ——
   *   账面(share × avail)两头都会错:面板被 CSS 收成 0 宽(折叠态)或被 min-width
   *   顶住时账面**高估**;弹性 chat 吸收了折叠邻居(如收起的右侧栏)让出的地方时,
   *   那份空间记在邻居账上、画面却归了 chat,账面又**低估** chat 能让的地方。
   *   (2026-07-31 Lizi 实测:右侧栏折叠成 0 宽时拖别的面板变大,chat 到一半就卡 ——
   *   旧实现取 min(账面, 实测) 用了低估的账面,把 chat 真实可让空间压没了。)
   *   量不到实测(jsdom / 元素未挂载)才回退,并对回退值保留 min(账面, 回退) 下限
   *   ——历史行为,避免无实测时凭账面高估空拖一段。
   * - **地板余量** (树份额 − 0.05) / scale:transferSplitFraction 对让某一侧跌破
   *   0.05 的转移整单拒绝 —— 实时拖动必须同受此限,否则松手写树失败、整段位移
   *   作废,界面弹回原宽(2026-07-29 Lizi 实测右栏拖到最大就回弹的根因:树里
   *   躺着一条已卸载插件的残留份额,聊天区吸收了它的地方,账面却还记在它头上)。
   */
  const sideRoomShare = (entry: SplitChildEntry, fallbackPx: number | null): number => {
    if (!(avail > 0)) return 0; // 可用宽异常:不给余量,免得 0/0 产出 NaN 份额
    const minPx = paneMinPx(entry.node);
    const ledgerPx = entry.share * avail;
    const measured = measuredPanePx(entry.node);
    // 实测可信直接用;量不到才回退账面/兜底,并保留 min 下限(与历史一致,不扰动)。
    const basisPx = measured ?? Math.min(ledgerPx, fallbackPx ?? ledgerPx);
    const pxRoom = basisPx - minPx;
    const floorRoom = shareScale > 0 ? (entry.fraction - MIN_SPLIT_CHILD_FRACTION) / shareScale : 0;
    return Math.max(0, Math.min(pxRoom / avail, floorRoom));
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || draggingRef.current) return;
    e.preventDefault();
    draggingRef.current = true;
    const startX = e.clientX;
    const startL = left.share;
    const startR = right.share;
    const isChat = (node: LayoutNode) => node.type === 'pane' && node.panelKind === 'chat-main';
    // 起拖只量一次(拖动期间界面静止,没有失效场景);chat 量不到时回落账本估值。
    const dMin = -sideRoomShare(left, isChat(left.node) ? chatRenderedPx : null);
    const dMax = sideRoomShare(right, isChat(right.node) ? chatRenderedPx : null);
    let lastD = 0;

    document.body.classList.add('resizing-pane');
    const prevUserSelect = document.body.style.userSelect;
    const prevCursor = document.documentElement.style.cursor;
    document.body.style.userSelect = 'none';
    document.documentElement.style.cursor = 'col-resize';

    const onMove = (me: PointerEvent) => {
      const d = Math.min(dMax, Math.max(dMin, (me.clientX - startX) / avail));
      lastD = d;
      onLive({ [left.node.id]: startL + d, [right.node.id]: startR - d });
    };
    const finish = (commitIt: boolean) => {
      draggingRef.current = false;
      document.body.classList.remove('resizing-pane');
      document.body.style.userSelect = prevUserSelect;
      document.documentElement.style.cursor = prevCursor;
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onCancel);
      if (commitIt && lastD !== 0) commit(lastD);
      onLive(null);
    };
    const onUp = () => finish(true);
    const onCancel = () => finish(false);
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onCancel);
  };

  // 双击:两侧份额均分(把差值的一半转给少的一侧)—— 右栏旧"双击复位 50/50"
  // 在两块布局下的语义等价推广。在场份额口径:均分的是**画面上**这两块的宽度。
  const onDoubleClick = () => {
    const total = left.share + right.share;
    commit(total / 2 - left.share);
  };

  return (
    <div
      aria-hidden
      data-testid="layout-divider"
      className="layout-divider-v relative"
      // hover 高亮与左栏拖宽把手同款取色;该 token 是 HSL 三元组,必须 hsl() 包裹
      // (裸引用会产出非法 CSS 整条失效 → 透明,规则 16 点名的坑,实测踩过)。
      style={hover ? { background: 'hsl(var(--sidebar-action-icon))' } : undefined}
    >
      {/* 隐形抓握区:比 1px 缝宽,悬停变色提示可拖;no-drag 保证收到指针事件。 */}
      <div
        className="absolute inset-y-0 left-[-3px] z-10 w-[7px] cursor-col-resize"
        style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
        onPointerEnter={() => setHover(true)}
        onPointerLeave={() => setHover(false)}
        onPointerDown={onPointerDown}
        onDoubleClick={onDoubleClick}
      />
    </div>
  );
}

const GRID_PANE_MIN_HEIGHT_PX = 120;

interface ColumnDividerProps {
  splitId: string;
  top: SplitChildEntry;
  bottom: SplitChildEntry;
  containerRef: React.RefObject<HTMLDivElement | null>;
  shareScale: number;
  onLive: (live: Record<string, number> | null) => void;
  onCommitted: (layout: Layout) => void;
}

/** 插件 grid 的横向分割线：拖动调高度，双击均分相邻两格。 */
function ColumnDivider({
  splitId,
  top,
  bottom,
  containerRef,
  shareScale,
  onLive,
  onCommitted,
}: ColumnDividerProps): ReactNode {
  const [hover, setHover] = useState(false);
  const draggingRef = useRef(false);

  const commit = (amountToTop: number) => {
    const treeAmount = amountToTop * shareScale;
    if (treeAmount === 0) return;
    try {
      const current = window.electronAPI.layout.getStateSync().layout;
      const op =
        treeAmount > 0
          ? transferSplitFraction(current, splitId, bottom.treeIndex, top.treeIndex, treeAmount)
          : transferSplitFraction(current, splitId, top.treeIndex, bottom.treeIndex, -treeAmount);
      if (!op.applied) return;
      onCommitted(op.layout);
      void window.electronAPI.layout.set(op.layout).catch(() => undefined);
    } catch {
      // IPC 不可用时放弃本次持久化，广播/树值保持原状。
    }
  };

  const onPointerDown = (event: React.PointerEvent) => {
    if (event.button !== 0 || draggingRef.current) return;
    const available = containerRef.current?.getBoundingClientRect().height ?? 0;
    if (!(available > 0)) return;
    event.preventDefault();
    draggingRef.current = true;
    const startY = event.clientY;
    const startTop = top.share;
    const startBottom = bottom.share;
    const topRoom = Math.max(
      0,
      Math.min(
        startTop - GRID_PANE_MIN_HEIGHT_PX / available,
        shareScale > 0 ? (top.fraction - MIN_SPLIT_CHILD_FRACTION) / shareScale : 0,
      ),
    );
    const bottomRoom = Math.max(
      0,
      Math.min(
        startBottom - GRID_PANE_MIN_HEIGHT_PX / available,
        shareScale > 0 ? (bottom.fraction - MIN_SPLIT_CHILD_FRACTION) / shareScale : 0,
      ),
    );
    let lastDelta = 0;

    document.body.classList.add('resizing-pane');
    const previousUserSelect = document.body.style.userSelect;
    const previousCursor = document.documentElement.style.cursor;
    document.body.style.userSelect = 'none';
    document.documentElement.style.cursor = 'row-resize';

    const onMove = (moveEvent: PointerEvent) => {
      const delta = Math.min(
        bottomRoom,
        Math.max(-topRoom, (moveEvent.clientY - startY) / available),
      );
      lastDelta = delta;
      onLive({ [top.node.id]: startTop + delta, [bottom.node.id]: startBottom - delta });
    };
    const finish = (commitChange: boolean) => {
      draggingRef.current = false;
      document.body.classList.remove('resizing-pane');
      document.body.style.userSelect = previousUserSelect;
      document.documentElement.style.cursor = previousCursor;
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onCancel);
      if (commitChange && lastDelta !== 0) commit(lastDelta);
      onLive(null);
    };
    const onUp = () => finish(true);
    const onCancel = () => finish(false);
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onCancel);
  };

  const onDoubleClick = () => {
    const total = top.share + bottom.share;
    commit(total / 2 - top.share);
  };

  return (
    <div
      aria-hidden
      data-testid="layout-divider"
      className="layout-divider-h relative"
      style={hover ? { background: 'hsl(var(--sidebar-action-icon))' } : undefined}
    >
      <div
        className="absolute inset-x-0 top-[-3px] z-10 h-[7px] cursor-row-resize"
        style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
        onPointerEnter={() => setHover(true)}
        onPointerLeave={() => setHover(false)}
        onPointerDown={onPointerDown}
        onDoubleClick={onDoubleClick}
      />
    </div>
  );
}

interface LayoutRootProps {
  /**
   * 内容区被全屏路由接管中(如设置页):只渲染 chat-main(接管方的宿主),
   * 其余面板连同分割线全部不渲染;布局树数据不动,退出接管即原样恢复。
   * 右栏在设置页的隐藏靠 bridge 置空,意识面板没有那层约定 —— 这是引擎级的
   * 统一开关(2026-07-08 Lizi 实测:设置页右缘冒出意识面板)。
   */
  suppressNonChatPanels?: boolean;
}

export function LayoutRoot({ suppressNonChatPanels = false }: LayoutRootProps = {}): ReactNode {
  // 幂等注册内置面板 —— 放组件体而非模块副作用:HMR / 测试 reset 后再渲染也能自愈。
  registerBuiltinPanels();
  // 已装意识的面板首帧前同步注册:与内置面板同帧就位;未装意识的存档残留
  // pane 按"未安装意识"隐藏,树数据保留以便重新安装时原位恢复。
  ensureGhostPanelsRegistered();
  // dev-only:挂 window.__cindyLayout 调试入口(swap/reset/removePane)。
  installLayoutDevTools();
  // dev-only:挂 window.__cindyGhosts 调试入口(list/install/uninstall,QA 通道)。
  installGhostDevTools();

  // 装/卸广播 → 注册表对齐 + 重渲(卸下不动布局树,靠这里让引擎重过滤在场面板)。
  const ghostSyncVersion = useGhostPanelsSync();
  // 抽离/气泡状态变化 → 重渲(isPanelKindVisible 读的是模块级镜像,靠这两个
  // hook 感知变化)。
  const ghostWindowsState = useGhostPanelWindowsState();
  const ghostBubbleState = useGhostPanelBubbleState();

  // 首帧同步读取(sendSync):布局在第一帧就位,不出现默认布局闪现。
  const [layout, setLayout] = useState<Layout>(
    () => window.electronAPI.layout.getStateSync().layout,
  );
  useEffect(() => window.electronAPI.layout.onChanged(({ layout: next }) => setLayout(next)), []);

  // 撑满态(panelMaximize.tsx):会话级视图态,树账本不动。同 kind 再点还原。
  const [maximizedKind, setMaximizedKind] = useState<string | null>(null);
  const maximizeCtx = useMemo<PanelMaximizeState>(
    () => ({
      maximizedKind,
      toggle: (kind) => setMaximizedKind((cur) => (cur === kind ? null : kind)),
    }),
    [maximizedKind],
  );

  // 分割线拖动中的瞬时**在场份额**覆盖(paneId → share);面板宽度实时跟手,
  // 松手清空回落树值 —— 拖动全程不写 IPC。
  const [liveFractions, setLiveFractions] = useState<Record<string, number> | null>(null);
  const availCtx = useContentAvailableWidth();
  const avail = availCtx ?? AVAILABLE_WIDTH_FALLBACK;
  // eslint 会说 ghostWindowsState 没被直接读——它是 computeRootWidths 里
  // isPanelKindVisible 的隐式数据源(模块级镜像),必须进 deps 才能感知抽离变化。
  const rootWidths = useMemo(
    () => computeRootWidths(layout, liveFractions, avail),
    [layout, liveFractions, avail, ghostBubbleState, ghostSyncVersion, ghostWindowsState],
  );
  // chat 实际渲染宽 ≈ 可用宽 − 各在场非 chat 面板宽度之和(拖缝余量的兜底估值,
  // 见 RootDividerPropsExtra;起拖优先实测元素矩形)。
  const chatRenderedPx = Math.max(
    CHAT_MIN_PX,
    avail -
      [...Object.values(rootWidths.panelWidths), ...Object.values(rootWidths.splitWidths)].reduce(
        (sum, width) => sum + width,
        0,
      ),
  );

  // 布局自愈:份额吃不饱最小宽 → 抬到位、chat 捐差额并写回树(画面与账本一致,
  // 拖缝零跳变;详见 normalizeSubMinFractions)。250ms 防抖合并连续变化(装入
  // 广播、窗口缩放);拖动中不打扰;可用宽未测得(context null)时不动账本。
  useEffect(() => {
    // 接管态下可用宽是接管方的(设置页全宽),按它改账本会失真 —— 不自愈。
    if (suppressNonChatPanels || availCtx === null || liveFractions !== null) return;
    const timer = setTimeout(() => {
      const fixed = normalizeSubMinFractions(layout, availCtx, isPanelKindVisible);
      if (!fixed) return;
      setLayout(fixed);
      void window.electronAPI.layout.set(fixed).catch(() => undefined);
    }, 250);
    return () => clearTimeout(timer);
  }, [
    availCtx,
    ghostBubbleState,
    ghostSyncVersion,
    ghostWindowsState,
    layout,
    liveFractions,
    suppressNonChatPanels,
  ]);

  // 撑满目标失效自动还原:面板被卸下/停用(kind 注销)、抽离进独立窗口或
  // pane 离开树时清态,免得下次回来以陈年撑满态惊回。接管态(设置页)只是
  // 暂不渲染,不清 —— 退出接管原样恢复。
  useEffect(() => {
    if (maximizedKind === null || suppressNonChatPanels) return;
    const present =
      containsPanelKind(layout.content, maximizedKind) && isPanelKindVisible(maximizedKind);
    if (!present) setMaximizedKind(null);
  }, [
    layout,
    ghostBubbleState,
    ghostSyncVersion,
    ghostWindowsState,
    maximizedKind,
    suppressNonChatPanels,
  ]);

  const content = layout.content;
  let body: ReactNode;
  if (content.type === 'split') {
    // root split 扁平化(见文件头注释):children(含交互式分割线)直接作为父 row
    // 容器的 flex 子项。接管态只留 chat-main(见 LayoutRootProps)。
    const ledger = activeSplitLedger(content.children);
    const visible = ledger.entries.filter(
      (e) => !suppressNonChatPanels || (e.node.type === 'pane' && e.node.panelKind === 'chat-main'),
    );
    // 撑满态:目标 pane 独占一行(自身经 PanelMaximizeContext 切成 flex-1),
    // 兄弟收成 0 宽裁切 —— 保持挂载不动 display:webview 卸载丢 webContents,
    // display:none 对 webview 也不友好;分割线整组不画。树账本(fraction/顺序)
    // 一字不动,还原即回原样 —— 不触碰布局树结构不变量(chat-main 仍在树中,
    // 与 RSB maximize 隐藏主区同档的视图态先例)。
    const maximizedEntry =
      maximizedKind === null
        ? undefined
        : visible.find((entry) => containsPanelKind(entry.node, maximizedKind));
    if (maximizedEntry) {
      body = (
        <>
          {visible.map((entry) =>
            entry === maximizedEntry ? (
              <div key={entry.node.id} className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
                <NodeView
                  node={entry.node}
                  liveFractions={liveFractions}
                  maximizedKind={maximizedKind}
                  onLive={setLiveFractions}
                  onCommitted={setLayout}
                />
              </div>
            ) : (
              <div key={entry.node.id} aria-hidden className="flex w-0 flex-none overflow-hidden">
                <NodeView
                  node={entry.node}
                  liveFractions={liveFractions}
                  maximizedKind={maximizedKind}
                  onLive={setLiveFractions}
                  onCommitted={setLayout}
                />
              </div>
            ),
          )}
        </>
      );
      return (
        <PanelMaximizeContext.Provider value={maximizeCtx}>
          <PaneWidthProvider value={rootWidths.panelWidths}>{body}</PaneWidthProvider>
        </PanelMaximizeContext.Provider>
      );
    }
    const items: ReactNode[] = [];
    visible.forEach((entry, i) => {
      if (i > 0) {
        const prev = visible[i - 1];
        if (content.direction === 'row') {
          items.push(
            <RootDivider
              key={`divider-${entry.node.id}`}
              splitId={content.id}
              left={prev}
              right={entry}
              avail={avail}
              chatRenderedPx={chatRenderedPx}
              shareScale={ledger.scale}
              onLive={setLiveFractions}
              onCommitted={setLayout}
            />,
          );
        } else {
          items.push(
            <StaticDivider
              key={`divider-${entry.node.id}`}
              direction={content.direction}
              id={entry.node.id}
            />,
          );
        }
      }
      if (entry.node.type === 'split' && content.direction === 'row') {
        items.push(
          <div
            key={entry.node.id}
            data-layout-root-child-id={entry.node.id}
            className="flex h-full min-h-0 min-w-0 flex-none overflow-hidden"
            style={{ width: rootWidths.splitWidths[entry.node.id] }}
          >
            <NodeView
              node={entry.node}
              fillPane
              liveFractions={liveFractions}
              maximizedKind={null}
              onLive={setLiveFractions}
              onCommitted={setLayout}
            />
          </div>,
        );
      } else {
        items.push(
          <NodeView
            key={entry.node.id}
            node={entry.node}
            liveFractions={liveFractions}
            maximizedKind={null}
            onLive={setLiveFractions}
            onCommitted={setLayout}
          />,
        );
      }
    });
    body = <>{items}</>;
  } else {
    body = (
      <NodeView
        node={content}
        liveFractions={liveFractions}
        maximizedKind={maximizedKind}
        onLive={setLiveFractions}
        onCommitted={setLayout}
      />
    );
  }
  return (
    <PanelMaximizeContext.Provider value={maximizeCtx}>
      <PaneWidthProvider value={rootWidths.panelWidths}>{body}</PaneWidthProvider>
    </PanelMaximizeContext.Provider>
  );
}
