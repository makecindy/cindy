/**
 * pendingQueueHold —— 队列停点(hold)的行级推导。
 *
 * 停点是「这一条及其之后都不再自动派发」:队列里至多一条 held,由 main 的
 * coordinator 原子维护。排队行(气泡)与队列检视都读同一份推导,避免 UI 与 main
 * 各算一套。
 */

import type { QueuedMessage } from '@/lib/makerChatStore';

export interface PendingQueueHoldRow {
  /** 这一条就是停点。 */
  isHeld: boolean;
  /** 停点在它之前,所以它也不会被自动发送。 */
  isAfterStop: boolean;
  /** 停点行不提供插话(它不会参与当前轮);停点之后的行仍可插话。 */
  canSteer: boolean;
  /** 只有停点之前的行才能成为新停点。 */
  canHold: boolean;
  canRelease: boolean;
  /** 停点与停点之后的行不可拖拽/上下移。 */
  movable: boolean;
  /** 整行弱化;交互中的行由调用方恢复。 */
  dimmed: boolean;
}

/** 停点在下标里的位置;-1 = 没有停点。 */
export function findStopIndex(queue: readonly QueuedMessage[]): number {
  return queue.findIndex((entry) => entry.held === true);
}

/**
 * 重排目标钳制:停点之前的条目不能被移到停点之后。
 * 队列承诺「停点前的都会先发」;桌面排序入口直接进 coordinator.move,没有
 * 协同侧的停点检查,必须在发起侧把插入位置锁在停点(含)之前,否则原本
 * 应执行的条目被顶到停点后不再自动发送。
 */
export function clampReorderAcrossStop(
  queue: readonly QueuedMessage[],
  clientId: string,
  targetIndex: number,
): number {
  const stopIndex = findStopIndex(queue);
  if (stopIndex < 0) return targetIndex;
  const fromIndex = queue.findIndex((item) => item.clientId === clientId);
  // 只有停点之前的条目受钳制;停点行与它之后的条目本就不可发起移动。
  if (fromIndex < 0 || fromIndex >= stopIndex) return targetIndex;
  return Math.min(targetIndex, stopIndex);
}

export function resolveQueueHoldRow(
  stopIndex: number,
  rowIndex: number,
  opts?: { canSteer?: boolean },
): PendingQueueHoldRow {
  const isHeld = stopIndex >= 0 && rowIndex === stopIndex;
  const isAfterStop = stopIndex >= 0 && rowIndex > stopIndex;
  return {
    isHeld,
    isAfterStop,
    canSteer: (opts?.canSteer ?? true) && !isHeld,
    canHold: !isHeld && !isAfterStop,
    canRelease: isHeld,
    movable: !isHeld && !isAfterStop,
    dimmed: isHeld || isAfterStop,
  };
}
