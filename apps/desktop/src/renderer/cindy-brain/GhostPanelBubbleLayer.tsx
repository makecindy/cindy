/**
 * GhostPanelBubbleLayer —— 最小化插件面板的浮动气泡层(安卓聊天气泡式)。
 *
 * 挂在 MainLayout(GhostMediaLightboxHost 旁),portal 到 document.body:
 *  - 每个「已装 && 启用 && 停靠形态 && 已最小化 && 未抽离独立窗」的插件
 *    一枚 48px 圆形气泡,z-[9900](在内容 chrome 之上、拖拽浮层 9998/9999
 *    与弹窗 10000+ 之下);
 *  - 脸 = 插件图标(InstalledGhost.iconDataUrl,主窗拿不到 cindy-ghost://,
 *    data URL 直接 <img>;缺图标兜底 lucide Ghost);
 *  - 拖拽走 PanelDragController 的性能口径:热路径零 React,translate3d
 *    直改 DOM;拖动期间挂 body.resizing-pane 让 webview 指针穿透;4px 阈值
 *    区分点击与拖动(windowDrag.tsx 同款);
 *  - 动效时序(2026-07-25 Lizi 定案"两段都要有戏"):收起 → 面板宽度先
 *    折叠到 0,等 300ms 圆圈渐显、幽灵再跳进来;点球展开 → 幽灵先跳走、
 *    圆圈再渐隐,计时器到点(260ms)才真正 restore,面板宽度展开回停靠位
 *    (编排见 globals.css;面板侧提交时序在 ghostPanels.tsx,减弱动效自动停);
 *  - 拖后落点持久化,重启保留;没拖过的气泡默认停右上角(计算不落盘,
 *    窗口缩放自动重排);渲染时 clamp 到视口,y 下限避开顶部 46px 拖动带;
 *  - 堆叠模式(2026-07-31 Lizi 定案):同时最小化 ≥2 个 → 合并成**一枚**
 *    堆叠气泡(lucide Ghost 脸 + 数量角标),点击向下(空间不够则向上)
 *    纵向展开各插件自己的气泡,点谁恢复谁;点堆叠球或空白处收拢。堆叠球
 *    可拖,落点单独持久化;只剩 1 个时自动回到单气泡形态(用它自己的
 *    存储位/默认位)。
 */

import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Ghost } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { ghostPanelKind, type GhostManifest } from '../../shared/ghost';
import {
  restoreGhostPanel,
  setGhostPanelBubblePosition,
  useGhostPanelBubbleState,
} from '../lib/ghostPanelBubbleState';
import { isGhostPanelKindDetached, useGhostPanelWindowsState } from '../lib/ghostPanelWindowState';
import { useInstalledGhosts } from './useInstalledGhosts';

const BUBBLE_SIZE = 48;
const EDGE_MARGIN = 12;
const STACK_GAP = 8;
const DRAG_THRESHOLD_PX = 4;
/** 顶部 46px 是窗口拖动带(§6 规则 3),气泡不进去。 */
const TOP_FLOOR = 46 + EDGE_MARGIN;
/** 点球展开:幽灵跳走(160ms)+ 圆圈渐隐(120ms 延迟 + 140ms)的总时长,
 *  到点才真正 restore(与 globals.css 的 exit 编排对齐)。 */
const EXIT_MS = 260;

/** 堆叠球落点的独立持久化键(不进 ghostPanelBubbleState:那张表按 ghostId
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

/** 视口 clamp(渲染与落点共用;store 里不 clamp,换屏不破坏存值)。 */
function clampToViewport(x: number, y: number): { x: number; y: number } {
  const maxX = Math.max(EDGE_MARGIN, window.innerWidth - BUBBLE_SIZE - EDGE_MARGIN);
  const maxY = Math.max(TOP_FLOOR, window.innerHeight - BUBBLE_SIZE - EDGE_MARGIN);
  return {
    x: Math.min(maxX, Math.max(EDGE_MARGIN, x)),
    y: Math.min(maxY, Math.max(TOP_FLOOR, y)),
  };
}

/** 没拖过的气泡默认位:右上角向下堆(defaultIndex 只数无存储位置的;
 *  2026-07-31 Lizi 定案由右下角改到右上角,TOP_FLOOR 已避开窗口拖动带)。 */
function defaultPosition(defaultIndex: number): { x: number; y: number } {
  return {
    x: window.innerWidth - BUBBLE_SIZE - EDGE_MARGIN,
    y: TOP_FLOOR + defaultIndex * (BUBBLE_SIZE + STACK_GAP),
  };
}

/**
 * 气泡拖拽(单气泡与堆叠球共用):热路径零 React,translate3d 直改 DOM;
 * 4px 阈值区分点击与拖动;拖后第一次合成 click 由 consumeDraggedClick 吞掉。
 * blocked = true 时不再受理新的 pointerdown(退场动画期)。
 */
function useBubbleDrag({
  elRef,
  pos,
  blocked,
  onDrop,
}: {
  elRef: RefObject<HTMLButtonElement | null>;
  pos: { x: number; y: number };
  blocked: boolean;
  onDrop: (x: number, y: number) => void;
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

  // 基准位变化(store 更新/默认位重排/窗口缩放)时回写 transform ——
  // 非拖动期间 transform 完全由 React 渲染值决定。
  useEffect(() => {
    const el = elRef.current;
    if (el && !dragRef.current?.dragging) {
      el.style.transform = `translate3d(${pos.x}px, ${pos.y}px, 0)`;
    }
  }, [elRef, pos.x, pos.y]);

  const endDragCleanup = () => {
    document.body.classList.remove('resizing-pane');
    document.body.style.userSelect = '';
  };

  const onPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0 || dragRef.current || blocked) return;
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
    if (el) el.style.transform = `translate3d(${next.x}px, ${next.y}px, 0)`;
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
      // 取消:回滚到拖前基准位
      const el = elRef.current;
      if (el) el.style.transform = `translate3d(${d.baseX}px, ${d.baseY}px, 0)`;
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
  /** 渲染基准位(已 clamp)。 */
  pos: { x: number; y: number };
  /** 堆叠展开出来的子气泡不可拖(位置由堆叠球锚定,拖了也没地方记)。 */
  draggable?: boolean;
}

function Bubble({ manifest, iconDataUrl, pos, draggable = true }: BubbleProps): ReactNode {
  const { t } = useTranslation();
  const elRef = useRef<HTMLButtonElement | null>(null);
  const [imgBroken, setImgBroken] = useState(false);
  /** 点击后进入"缩没退场"态:播 .ghost-bubble-exit,计时器到点才 restore。 */
  const [exiting, setExiting] = useState(false);
  const exitTimerRef = useRef(0);
  const drag = useBubbleDrag({
    elRef,
    pos,
    blocked: exiting,
    onDrop: (x, y) => setGhostPanelBubblePosition(manifest.id, x, y),
  });

  // 卸载时清退场计时器(restore 本身是 store 调用,晚到也无害,但别留悬垂)。
  useEffect(() => () => window.clearTimeout(exitTimerRef.current), []);

  const onClick = () => {
    if (drag.consumeDraggedClick()) return;
    if (exiting) return;
    // 展开的"过程感":幽灵先跳走、圆圈再渐隐(共 EXIT_MS),到点才真正恢复
    // 面板(面板侧再接宽度展开,见 ghostPanels.tsx 的 ghost-panel-enter)。
    setExiting(true);
    exitTimerRef.current = window.setTimeout(() => restoreGhostPanel(manifest.id), EXIT_MS);
  };

  const name = manifest.panel?.title ?? manifest.name;
  return (
    <button
      ref={elRef}
      type="button"
      data-testid={`ghost-panel-bubble-${manifest.id}`}
      data-ghost-bubble-layer
      aria-label={t('ghostPanelBubble.restoreAria', { name })}
      title={t('ghostPanelBubble.restoreAria', { name })}
      {...(draggable
        ? {
            onPointerDown: drag.onPointerDown,
            onPointerMove: drag.onPointerMove,
            onPointerUp: () => drag.finishDrag(true),
            onPointerCancel: () => drag.finishDrag(false),
          }
        : {})}
      onClick={onClick}
      // 按钮本体只管位置(translate3d)与命中区,不带视觉——圆圈(描边/底色/
      // 阴影)与幽灵分层,动画各编各的(见 globals.css 悬浮球一节)。
      // 描边四轮定(2026-07-25 Lizi):border-default 太浅 → accent-emphasis
      // 太深 → text-tertiary 中间档(亮色中灰/暗色中灰);2px 太粗 → 1px。
      className={`ghost-bubble group fixed left-0 top-0 z-[9900] flex h-12 w-12 cursor-pointer items-center justify-center will-change-transform ${
        exiting ? 'ghost-bubble-exit' : 'ghost-bubble-enter'
      }`}
      style={{ transform: `translate3d(${pos.x}px, ${pos.y}px, 0)` }}
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

/** 堆叠球:多个最小化面板的合并入口(Ghost 脸 + 数量角标),点击切换展开。 */
function StackBubble({
  count,
  pos,
  expanded,
  onToggle,
  onDrop,
}: {
  count: number;
  pos: { x: number; y: number };
  expanded: boolean;
  onToggle: () => void;
  onDrop: (x: number, y: number) => void;
}): ReactNode {
  const { t } = useTranslation();
  const elRef = useRef<HTMLButtonElement | null>(null);
  const drag = useBubbleDrag({ elRef, pos, blocked: false, onDrop });
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
      className="ghost-bubble ghost-bubble-enter group fixed left-0 top-0 z-[9900] flex h-12 w-12 cursor-pointer items-center justify-center will-change-transform"
      style={{ transform: `translate3d(${pos.x}px, ${pos.y}px, 0)` }}
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

/** 气泡层:空名单不渲染;窗口缩放防抖重渲以重算 clamp/默认位。 */
export function GhostPanelBubbleLayer(): ReactNode {
  const ghosts = useInstalledGhosts();
  const bubbles = useGhostPanelBubbleState();
  // 订阅抽离状态:detach 期间气泡隐藏,合并回来自动复现。
  useGhostPanelWindowsState();
  // 堆叠展开态(纯运行时,不落盘;落盘会让"重启后自动摊开一排"变成惊吓)。
  const [expanded, setExpanded] = useState(false);
  const [stackPos, setStackPos] = useState<{ x: number; y: number } | null>(() => loadStackPos());

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
  const stacked = minimized.length >= 2;

  // 掉出堆叠模式(恢复到 ≤1 个)时收拢,防下次进入堆叠直接摊开一排。
  useEffect(() => {
    if (!stacked) setExpanded(false);
  }, [stacked]);

  // 展开期间点空白处收拢(气泡都带 data-ghost-bubble-layer;capture 期判定,
  // 不干扰气泡自身的点击/拖拽)。
  useEffect(() => {
    if (!stacked || !expanded) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target;
      if (target instanceof Element && target.closest('[data-ghost-bubble-layer]')) return;
      setExpanded(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [stacked, expanded]);

  if (minimized.length === 0) return null;

  // ── 堆叠模式(≥2):一枚堆叠球,展开时向下(不够向上)纵向排子气泡 ──
  if (stacked) {
    const anchor = clampToViewport(
      stackPos?.x ?? defaultPosition(0).x,
      stackPos?.y ?? defaultPosition(0).y,
    );
    const step = BUBBLE_SIZE + STACK_GAP;
    // 展开方向:下方放得下全部子气泡就向下,否则向上(两头都放不下时 clamp
    // 兜底,极小窗口下允许压边,不做更复杂的绕排)。
    const fitsDown =
      anchor.y + step * minimized.length + BUBBLE_SIZE + EDGE_MARGIN <= window.innerHeight;
    const childPos = (index: number) =>
      clampToViewport(anchor.x, anchor.y + (fitsDown ? 1 : -1) * step * (index + 1));
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
        />
        {expanded
          ? minimized.map((g, index) => (
              <Bubble
                key={g.manifest.id}
                manifest={g.manifest}
                iconDataUrl={g.iconDataUrl}
                pos={childPos(index)}
                draggable={false}
              />
            ))
          : null}
      </>,
      document.body,
    );
  }

  // ── 单气泡模式(恰 1 个):沿用原语义(自己的存储位/默认位,可拖)──
  let defaultIndex = 0;
  const items = minimized.map((g) => {
    const entry = bubbles[g.manifest.id];
    const hasPos = Number.isFinite(entry?.x) && Number.isFinite(entry?.y);
    const base = hasPos
      ? { x: entry.x as number, y: entry.y as number }
      : defaultPosition(defaultIndex++);
    return {
      ghost: g,
      pos: clampToViewport(base.x, base.y),
    };
  });

  return createPortal(
    <>
      {items.map(({ ghost, pos }) => (
        <Bubble
          key={ghost.manifest.id}
          manifest={ghost.manifest}
          iconDataUrl={ghost.iconDataUrl}
          pos={pos}
        />
      ))}
    </>,
    document.body,
  );
}
