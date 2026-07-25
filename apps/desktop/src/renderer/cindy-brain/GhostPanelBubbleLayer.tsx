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
 *  - 拖后落点持久化,重启保留;没拖过的气泡从右下角向上堆(计算不落盘,
 *    窗口缩放自动重排);渲染时 clamp 到视口,y 下限避开顶部 46px 拖动带。
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
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

/** 视口 clamp(渲染与落点共用;store 里不 clamp,换屏不破坏存值)。 */
function clampToViewport(x: number, y: number): { x: number; y: number } {
  const maxX = Math.max(EDGE_MARGIN, window.innerWidth - BUBBLE_SIZE - EDGE_MARGIN);
  const maxY = Math.max(TOP_FLOOR, window.innerHeight - BUBBLE_SIZE - EDGE_MARGIN);
  return {
    x: Math.min(maxX, Math.max(EDGE_MARGIN, x)),
    y: Math.min(maxY, Math.max(TOP_FLOOR, y)),
  };
}

/** 没拖过的气泡默认位:右下角向上堆(defaultIndex 只数无存储位置的)。 */
function defaultPosition(defaultIndex: number): { x: number; y: number } {
  return {
    x: window.innerWidth - BUBBLE_SIZE - EDGE_MARGIN,
    y: window.innerHeight - BUBBLE_SIZE - EDGE_MARGIN - defaultIndex * (BUBBLE_SIZE + STACK_GAP),
  };
}

interface BubbleProps {
  manifest: GhostManifest;
  iconDataUrl: string | undefined;
  /** 渲染基准位(已 clamp)。 */
  pos: { x: number; y: number };
}

function Bubble({ manifest, iconDataUrl, pos }: BubbleProps): ReactNode {
  const { t } = useTranslation();
  const elRef = useRef<HTMLButtonElement | null>(null);
  const [imgBroken, setImgBroken] = useState(false);
  /** 点击后进入"缩没退场"态:播 .ghost-bubble-exit,计时器到点才 restore。 */
  const [exiting, setExiting] = useState(false);
  const exitTimerRef = useRef(0);
  // 拖拽全程 ref,热路径零 React(性能口径见文件头)。
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
  }, [pos.x, pos.y]);

  // 卸载时清退场计时器(restore 本身是 store 调用,晚到也无害,但别留悬垂)。
  useEffect(() => () => window.clearTimeout(exitTimerRef.current), []);

  const endDragCleanup = () => {
    document.body.classList.remove('resizing-pane');
    document.body.style.userSelect = '';
  };

  const onPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0 || dragRef.current || exiting) return;
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
    if (!d.dragging) return; // 纯点击:等 onClick 走退场→恢复时序
    endDragCleanup();
    draggedRef.current = true; // 吞掉随后的合成 click
    if (persist) {
      setGhostPanelBubblePosition(manifest.id, d.lastX, d.lastY);
    } else {
      // 取消:回滚到拖前基准位
      const el = elRef.current;
      if (el) el.style.transform = `translate3d(${d.baseX}px, ${d.baseY}px, 0)`;
    }
  };

  const onClick = () => {
    if (draggedRef.current) {
      draggedRef.current = false;
      return;
    }
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
      aria-label={t('ghostPanelBubble.restoreAria', { name })}
      title={t('ghostPanelBubble.restoreAria', { name })}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={() => finishDrag(true)}
      onPointerCancel={() => finishDrag(false)}
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

/** 气泡层:空名单不渲染;窗口缩放防抖重渲以重算 clamp/默认位。 */
export function GhostPanelBubbleLayer(): ReactNode {
  const ghosts = useInstalledGhosts();
  const bubbles = useGhostPanelBubbleState();
  // 订阅抽离状态:detach 期间气泡隐藏,合并回来自动复现。
  useGhostPanelWindowsState();

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
  if (minimized.length === 0) return null;

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
