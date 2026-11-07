/**
 * pendingQueueHold —— 队列停点(hold)的行级推导。
 *
 * 停点是「这一条及其之后都不再自动派发」:队列里至多一条 held,由 main 的
 * coordinator 原子维护。面板只读它来决定每行怎么呈现 —— 行首标记、弱化、
 * 可用按钮与操作区宽度;判定本身不进组件,避免 UI 与 main 各算一套。
 */

import type { QueuedMessage } from '@/lib/makerChatStore';

export interface PendingQueueHoldRow {
  /** 这一条就是停点。 */
  isHeld: boolean;
  /** 停点在它之前,所以它也不会被自动发送。 */
  isAfterStop: boolean;
  /** 停点行不提供插话(它不会参与当前轮)。 */
  canSteer: boolean;
  canHold: boolean;
  canRelease: boolean;
  /** 行首 20px 槽位是拖拽把手还是常驻停点标记。 */
  leading: 'drag' | 'held';
  /** 该行能否拖动:停点之后的区间不允许重排。 */
  draggable: boolean;
  /** 整行弱化(悬停/聚焦/编辑时由调用方恢复)。 */
  dimmed: boolean;
}

/** 停点在可见队列中的下标;-1 = 没有停点。 */
export function findStopIndex(queue: readonly QueuedMessage[]): number {
  return queue.findIndex((entry) => entry.held === true);
}

export function resolveQueueHoldRow(
  entry: QueuedMessage,
  stopIndex: number,
  rowIndex: number,
  opts: { canSteer: boolean; canEdit: boolean },
): PendingQueueHoldRow {
  const isHeld = stopIndex >= 0 && rowIndex === stopIndex;
  const isAfterStop = stopIndex >= 0 && rowIndex > stopIndex;
  return {
    isHeld,
    isAfterStop,
    canSteer: opts.canSteer && !isHeld,
    // 停点之后的条目不再提供停点(那只是一个冗余的第二停点)。
    canHold: !isHeld && !isAfterStop,
    canRelease: isHeld,
    leading: isHeld ? 'held' : 'drag',
    draggable: !isHeld && !isAfterStop,
    dimmed: isHeld || isAfterStop,
  };
}

/**
 * 行操作区宽度档,避免悬停瞬间行宽跳动。
 * 四个 20px 按钮 + 3×4px gap = 92px;停点行与停点之后都是三个按钮 = 68px。
 */
export function queueRowActionWidth(count: number): string {
  switch (count) {
    case 0:
      return 'w-5';
    case 1:
      return 'w-5';
    case 2:
      return 'w-[44px]';
    case 3:
      return 'w-[68px]';
    default:
      return 'w-[92px]';
  }
}
