import type { DropSide } from './splitGroupStore';
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
  setData(format: string, data: string): void;
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
  dataTransfer.setData(SPLIT_GROUP_SESSION_MIME, sessionId);
  dataTransfer.setData(SESSION_LINK_DROP_MIME, link);
  dataTransfer.setData('text/plain', sessionId);
  return true;
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
