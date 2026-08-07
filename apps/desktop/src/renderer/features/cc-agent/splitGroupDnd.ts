import type { DropSide } from './splitGroupStore';

export const SPLIT_GROUP_SESSION_MIME = 'application/x-cindy-session-id';

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

export function writeSplitGroupSessionDragData(
  dataTransfer: SplitGroupDragDataTransfer,
  sessionIdInput: string,
): boolean {
  const sessionId = sessionIdInput.trim();
  if (!sessionId) return false;
  dataTransfer.effectAllowed = 'move';
  dataTransfer.setData(SPLIT_GROUP_SESSION_MIME, sessionId);
  dataTransfer.setData('text/plain', sessionId);
  return true;
}

export function hasSplitGroupSessionType(types: ArrayLike<string>): boolean {
  return Array.from(types).includes(SPLIT_GROUP_SESSION_MIME);
}

export interface SplitDragSourceContext {
  editing: boolean;
  orcaRole?: string | null;
  /** 行是否被 SortableJS 容器（置顶/项目手动排序）包裹。 */
  inSortableContainer: boolean;
}

/**
 * 一行任务是否充当分屏拖拽源。SortableJS（forceFallback 指针手势）与原生 HTML5
 * 拖拽会争抢同一次手势：行带 `draggable` 时浏览器可能启动原生拖拽并中断 fallback
 * 排序，因此 Sortable 容器内的行保持原有手动排序，不再叠加分屏拖拽。Orca worker
 * 不进侧栏列表，防御性排除，避免把 worker id 写进分屏树后与 Lead 路由错位。
 */
export function isSplitGroupDragSource(context: SplitDragSourceContext): boolean {
  return !context.editing && context.orcaRole !== 'worker' && !context.inSortableContainer;
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
