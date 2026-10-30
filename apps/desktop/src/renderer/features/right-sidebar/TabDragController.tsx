/**
 * TabDragController —— 把页签拖到别的页签组 / 聊天区的某条边。
 *
 * 页签条内部的重排由 SortableList(SortableJS fallback 模式)负责;本控制器只在
 * 指针**拖出页签条**后接管:取消 Sortable 的这次拖动(复位 DOM、不提交重排),
 * 浮起一张页签拖影,点亮可落的目标:
 *   - 其它组的页签条(整条 = 落点,落下 = 搬到那一组);
 *   - 聊天区的四条边(各一道边带,落下 = 搬到对应边的组;右边带 = 右侧栏,收着时会展开);
 *   - 窗口外(指针离开本窗口可视区):松手 = 弹成独立窗口,新窗口落在松手点附近。
 *     窗外看不到本窗口里的拖影,借用任务拖出窗口那扇跟随指针的预览卡
 *     (main 的 session-drag-preview,它只在指针位于所有 Cindy 窗口之外时显示)。
 * 松手落在亮区才搬(moveTabToGroup),否则什么都不发生;Esc 取消。
 *
 * 性能口径同 PanelDragController:起拖时量一次几何;pointermove 热路径直改拖影
 * transform、只有落点变化才 setState;拖动期间 body 停止指针命中(webview 穿透)。
 * 只挂在主窗口(MainLayout);弹出窗口不分组。
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { cancelActiveSortable } from '@/components/sidebar/SortableList';
import { resolveSessionDragPreviewPalette } from '@/features/cc-agent/splitGroupDnd';
import { moveTabToGroup } from './moveTab';
import { TAB_GROUP_IDS, type TabGroupId } from './tabGroups';

interface RectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface TabDropZone {
  group: TabGroupId;
  rect: RectLike;
}

/** 指针离开页签条多远(px)算"拖出去了",此前都归 Sortable 的条内重排。 */
const LEAVE_STRIP_MARGIN_PX = 14;
/** 聊天区边带厚度:短边的 22%,夹到 [72, 180] px。 */
const EDGE_BAND_RATIO = 0.22;
const EDGE_BAND_MIN_PX = 72;
const EDGE_BAND_MAX_PX = 180;
const ZONE_INSET_PX = 6;

function bandThickness(size: number): number {
  return Math.min(EDGE_BAND_MAX_PX, Math.max(EDGE_BAND_MIN_PX, size * EDGE_BAND_RATIO));
}

/**
 * 纯函数:聊天区矩形 → 四条边带(排除 exclude 里的组,通常是源组)。角落归先列的边
 * (左右优先于上下),由 pickTabDropZone 的先到先得决定。
 */
export function computeChatEdgeZones(
  chatRect: RectLike,
  exclude: ReadonlySet<TabGroupId> = new Set(),
): TabDropZone[] {
  if (!(chatRect.width > 0 && chatRect.height > 0)) return [];
  const t = bandThickness(Math.min(chatRect.width, chatRect.height));
  const zones: TabDropZone[] = [];
  const push = (group: TabGroupId, rect: RectLike) => {
    if (!exclude.has(group)) zones.push({ group, rect });
  };
  push('left', { left: chatRect.left, top: chatRect.top, width: t, height: chatRect.height });
  push('right', {
    left: chatRect.left + chatRect.width - t,
    top: chatRect.top,
    width: t,
    height: chatRect.height,
  });
  push('top', { left: chatRect.left, top: chatRect.top, width: chatRect.width, height: t });
  push('bottom', {
    left: chatRect.left,
    top: chatRect.top + chatRect.height - t,
    width: chatRect.width,
    height: t,
  });
  return zones;
}

/** 纯函数:指针是否已离开本窗口的可视区(pointer 事件按住按钮时窗外照样送达)。 */
export function isPointerOutsideWindow(
  clientX: number,
  clientY: number,
  innerWidth: number,
  innerHeight: number,
): boolean {
  return clientX < 0 || clientY < 0 || clientX >= innerWidth || clientY >= innerHeight;
}

/** 纯函数:指针落在哪个落点里(先到先得);都不在 → null。 */
export function pickTabDropZone(
  x: number,
  y: number,
  zones: readonly TabDropZone[],
): TabDropZone | null {
  for (const zone of zones) {
    const { left, top, width, height } = zone.rect;
    if (x >= left && x <= left + width && y >= top && y <= top + height) return zone;
  }
  return null;
}

function rectOf(el: Element): RectLike {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}

function insetRect(rect: RectLike): RectLike {
  return {
    left: rect.left + ZONE_INSET_PX,
    top: rect.top + ZONE_INSET_PX,
    width: Math.max(0, rect.width - ZONE_INSET_PX * 2),
    height: Math.max(0, rect.height - ZONE_INSET_PX * 2),
  };
}

/** 起拖时一次性收集全部落点:其它组的页签条 + 聊天区边带。 */
function collectZones(sourceGroup: TabGroupId): TabDropZone[] {
  const zones: TabDropZone[] = [];
  for (const strip of document.querySelectorAll<HTMLElement>('[data-tab-group-strip]')) {
    const group = strip.getAttribute('data-tab-group-strip');
    if (!group || group === sourceGroup) continue;
    if (!(TAB_GROUP_IDS as readonly string[]).includes(group)) continue;
    const rect = rectOf(strip);
    if (rect.width < 24 || rect.height < 12) continue; // 收起 / 不在场的条不是落点
    zones.push({ group: group as TabGroupId, rect });
  }
  const chat = document.querySelector('[data-panel-drag-root="chat-main"]');
  if (chat) zones.push(...computeChatEdgeZones(rectOf(chat), new Set([sourceGroup])));
  return zones;
}

interface DragRenderState {
  label: string;
  zone: TabDropZone | null;
  /** 指针在窗口外:本窗口的拖影隐藏,由 main 的窗外预览卡接棒。 */
  outside: boolean;
}

interface TabDragControllerProps {
  /** 当前任务;搬任务页签后让它在目标组被选中要用。 */
  sessionId: string | null;
  /** 内容区在聊天路由上且非撑满态时开启。 */
  enabled: boolean;
  /** 松手在窗口外:把页签弹成独立窗口,窗口落在松手点(屏幕坐标)附近。不传 = 不支持拖出。 */
  onPopOut?: (tabId: string, point: { x: number; y: number }) => void;
}

export function TabDragController({
  sessionId,
  enabled,
  onPopOut,
}: TabDragControllerProps): ReactNode {
  const [drag, setDrag] = useState<DragRenderState | null>(null);
  const activeRef = useRef(false);
  const ghostRef = useRef<HTMLDivElement | null>(null);
  const pointRef = useRef({ x: 0, y: 0 });
  const cleanupRef = useRef<(() => void) | null>(null);
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const onPopOutRef = useRef(onPopOut);
  onPopOutRef.current = onPopOut;

  useEffect(() => {
    if (!enabled) return;

    const moveGhost = (x: number, y: number) => {
      pointRef.current = { x, y };
      const node = ghostRef.current;
      if (node) node.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    };

    const takeOver = (
      tabId: string,
      sourceGroup: TabGroupId,
      label: string,
      x: number,
      y: number,
    ) => {
      const zones = collectZones(sourceGroup);
      const canPopOut = Boolean(onPopOutRef.current);
      if (zones.length === 0 && !canPopOut) return false;
      cancelActiveSortable();
      activeRef.current = true;
      let current: TabDropZone | null = null;
      let outside = false;
      let lastScreen = { x: 0, y: 0 };
      pointRef.current = { x, y };
      setDrag({ label, zone: null, outside: false });
      // 窗外预览卡:main 只在指针离开所有 Cindy 窗口时显示它,这里一开拖就登记。
      const previewApi = canPopOut ? window.electronAPI?.sidebarTabWindow : undefined;
      const palette = previewApi?.beginDragPreview ? resolveSessionDragPreviewPalette() : undefined;
      if (previewApi?.beginDragPreview && palette) {
        void previewApi.beginDragPreview(label, palette).catch(() => undefined);
      }
      document.body.classList.add('resizing-pane');
      const prevUserSelect = document.body.style.userSelect;
      const prevPointerEvents = document.body.style.pointerEvents;
      const prevCursor = document.documentElement.style.cursor;
      document.body.style.userSelect = 'none';
      document.body.style.pointerEvents = 'none';
      document.documentElement.style.cursor = 'grabbing';
      window.getSelection()?.removeAllRanges();

      const onMove = (e: PointerEvent) => {
        moveGhost(e.clientX, e.clientY);
        lastScreen = { x: e.screenX, y: e.screenY };
        const nextOutside =
          canPopOut &&
          isPointerOutsideWindow(e.clientX, e.clientY, window.innerWidth, window.innerHeight);
        const next = nextOutside ? null : pickTabDropZone(e.clientX, e.clientY, zones);
        if (next !== current || nextOutside !== outside) {
          current = next;
          outside = nextOutside;
          setDrag({ label, zone: next, outside: nextOutside });
        }
      };
      const finish = (commit: boolean) => {
        activeRef.current = false;
        setDrag(null);
        document.body.classList.remove('resizing-pane');
        document.body.style.userSelect = prevUserSelect;
        document.body.style.pointerEvents = prevPointerEvents;
        document.documentElement.style.cursor = prevCursor;
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        document.removeEventListener('pointercancel', onCancel);
        window.removeEventListener('blur', onCancel);
        window.removeEventListener('keydown', onKey, true);
        cleanupRef.current = null;
        try {
          previewApi?.endDragPreview?.();
        } catch {
          // preload 可能已随窗口拆除而不可用;本地收尾照常。
        }
        if (commit && outside) {
          onPopOutRef.current?.(tabId, lastScreen);
        } else if (commit && current) {
          moveTabToGroup(tabId, current.group, sessionIdRef.current);
        }
        // 松手落点下方可能是按钮:吞掉紧随其后的那一次 click。
        const swallow = (ce: MouseEvent) => {
          ce.preventDefault();
          ce.stopPropagation();
        };
        window.addEventListener('click', swallow, { capture: true, once: true });
        window.setTimeout(
          () =>
            window.removeEventListener('click', swallow, { capture: true } as EventListenerOptions),
          100,
        );
      };
      const onUp = (e: PointerEvent) => {
        lastScreen = { x: e.screenX, y: e.screenY };
        if (canPopOut) {
          outside = isPointerOutsideWindow(
            e.clientX,
            e.clientY,
            window.innerWidth,
            window.innerHeight,
          );
        }
        finish(true);
      };
      const onCancel = () => finish(false);
      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape') finish(false);
      };
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
      document.addEventListener('pointercancel', onCancel);
      // 失焦即取消,不让抓取态卡住。按住按钮拖到窗外时窗口不会失焦(指针仍归本窗口),
      // 真正松手在窗外会以 pointerup 回来;只有切到别的应用 / 系统 UI 才走这里。
      window.addEventListener('blur', onCancel);
      window.addEventListener('keydown', onKey, true);
      cleanupRef.current = () => finish(false);
      return true;
    };

    const onPointerDown = (e: PointerEvent) => {
      // 上一次的松手没收到(极端情况):新按下视作上一次已结束,先收尾再接新手势。
      if (activeRef.current) cleanupRef.current?.();
      if (e.button !== 0) return;
      const target = e.target as HTMLElement | null;
      const pill = target?.closest<HTMLElement>('[data-tab-pill]');
      if (!pill || target?.closest('[data-no-drag]')) return;
      const strip = pill.closest<HTMLElement>('[data-tab-group-strip]');
      const sourceGroup = strip?.getAttribute('data-tab-group-strip');
      if (!strip || !sourceGroup || !(TAB_GROUP_IDS as readonly string[]).includes(sourceGroup))
        return;
      const tabId = pill.getAttribute('data-tab-pill');
      if (!tabId) return;
      const stripRect = strip.getBoundingClientRect();
      const label = pill.textContent?.trim() ?? '';

      const onMove = (me: PointerEvent) => {
        const outside =
          me.clientY < stripRect.top - LEAVE_STRIP_MARGIN_PX ||
          me.clientY > stripRect.bottom + LEAVE_STRIP_MARGIN_PX ||
          me.clientX < stripRect.left - LEAVE_STRIP_MARGIN_PX ||
          me.clientX > stripRect.right + LEAVE_STRIP_MARGIN_PX;
        if (!outside) return;
        stop();
        takeOver(tabId, sourceGroup as TabGroupId, label, me.clientX, me.clientY);
      };
      const stop = () => {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', stop);
        document.removeEventListener('pointercancel', stop);
      };
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', stop);
      document.addEventListener('pointercancel', stop);
    };

    document.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      cleanupRef.current?.();
    };
  }, [enabled]);

  if (!drag) return null;
  const zone = drag.zone ? insetRect(drag.zone.rect) : null;
  // 指针在窗口外:本窗口里的拖影无处可画(也不该贴在窗口边缘),交给 main 的预览卡。
  if (drag.outside) return null;
  return createPortal(
    <>
      {zone && (
        <div
          aria-hidden
          data-testid="tab-drop-zone"
          className="pointer-events-none fixed z-[9998] rounded-xl border animate-fade-in"
          style={{
            left: zone.left,
            top: zone.top,
            width: zone.width,
            height: zone.height,
            background: 'color-mix(in srgb, var(--focus-ring) 10%, transparent)',
            borderColor: 'color-mix(in srgb, var(--focus-ring) 55%, transparent)',
          }}
        />
      )}
      <div
        aria-hidden
        ref={(node) => {
          ghostRef.current = node;
          if (node) {
            node.style.transform = `translate3d(${pointRef.current.x}px, ${pointRef.current.y}px, 0)`;
          }
        }}
        className="pointer-events-none fixed left-0 top-0 z-[9999] will-change-transform"
      >
        <div
          className="flex h-[30px] max-w-[220px] items-center rounded-lg border px-2.5 text-12 font-medium text-[var(--text-primary)] animate-fade-in"
          style={{
            transform: 'translate(-50%, -140%)',
            background: 'var(--surface-elevated)',
            borderColor: drag.zone ? 'var(--focus-ring)' : 'var(--border-default)',
            boxShadow: 'var(--shadow-menu)',
            opacity: 0.95,
          }}
        >
          <span className="truncate">{drag.label}</span>
        </div>
      </div>
    </>,
    document.body,
  );
}
