import type { DropSide } from './splitGroupStore';
import type { SessionDragPreviewPalette } from '../../../shared/sessionDragPreview';
import { buildSessionDeepLink } from '@/lib/deepLink';
import {
  isSessionLinkDropTarget,
  SESSION_LINK_DROP_MIME,
  SESSION_LINK_DROP_TARGET_SELECTOR,
} from '@/lib/sessionLinkDrop';

export const SPLIT_GROUP_SESSION_MIME = 'application/x-cindy-session-id';
/** Backward-compatible feature-local name for the shared composer payload. */
export { SESSION_LINK_DROP_MIME as SPLIT_GROUP_SESSION_LINK_MIME };
/** 输入框优先消费任务拖放，分屏 pane 不应在 capture 阶段抢走。 */
export const SPLIT_GROUP_COMPOSER_DROP_TARGET_SELECTOR = SESSION_LINK_DROP_TARGET_SELECTOR;
export const SPLIT_GROUP_DRAG_HANDLE_SELECTOR = '[data-split-group-drag-handle]';
export const SPLIT_GROUP_DRAG_INTERACTIVE_SELECTOR =
  'button, input, textarea, select, a[href], [role="menuitem"]';

export interface DropRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface SplitGroupDragDataTransfer {
  effectAllowed: string;
  clearData?(format?: string): void;
  setData(format: string, data: string): void;
  setDragImage?(image: Element, x: number, y: number): void;
}

interface SessionDragEventLike {
  target: EventTarget | null;
  currentTarget: EventTarget | null;
  dataTransfer: SplitGroupDragDataTransfer;
  preventDefault(): void;
}

interface SessionDragEndEventLike {
  currentTarget: EventTarget | null;
}

let activeSessionDragCancelled = false;
let activeSessionDragCleanup: (() => void) | null = null;

function resolveSessionDragPreviewPalette(): SessionDragPreviewPalette | undefined {
  if (typeof document === 'undefined' || typeof window === 'undefined') return undefined;
  const parent = document.body ?? document.documentElement;
  if (!parent) return undefined;

  const probe = document.createElement('div');
  probe.dataset.sessionDragPreviewPaletteProbe = 'true';
  probe.style.cssText =
    'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;';
  probe.style.backgroundColor = 'var(--surface-elevated)';
  probe.style.borderTop = '1px solid var(--border-default)';
  probe.style.color = 'var(--text-primary)';
  parent.appendChild(probe);
  try {
    const style = window.getComputedStyle(probe);
    return {
      surface: style.backgroundColor,
      border: style.borderTopColor,
      text: style.color,
    };
  } finally {
    probe.remove();
  }
}

function stopTrackingSessionDrag(): boolean {
  const cancelled = activeSessionDragCancelled;
  activeSessionDragCancelled = false;
  activeSessionDragCleanup?.();
  activeSessionDragCleanup = null;
  return cancelled;
}

function startTrackingSessionDrag(
  label: string,
  sessionId: string,
  deviceId: string | null | undefined,
  dragImageCleanup: () => void,
  onNativeDragEnd: () => void,
): void {
  stopTrackingSessionDrag();
  activeSessionDragCancelled = false;
  if (typeof window === 'undefined') {
    return;
  }
  const beginPreview = window.electronAPI?.maker?.beginSessionDragPreview;
  if (beginPreview) {
    const palette = resolveSessionDragPreviewPalette();
    if (palette) {
      void beginPreview(label, sessionId, deviceId, palette).catch(() => undefined);
    }
  }
  let previewEndSent = false;
  const signalPreviewEnd = () => {
    if (previewEndSent) return;
    previewEndSent = true;
    const endPreview = window.electronAPI?.maker?.endSessionDragPreview;
    try {
      endPreview?.(Date.now());
    } catch {
      // Renderer teardown can make preload unavailable mid-drag. Local drag
      // cleanup must still complete; main has its own duration safety cap.
    }
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    activeSessionDragCancelled = true;
    // Escape may cancel Chromium's drag without immediately producing
    // dragend. Disarm the macOS mouse-up fast path now so releasing the button
    // after cancellation cannot open a window.
    signalPreviewEnd();
  };
  const onDragEnd = () => onNativeDragEnd();
  const onPointerUp = () => onNativeDragEnd();
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('dragend', onDragEnd, true);
  // macOS has a main-process AppKit mouse-up fast path. Renderer pointer/mouse
  // events can arrive first and disarm that listener before it sees the drop;
  // leave them as the fallback only on platforms without the native path.
  const hasNativeMouseUpPath = window.electronAPI?.platform === 'darwin';
  if (!hasNativeMouseUpPath) {
    window.addEventListener('pointerup', onPointerUp, true);
    window.addEventListener('mouseup', onPointerUp, true);
  }
  activeSessionDragCleanup = () => {
    signalPreviewEnd();
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('dragend', onDragEnd, true);
    if (!hasNativeMouseUpPath) {
      window.removeEventListener('pointerup', onPointerUp, true);
      window.removeEventListener('mouseup', onPointerUp, true);
    }
    dragImageCleanup();
  };
}

interface SplitGroupDragOptions {
  /** 远程任务的归属设备，冻结进深链避免引用解析漂移。 */
  deviceId?: string | null;
}

export function writeSplitGroupSessionDragData(
  dataTransfer: SplitGroupDragDataTransfer,
  sessionIdInput: string,
  options?: SplitGroupDragOptions,
): boolean {
  const sessionId = sessionIdInput.trim();
  if (!sessionId) return false;
  const link = buildSessionDeepLink(sessionId, { deviceId: options?.deviceId });
  // The same gesture can reorder a row (move) or insert its link into the
  // composer (copy), so the source must advertise both legal drop effects.
  dataTransfer.effectAllowed = 'copyMove';
  // Never expose a native text/URL flavor. Finder turns those into clipping
  // files and macOS may add its globe/link drag badge; every Cindy target
  // consumes one of the two private MIME types below.
  dataTransfer.clearData?.();
  dataTransfer.setData(SPLIT_GROUP_SESSION_MIME, sessionId);
  dataTransfer.setData(SESSION_LINK_DROP_MIME, link);
  return true;
}

function installSessionDragPreview(dataTransfer: SplitGroupDragDataTransfer): () => void {
  if (typeof document === 'undefined' || !dataTransfer.setDragImage) return () => undefined;

  // Native drag images are captured by the OS for the whole gesture. Keep the
  // captured image transparent so it never appears in Cindy or animates back
  // to the source after an external drop; main owns the visible outside-window
  // preview and can stop it synchronously on dragend/Escape.
  const transparentPreview = document.createElement('canvas');
  transparentPreview.width = 1;
  transparentPreview.height = 1;
  transparentPreview.dataset.sessionDragPreviewTransparent = 'true';
  transparentPreview.style.cssText =
    'position:fixed;left:0;top:0;width:1px;height:1px;pointer-events:none;';
  document.body?.appendChild(transparentPreview);
  try {
    dataTransfer.setDragImage(transparentPreview, 0, 0);
  } catch {
    // Some test doubles / older WebKit builds may reject a canvas drag image;
    // the drag payload itself remains valid and main preview is independent.
  }
  return () => transparentPreview.remove();
}

/**
 * Shared native drag-start policy for every task presentation (list/card/pinned).
 * Sorting implementations may differ, but the task payload and the allowed
 * drag-start surface must stay identical across those presentations.
 */
export function startSessionDrag(
  event: SessionDragEventLike,
  options: {
    sessionId: string;
    deviceId?: string | null;
    enabled: boolean;
    needsDedicatedHandle: boolean;
    label?: string;
    dragStartTarget?: Element | null;
  },
): boolean {
  const currentTarget =
    typeof Element !== 'undefined' && event.currentTarget instanceof Element
      ? event.currentTarget
      : null;
  const target =
    options.dragStartTarget ??
    (typeof Element !== 'undefined' && event.target instanceof Element ? event.target : null);
  const startedOnDedicatedHandle = Boolean(target?.closest(SPLIT_GROUP_DRAG_HANDLE_SELECTOR));
  const startedOnInteractiveElement = Boolean(
    target &&
    currentTarget &&
    target !== currentTarget &&
    target.closest(SPLIT_GROUP_DRAG_INTERACTIVE_SELECTOR),
  );

  if (
    !shouldStartSplitGroupDrag({
      enabled: options.enabled,
      needsDedicatedHandle: options.needsDedicatedHandle,
      startedOnDedicatedHandle,
      startedOnInteractiveElement,
    }) ||
    !writeSplitGroupSessionDragData(event.dataTransfer, options.sessionId, {
      deviceId: options.deviceId,
    })
  ) {
    event.preventDefault();
    return false;
  }

  currentTarget?.setAttribute('data-session-dragging', 'true');
  const dragImageCleanup = installSessionDragPreview(event.dataTransfer);
  startTrackingSessionDrag(
    options.label || options.sessionId,
    options.sessionId,
    options.deviceId,
    dragImageCleanup,
    () => {
      finishSessionDrag({ currentTarget }, options.sessionId, options.deviceId);
    },
  );
  return true;
}

/** Finish the shared native drag path and request the main-process outside drop check. */
export function finishSessionDrag(
  event: SessionDragEndEventLike,
  sessionId: string,
  deviceId?: string | null,
): void {
  const currentTarget =
    typeof Element !== 'undefined' && event.currentTarget instanceof Element
      ? event.currentTarget
      : null;
  const wasSessionDrag = currentTarget?.getAttribute('data-session-dragging') === 'true';
  currentTarget?.removeAttribute('data-session-dragging');
  const cancelled = stopTrackingSessionDrag();
  if (!wasSessionDrag) return;
  if (cancelled) return;

  const openOutside = window.electronAPI?.maker?.openSessionInNewWindowIfDroppedOutside;
  if (!openOutside) return;
  void openOutside(sessionId, deviceId).catch(() => undefined);
}

export function hasSplitGroupSessionType(types: ArrayLike<string>): boolean {
  return Array.from(types).includes(SPLIT_GROUP_SESSION_MIME);
}

export function isSplitGroupComposerDropTarget(target: EventTarget | null): boolean {
  return isSessionLinkDropTarget(target);
}

export interface SplitDragSourceContext {
  editing: boolean;
  orcaRole?: string | null;
  /** 行是否被 SortableJS 容器（置顶/项目手动排序）包裹。 */
  inSortableContainer: boolean;
  /** SortableJS 是否已被祖先的 data-no-drag 边界拦截。 */
  sortableDragBlocked?: boolean;
  /** SortableJS 是否使用原生 DnD；原生模式可与右侧分屏 drop 共用一条手势。 */
  nativeSortable?: boolean;
  /** Sortable 行是否提供了独立、会被 data-no-drag 隔离的原生分屏拖拽起手区。 */
  hasDedicatedHandle?: boolean;
}

/** Sortable 行必须从独立起手区开始分屏拖拽，避免与整项排序争抢同一手势。 */
export function needsDedicatedSplitGroupDragHandle(
  context: Pick<
    SplitDragSourceContext,
    'inSortableContainer' | 'sortableDragBlocked' | 'nativeSortable'
  >,
): boolean {
  return (
    context.inSortableContainer &&
    context.sortableDragBlocked !== true &&
    context.nativeSortable !== true
  );
}

/**
 * 一行任务是否充当分屏拖拽源。SortableJS（forceFallback 指针手势）与原生 HTML5
 * 拖拽会争抢同一次手势：行带 `draggable` 时浏览器可能启动原生拖拽并中断 fallback
 * 排序。Sortable 行只有在已被 `data-no-drag` 隔离，或提供独立的分屏拖拽起手区时才
 * 放行；原生 Sortable 模式则允许整行同时进入排序或右侧分屏。Orca worker 不进侧栏列表，
 * 防御性排除，避免把 worker id 写进分屏树后与 Lead 路由错位。
 */
export function isSplitGroupDragSource(context: SplitDragSourceContext): boolean {
  return (
    !context.editing &&
    context.orcaRole !== 'worker' &&
    (!needsDedicatedSplitGroupDragHandle(context) || context.hasDedicatedHandle === true)
  );
}

export interface SplitDragStartContext {
  enabled: boolean;
  needsDedicatedHandle: boolean;
  startedOnDedicatedHandle: boolean;
  startedOnInteractiveElement: boolean;
}

/** 原生拖拽只能从允许的区域开始；按钮、输入框和菜单项永远保留自身交互。 */
export function shouldStartSplitGroupDrag(context: SplitDragStartContext): boolean {
  if (!context.enabled || context.startedOnInteractiveElement) return false;
  return !context.needsDedicatedHandle || context.startedOnDedicatedHandle;
}

/** 按指针距四条边的最近距离决定左 / 右 / 上 / 下落点。 */
export function resolveSplitDropSide(
  rect: DropRect,
  clientX: number,
  clientY: number,
): DropSide | null {
  if (!(rect.width > 0 && rect.height > 0)) return null;
  const relativeX = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  const relativeY = Math.min(1, Math.max(0, (clientY - rect.top) / rect.height));
  const horizontalSide: DropSide = relativeX < 0.5 ? 'left' : 'right';
  const verticalSide: DropSide = relativeY < 0.5 ? 'top' : 'bottom';
  const horizontalEdgeDistance = Math.min(relativeX, 1 - relativeX);
  const verticalEdgeDistance = Math.min(relativeY, 1 - relativeY);
  return horizontalEdgeDistance <= verticalEdgeDistance ? horizontalSide : verticalSide;
}
