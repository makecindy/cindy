/**
 * sessionStartingStore —— 「用户已按下发送、agent 尚未进入 isRunning」的会话集合。
 *
 * 侧栏按优先级排序时,running 档只认 makerChatStore 的真实 isRunning。新建 /
 * 刚发送的任务在 worktree、hydrate、enqueue、进程拉起这段空窗里还是 rest,
 * 会先沉到所有运行中任务下面,等真正跑起来再跳到 running 档顶 —— 列表自己
 * 抖一下。这里把「我已经发出去了」提前记成 starting,组装层并进 display
 * running,排序和呼吸点与运行中同档,但不碰 isRunning(done 通知 / 归档闸门 /
 * LRU 仍只认真 running)。
 *
 * 生命周期:乐观 userSendAt / sendMessage 置位;真实 running、远程权威状态、
 * 发送失败或 TTL 清除。
 */

import { useEffect, useSyncExternalStore } from 'react';

import { dropStaleRemoteTerminalActivity } from '@/features/device-link/remoteSessionActivityStore';

/** 发送失败 / 状态一直不到时的兜底;正常路径应在 agent 开跑时就被吸收。 */
export const SESSION_STARTING_TTL_MS = 120_000;

const listeners = new Set<() => void>();
const startingIds = new Set<string>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
/** 不可变快照,只在 emit 时重建 —— 无变化时返回同一引用。 */
let snapshot: ReadonlySet<string> = new Set();

function emit(): void {
  snapshot = new Set(startingIds);
  for (const listener of listeners) listener();
}

function clearTimer(sessionId: string): void {
  const timer = timers.get(sessionId);
  if (timer === undefined) return;
  clearTimeout(timer);
  timers.delete(sessionId);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getStartingSessionIds(): ReadonlySet<string> {
  return snapshot;
}

/** 用户已提交发送。重复标记只刷新 TTL,不抖快照。 */
export function markSessionStarting(sessionId: string): void {
  if (!sessionId) return;
  const already = startingIds.has(sessionId);
  if (!already) {
    // 先丢掉上一轮远程终态,再置 starting。否则 absorb 会把旧 completed/error
    // 当成新权威立刻清掉。重复 mark 只刷新 TTL,不能再删本轮新到达的终态。
    dropStaleRemoteTerminalActivity(sessionId);
    startingIds.add(sessionId);
  }
  clearTimer(sessionId);
  timers.set(
    sessionId,
    setTimeout(() => {
      timers.delete(sessionId);
      if (!startingIds.delete(sessionId)) return;
      emit();
    }, SESSION_STARTING_TTL_MS),
  );
  if (!already) emit();
}

export function clearSessionStarting(sessionId: string): void {
  if (!sessionId) return;
  clearTimer(sessionId);
  if (!startingIds.delete(sessionId)) return;
  emit();
}

/** 会话已有权威活档(真 running / 等你处理 / 完成未读 / 远程状态)时收掉 starting。 */
export function absorbSessionStarting(settledSessionIds: Iterable<string>): void {
  let changed = false;
  for (const sessionId of settledSessionIds) {
    if (!startingIds.has(sessionId)) continue;
    clearTimer(sessionId);
    startingIds.delete(sessionId);
    changed = true;
  }
  if (changed) emit();
}

/**
 * 当前 starting 集合。传入 settledSessionIds 时,在 effect 里吸收已经有权威
 * 状态的 id —— 调用方应传**真** running / attention,不要传已经并进 starting
 * 的 display running,否则会立刻把自己清掉。
 */
export function useStartingSessionIds(
  settledSessionIds?: ReadonlySet<string>,
): ReadonlySet<string> {
  const starting = useSyncExternalStore(subscribe, getStartingSessionIds, getStartingSessionIds);
  useEffect(() => {
    if (!settledSessionIds || settledSessionIds.size === 0) return;
    absorbSessionStarting(settledSessionIds);
  }, [settledSessionIds, starting]);
  return starting;
}

/** 测试收尾。 */
export function resetSessionStartingStoreForTests(): void {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  startingIds.clear();
  snapshot = new Set();
  listeners.clear();
}
