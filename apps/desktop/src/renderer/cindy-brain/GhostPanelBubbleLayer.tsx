/**
 * GhostPanelBubbleLayer —— 最小化插件面板的浮动气泡层(安卓聊天气泡式)。
 *
 * 挂在 MainLayout(GhostMediaLightboxHost 旁),portal 到 document.body:
 *  - 形态(2026-07-31 Lizi 定案,取代此前「1 个直渲单气泡 / ≥2 合并堆叠」
 *    双形态):只要有 ≥1 个「已装 && 启用 && 停靠形态 && 已最小化 && 未抽离
 *    独立窗」的插件,就渲染**一枚**幽灵球(lucide Ghost 脸 + 数量角标),
 *    不再按数量分形态。点球纵向展开各插件自己的气泡(向下,空间不够则
 *    向上),点谁恢复谁的面板;点球或空白处收拢。全部面板都开着(没有
 *    最小化的)整层消失 —— 幽灵球只在有面板可恢复时在场。
 *  - 子气泡脸 = 插件图标(InstalledGhost.iconDataUrl,主窗拿不到
 *    cindy-ghost://,data URL 直接 <img>;缺图标兜底 lucide Ghost);
 *  - 定位用 left/top 而非 transform(2026-07-31 Lizi 实测:草稿页气泡拖
 *    不动):Electron 的 -webkit-app-region 命中区按**布局矩形**计算、不跟随
 *    CSS transform(ChromeActions.tsx 同坑)。气泡浮在窗口拖拽区上(如
 *    草稿页 InvisibleWindowDragStrip 叠在页签条下,覆盖到窗口 36~86px,
 *    正好压住默认停靠位)时 pointerdown 会被系统当成拖窗吞掉;修法是气泡
 *    自身标 no-drag 挖洞,而挖洞矩形要与视觉位置一致就必须用 left/top 定位
 *    ——fixed 定位的 48px 元素改 left/top 重排范围只有自身,热路径可接受;
 *  - 拖拽仍走 PanelDragController 的性能口径:热路径零 React,直改 DOM
 *    (left/top);拖动期间挂 body.resizing-pane 让 webview 指针穿透;4px
 *    阈值区分点击与拖动(windowDrag.tsx 同款);
 *  - 动效时序(2026-07-25 Lizi 定案"两段都要有戏"):收起 → 面板宽度先
 *    折叠到 0,等 300ms 圆圈渐显、幽灵再跳进来;点子气泡展开 → 幽灵先跳走、
 *    圆圈再渐隐,计时器到点(260ms)才真正 restore,面板宽度展开回停靠位
 *    (编排见 globals.css;面板侧提交时序在 ghostPanels.tsx,减弱动效自动停);
 *  - 幽灵球可拖,落点独立持久化,重启保留;没拖过默认停右上角;渲染时
 *    clamp 到视口,y 下限避开顶部 46px 拖动带(视觉习惯位;可点性本身由
 *    no-drag 挖洞保证);展开期间拖球,子气泡跟着实时走(同一条零 React
 *    热路径直改子气泡 DOM,排布算式 stackChildPos 与渲染共用)。
 */

import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Ghost } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { ghostPanelKind, type GhostManifest } from '../../shared/ghost';
import { WINDOW_NO_DRAG_STYLE } from '../components/layout/windowDrag';
import { restoreGhostPanel, useGhostPanelBubbleState } from '../lib/ghostPanelBubbleState';
import { isGhostPanelKindDetached, useGhostPanelWindowsState } from '../lib/ghostPanelWindowState';
import { useInstalledGhosts } from './useInstalledGhosts';

const BUBBLE_SIZE = 48;
const EDGE_MARGIN = 12;
const STACK_GAP = 8;
const DRAG_THRESHOLD_PX = 4;
/** 顶部 46px 是窗口拖动带(§6 规则 3),气泡默认不进去。 */
const TOP_FLOOR = 46 + EDGE_MARGIN;
/** 点子气泡展开:幽灵跳走(160ms)+ 圆圈渐隐(120ms 延迟 + 140ms)的总时长,
 *  到点才真正 restore(与 globals.css 的 exit 编排对齐)。 */
const EXIT_MS = 260;

/** 幽灵球落点的独立持久化键(不进 ghostPanelBubbleState:那张表按 ghostId
 *  归属、由已装清单 reconcile,塞保留键会被当孤儿清掉)。 */
const STACK_POS_KEY = 'xdt:ghostPanelBubbleStack:v1';

function loadStackPos(): { x: number; y: number } | null {
  try {
    const raw = window.localStorage.getItem(STACK_POS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { x?: unknown; y?: unknown };
    if (!Number.isFinite(parsed?.x) || !Number.isFinite(parsed?.y)) return null;
    return { x: Math.round(parsed.x as number), y: Math.round(parsed.y as number) };
  } catch {
    return null;
  }
}

function saveStackPos(x: number, y: number): void {
  try {
    window.localStorage.setItem(STACK_POS_KEY, JSON.stringify({ x, y }));
  } catch {
    // 持久化失败不拦交互(隐私模式等),内存态照常生效
  }
}

/** 视口 clamp(渲染与落点共用;存储里不 clamp,换屏不破坏存值)。 */
function clampToViewport(x: number, y: number): { x: number; y: number } {
  const maxX = Math.max(EDGE_MARGIN, window.innerWidth - BUBBLE_SIZE - EDGE_MARGIN);
  const maxY = Math.max(TOP_FLOOR, window.innerHeight - BUBBLE_SIZE - EDGE_MARGIN);
  return {
    x: Math.min(maxX, Math.max(EDGE_MARGIN, x)),
    y: Math.min(maxY, Math.max(TOP_FLOOR, y)),
  };
}

/** 没拖过的幽灵球默认位:右上角(2026-07-31 Lizi 定案由右下角改到右上角,
 *  TOP_FLOOR 已避开窗口拖动带)。 */
function defaultPosition(): { x: number; y: number } {
  return { x: window.innerWidth - BUBBLE_SIZE - EDGE_MARGIN, y: TOP_FLOOR };
}

/** 直改 DOM 落位(拖拽热路径与基准位回写共用):left/top 而非 transform ——
 *  no-drag 挖洞矩形按布局算,必须与视觉位置一致(见文件头)。 */
function placeBubbleEl(el: HTMLButtonElement, x: number, y: number): void {
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
}

/** 展开的子气泡位:锚点(幽灵球)下方放得下全部就向下排,否则向上;
 *  React 渲染与拖动热路径共用同一套算式,拖到哪儿子气泡就排到哪儿。 */
function stackChildPos(
  anchor: { x: number; y: number },
  index: number,
  count: number,
): { x: number; y: number } {
  const step = BUBBLE_SIZE + STACK_GAP;
  // 两头都放不下时 clamp 兜底,极小窗口下允许压边,不做更复杂的绕排。
  const fitsDown = anchor.y + step * count + BUBBLE_SIZE + EDGE_MARGIN <= window.innerHeight;
  return clampToViewport(anchor.x, anchor.y + (fitsDown ? 1 : -1) * step * (index + 1));
}

/**
 * 幽灵球拖拽:热路径零 React,left/top 直改 DOM;4px 阈值区分点击与拖动;
 * 拖后第一次合成 click 由 consumeDraggedClick 吞掉。
 * onMove 在每步拖动(及取消回滚)时带当前坐标回调,供联动子气泡。
 */
function useBubbleDrag({
  elRef,
  pos,
  onDrop,
  onMove,
}: {
  elRef: RefObject<HTMLButtonElement | null>;
  pos: { x: number; y: number };
  onDrop: (x: number, y: number) => void;
  onMove?: (x: number, y: number) => void;
}) {
  const dragRef = useRef<{
    pointerId: number;
    startClientX: number;
    startClientY: number;
    baseX: number;
    baseY: number;
    dragging: boolean;
    lastX: number;
    lastY: number;
  } | null>(null);
  const draggedRef = useRef(false);

  // 基准位变化(store 更新/默认位重排/窗口缩放)时回写 left/top ——
  // 非拖动期间落位完全由 React 渲染值决定。
  useEffect(() => {
    const el = elRef.current;
    if (el && !dragRef.current?.dragging) placeBubbleEl(el, pos.x, pos.y);
  }, [elRef, pos.x, pos.y]);

  const endDragCleanup = () => {
    document.body.classList.remove('resizing-pane');
    document.body.style.userSelect = '';
  };

  const onPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0 || dragRef.current) return;
    dragRef.current = {
      pointerId: e.pointerId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      baseX: pos.x,
      baseY: pos.y,
      dragging: false,
      lastX: pos.x,
      lastY: pos.y,
    };
    // jsdom 没有 setPointerCapture,包一层照常走点击/拖动逻辑。
    try {
      elRef.current?.setPointerCapture(e.pointerId);
    } catch {
      /* noop */
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    const dx = e.clientX - d.startClientX;
    const dy = e.clientY - d.startClientY;
    if (!d.dragging) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      d.dragging = true;
      // webview 指针穿透 + 禁选中(与拖缝/拖面板同款方案)。
      document.body.classList.add('resizing-pane');
      document.body.style.userSelect = 'none';
    }
    const next = clampToViewport(d.baseX + dx, d.baseY + dy);
    d.lastX = next.x;
    d.lastY = next.y;
    const el = elRef.current;
    if (el) placeBubbleEl(el, next.x, next.y);
    onMove?.(next.x, next.y);
  };

  const finishDrag = (persist: boolean) => {
    const d = dragRef.current;
    if (!d) return;
    dragRef.current = null;
    try {
      elRef.current?.releasePointerCapture(d.pointerId);
    } catch {
      /* noop */
    }
    if (!d.dragging) return; // 纯点击:等 onClick 走各自的激活时序
    endDragCleanup();
    draggedRef.current = true; // 吞掉随后的合成 click
    if (persist) {
      onDrop(d.lastX, d.lastY);
    } else {
      // 取消:回滚到拖前基准位(子气泡也一并滚回去)
      const el = elRef.current;
      if (el) placeBubbleEl(el, d.baseX, d.baseY);
      onMove?.(d.baseX, d.baseY);
    }
  };

  /** 拖后紧随的合成 click 返回 true(调用方直接吞掉)。 */
  const consumeDraggedClick = (): boolean => {
    if (draggedRef.current) {
      draggedRef.current = false;
      return true;
    }
    return false;
  };

  return { onPointerDown, onPointerMove, finishDrag, consumeDraggedClick };
}

interface BubbleProps {
  manifest: GhostManifest;
  iconDataUrl: string | undefined;
  /** 渲染基准位(已按锚点排布 + clamp)。 */
  pos: { x: number; y: number };
  /** 把气泡按钮元素登记给上层(拖幽灵球时热路径直改子气泡落位用)。 */
  registerEl?: (el: HTMLButtonElement | null) => void;
}

/** 展开出的子气泡:不可拖(位置由幽灵球锚定),点击恢复对应面板。 */
function Bubble({ manifest, iconDataUrl, pos, registerEl }: BubbleProps): ReactNode {
  const { t } = useTranslation();
  const [imgBroken, setImgBroken] = useState(false);
  /** 点击后进入"缩没退场"态:播 .ghost-bubble-exit,计时器到点才 restore。 */
  const [exiting, setExiting] = useState(false);
  const exitTimerRef = useRef(0);

  // 卸载时清退场计时器(restore 本身是 store 调用,晚到也无害,但别留悬垂)。
  useEffect(() => () => window.clearTimeout(exitTimerRef.current), []);

  const onClick = () => {
    if (exiting) return;
    // 展开的"过程感":幽灵先跳走、圆圈再渐隐(共 EXIT_MS),到点才真正恢复
    // 面板(面板侧再接宽度展开,见 ghostPanels.tsx 的 ghost-panel-enter)。
    setExiting(true);
    exitTimerRef.current = window.setTimeout(() => restoreGhostPanel(manifest.id), EXIT_MS);
  };

  const name = manifest.panel?.title ?? manifest.name;
  return (
    <button
      ref={(el) => registerEl?.(el)}
      type="button"
      data-testid={`ghost-panel-bubble-${manifest.id}`}
      data-ghost-bubble-layer
      aria-label={t('ghostPanelBubble.restoreAria', { name })}
      title={t('ghostPanelBubble.restoreAria', { name })}
      onClick={onClick}
      // 按钮本体只管位置(left/top)与命中区,不带视觉——圆圈(描边/底色/
      // 阴影)与幽灵分层,动画各编各的(见 globals.css 悬浮球一节)。
      // 描边四轮定(2026-07-25 Lizi):border-default 太浅 → accent-emphasis
      // 太深 → text-tertiary 中间档(亮色中灰/暗色中灰);2px 太粗 → 1px。
      className={`ghost-bubble group fixed z-[9900] flex h-12 w-12 cursor-pointer items-center justify-center ${
        exiting ? 'ghost-bubble-exit' : 'ghost-bubble-enter'
      }`}
      style={{ left: pos.x, top: pos.y, ...WINDOW_NO_DRAG_STYLE }}
    >
      <span
        aria-hidden
        className="ghost-bubble-circle absolute inset-0 rounded-full border border-[var(--text-tertiary)] bg-[var(--surface-elevated)] shadow-xl transition-colors group-hover:bg-[var(--surface-chip)]"
      />
      <span className="ghost-bubble-face-jump relative flex items-center justify-center">
        {iconDataUrl && !imgBroken ? (
          <img
            src={iconDataUrl}
            alt=""
            draggable={false}
            className="h-8 w-8 rounded-full object-cover"
            onError={() => setImgBroken(true)}
          />
        ) : (
          <span className="ghost-bubble-face inline-flex">
            <Ghost size={22} className="text-[var(--text-primary)]" />
          </span>
        )}
      </span>
    </button>
  );
}

/** 幽灵球:被最小化面板的唯一入口(Ghost 脸 + 数量角标),点击切换展开。 */
function StackBubble({
  count,
  pos,
  expanded,
  onToggle,
  onDrop,
  onDragMove,
}: {
  count: number;
  pos: { x: number; y: number };
  expanded: boolean;
  onToggle: () => void;
  onDrop: (x: number, y: number) => void;
  /** 拖动每步回调当前锚点(展开中的子气泡跟着实时走)。 */
  onDragMove?: (x: number, y: number) => void;
}): ReactNode {
  const { t } = useTranslation();
  const elRef = useRef<HTMLButtonElement | null>(null);
  const drag = useBubbleDrag({ elRef, pos, onDrop, onMove: onDragMove });
  const label = expanded
    ? t('ghostPanelBubble.stackCollapseAria')
    : t('ghostPanelBubble.stackExpandAria', { count });
  return (
    <button
      ref={elRef}
      type="button"
      data-testid="ghost-panel-bubble-stack"
      data-ghost-bubble-layer
      aria-label={label}
      title={label}
      aria-expanded={expanded}
      onPointerDown={drag.onPointerDown}
      onPointerMove={drag.onPointerMove}
      onPointerUp={() => drag.finishDrag(true)}
      onPointerCancel={() => drag.finishDrag(false)}
      onClick={() => {
        if (drag.consumeDraggedClick()) return;
        onToggle();
      }}
      className="ghost-bubble ghost-bubble-enter group fixed z-[9900] flex h-12 w-12 cursor-pointer items-center justify-center"
      style={{ left: pos.x, top: pos.y, ...WINDOW_NO_DRAG_STYLE }}
    >
      <span
        aria-hidden
        className="ghost-bubble-circle absolute inset-0 rounded-full border border-[var(--text-tertiary)] bg-[var(--surface-elevated)] shadow-xl transition-colors group-hover:bg-[var(--surface-chip)]"
      />
      <span className="relative flex items-center justify-center">
        <Ghost size={22} className="text-[var(--text-primary)]" />
      </span>
      {/* 数量角标:语义 token 灰阶,不引新强调色(与图钉同纪律)。 */}
      <span
        aria-hidden
        className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full border border-[var(--text-tertiary)] bg-[var(--surface-chip)] px-1 text-[10px] font-medium leading-none text-[var(--text-secondary)]"
      >
        {count}
      </span>
    </button>
  );
}

/** 气泡层:没有最小化面板时不渲染;窗口缩放防抖重渲以重算 clamp/默认位。 */
export function GhostPanelBubbleLayer(): ReactNode {
  const ghosts = useInstalledGhosts();
  const bubbles = useGhostPanelBubbleState();
  // 订阅抽离状态:detach 期间气泡隐藏,合并回来自动复现。
  useGhostPanelWindowsState();
  // 展开态(纯运行时,不落盘;落盘会让"重启后自动摊开一排"变成惊吓)。
  const [expanded, setExpanded] = useState(false);
  const [stackPos, setStackPos] = useState<{ x: number; y: number } | null>(() => loadStackPos());
  // 展开中的子气泡元素表(拖幽灵球时热路径直改落位,不走 React)。
  const childElsRef = useRef(new Map<string, HTMLButtonElement>());

  const [, setResizeTick] = useState(0);
  useEffect(() => {
    let timer = 0;
    const onResize = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setResizeTick((v) => v + 1), 100);
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('resize', onResize);
    };
  }, []);

  const minimized = ghosts.filter(
    (g) =>
      g.enabled !== false &&
      g.manifest.panel !== undefined &&
      g.manifest.panel.position !== 'tab' &&
      bubbles[g.manifest.id]?.minimized === true &&
      !isGhostPanelKindDetached(ghostPanelKind(g.manifest.id)),
  );
  const empty = minimized.length === 0;

  // 整层退场(全部面板都开着)时收拢,防下次出现直接摊开一排。
  useEffect(() => {
    if (empty) setExpanded(false);
  }, [empty]);

  // 展开期间点空白处收拢(气泡都带 data-ghost-bubble-layer;capture 期判定,
  // 不干扰气泡自身的点击/拖拽)。
  useEffect(() => {
    if (empty || !expanded) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target;
      if (target instanceof Element && target.closest('[data-ghost-bubble-layer]')) return;
      setExpanded(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [empty, expanded]);

  if (empty) return null;

  const anchor = clampToViewport(
    stackPos?.x ?? defaultPosition().x,
    stackPos?.y ?? defaultPosition().y,
  );
  // 拖幽灵球的每一步把展开中的子气泡一起带走(同一条零 React 热路径)。
  const onStackDragMove = (x: number, y: number) => {
    minimized.forEach((g, index) => {
      const el = childElsRef.current.get(g.manifest.id);
      if (!el) return;
      const p = stackChildPos({ x, y }, index, minimized.length);
      placeBubbleEl(el, p.x, p.y);
    });
  };
  return createPortal(
    <>
      <StackBubble
        count={minimized.length}
        pos={anchor}
        expanded={expanded}
        onToggle={() => setExpanded((v) => !v)}
        onDrop={(x, y) => {
          saveStackPos(x, y);
          setStackPos({ x, y });
        }}
        onDragMove={onStackDragMove}
      />
      {expanded
        ? minimized.map((g, index) => (
            <Bubble
              key={g.manifest.id}
              manifest={g.manifest}
              iconDataUrl={g.iconDataUrl}
              pos={stackChildPos(anchor, index, minimized.length)}
              registerEl={(el) => {
                if (el) childElsRef.current.set(g.manifest.id, el);
                else childElsRef.current.delete(g.manifest.id);
              }}
            />
          ))
        : null}
    </>,
    document.body,
  );
}
