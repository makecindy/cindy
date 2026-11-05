import type { ChatMessage, QueuedMessage, SessionChatState } from './makerChatStore';

export type QueueStopOptions = { keepQueue?: boolean; pauseQueue?: boolean };

export type AbortLockReleaseResult = {
  state: SessionChatState;
  released: boolean;
};

export type QueueTransactionPath =
  | 'send'
  | 'steer'
  | 'stop'
  | 'close'
  | 'retry'
  | 'remove';

export type QueueTransactionContractRow = {
  path: QueueTransactionPath;
  queue: string;
  bubble: string;
  db: string;
  agentAccepted: string;
  preAcceptFailure: string;
  drainBoundary: string;
};

/**
 * Queue / 插话 state transitions live here as pure functions.
 *
 * The store still owns side effects (IPC, DB writes, logging, i18n). This module
 * owns the invariants that kept regressing during the 插话 rollout: FIFO order,
 * drain locks, Stop/Continue abort boundaries, optimistic steer bubble rollback,
 * and retry targeting. Keeping those rules pure makes the next queue change a
 * transition-table edit instead of another scattered `setState` audit.
 */

/**
 * Transaction contract for queued agent input.
 *
 * This feature is a distributed transaction across four owners:
 * pendingQueue (renderer intent), messages[] (visible bubble), local DB
 * (reload history), and maker-core (agent accepted the input). The bugs in this
 * PR mostly came from treating it like a UI feature: one owner advanced while
 * another owner had not accepted yet. Future queue changes should update this
 * table first, then change reducer code and tests to match.
 */
export const QUEUE_TRANSACTION_CONTRACT = [
  {
    path: 'send',
    queue: 'enqueue first; shift only in the dispatch frame',
    bubble: 'append visible user bubble when dispatch starts',
    db: 'persist only after maker.send resolves',
    agentAccepted: 'IPC resolve means maker-core accepted or explicitly opted into accepted-or-rejected semantics',
    preAcceptFailure: 'remove bubble, restore shifted head before tail rows, keep retry token',
    drainBoundary: 'idle dispatch immediately; busy dispatch only from done/status/retry/remove/unlock wake points',
  },
  {
    path: 'steer',
    queue: 'queued-row steer keeps the row until maker.steer resolves; composer fallback re-enters queue if FIFO/busy requires it',
    bubble: 'append optimistic steer bubble before IPC; remove it if marker is cleared or IPC rejects',
    db: 'persist only after maker.steer resolves and marker still exists',
    agentAccepted: 'IPC resolve means current turn accepted the insert or Codex follow-up turn started',
    preAcceptFailure: 'NO_ACTIVE_TURN may fallback only while marker still exists; closed/queue-closed failures never fallback',
    drainBoundary: 'same-turn steer marker blocks drain; success/failure schedules guarded drain',
  },
  {
    path: 'stop',
    queue: 'when keepQueue+pauseQueue, preserve pendingQueue and mark it paused',
    bubble: 'finalize current streaming bubble and remove optimistic steer bubbles',
    db: 'no new user-row persistence on stop',
    agentAccepted: 'abort request is not an acceptance boundary',
    preAcceptFailure: 'pending steer IPC is cancelled by clearing its marker before any fallback',
    drainBoundary: 'queueAbortPending blocks drain until abort settles for Claude or done/status=closed for Codex',
  },
  {
    path: 'close',
    queue: 'do not invent new queued work; preserve existing rows unless caller explicitly clears',
    bubble: 'force-finalize streaming bubbles and remove optimistic steer bubbles',
    db: 'do not persist unaccepted optimistic bubbles',
    agentAccepted: 'closed session cannot accept send/steer',
    preAcceptFailure: 'late send/steer rejection must rollback or cancel, never fallback into a fresh turn',
    drainBoundary: 'status=closed can wake the preserved queue only when it releases a Stop abort lock',
  },
  {
    path: 'retry',
    queue: 'retry for a queue-head failure drains the existing head snapshot',
    bubble: 'new bubble is created by normal dispatch, not by ErrorBanner text',
    db: 'persist only after the retried maker.send resolves',
    agentAccepted: 'same as send',
    preAcceptFailure: 'head remains queued with its retry token until explicit Retry or row removal',
    drainBoundary: 'ErrorBanner Retry schedules guarded drain; Cancel only wakes the tail after an accepted active-turn error',
  },
  {
    path: 'remove',
    queue: 'remove only an undispatched pending row; never remove an in-flight steer row',
    bubble: 'no bubble exists for ordinary queued rows; optimistic steer bubbles are protected by marker',
    db: 'no DB delete is needed for unaccepted queued rows because send persists after acceptance',
    agentAccepted: 'removing a pending row does not talk to maker-core',
    preAcceptFailure: 'removing a failed restored head must not resurrect it',
    drainBoundary: 'successful removal schedules guarded drain for the new head',
  },
] as const satisfies readonly QueueTransactionContractRow[];

export function deriveErrorRetryText(state: SessionChatState): string | null {
  // M32 之后 Retry 按钮的点击走 main 的 retryLastError(忽略文本),这个推导值
  // 只剩「renderer 直发 turn 报错时,让 Retry 按钮立即可见」的兼容 token 职责;
  // main drain 派发的 turn 由 projection 的权威 token 覆盖(见 makerChatStore
  // 终止 error 分支的保留逻辑)。pendingQueue 非空时返回 null 维持历史语义:
  // 该场景以 projection token 为准,不从本地猜。
  if (state.pendingQueue.length > 0) return null;
  return state.activeTurnRetryText;
}

export function queuedMessageRetryToken(queued: QueuedMessage): string {
  return queued.text || `__xdt_queue_retry__:${queued.clientId}`;
}

export function isTurnSteerable(state: SessionChatState): boolean {
  return state.isStreaming || state.agentStatus.isRunning;
}

export function isDispatchBoundaryBusy(state: SessionChatState): boolean {
  return (
    state.isStreaming ||
    state.agentStatus.isRunning ||
    state.pendingPermission !== null ||
    state.pendingAskUser !== null ||
    state.pendingPlanReview !== null ||
    state.queueAbortPending ||
    state.steeringQueueClientIds.length > 0
  );
}

export function isSendBusyForQueue(state: SessionChatState): boolean {
  // queueAbortPending is busy even if the visible queue was just emptied: Stop
  // has asked main to abort the old turn, but that promise has not settled yet.
  return (
    isDispatchBoundaryBusy(state) ||
    state.pendingQueue.length > 0
  );
}

/**
 * Sidebar unsent-content indicator: the session has queued messages that are
 * being held back because the queue is paused (e.g. user hit Stop with
 * `keepQueue`). Pure read — `queuePaused` alone isn't enough (an empty paused
 * queue has nothing unsent); an unpaused non-empty queue is draining normally
 * and is surfaced as "running/busy", not as "unsent".
 */
export function isQueuePausedWithPending(state: SessionChatState): boolean {
  return state.queuePaused && state.pendingQueue.length > 0;
}

export function getDrainableQueueHead(state: SessionChatState): QueuedMessage | null {
  if (state.pendingQueue.length === 0) return null;
  if (state.queuePaused) return null;
  if (state.queueAbortPending) return null;
  if (state.queueInteractionLocks.length > 0) return null;
  const head = state.pendingQueue[0];
  if (!head) return null;
  // 与 main 的 queue-head-held 闸门同口径:停点上的条目永远不可自动派发。
  if (head.held === true) return null;
  if (state.queueEditLocks.includes(head.clientId)) return null;
  // Same-turn 插话进行中时暂停 drain。否则当前 turn 刚结束的 done 事件会启动
  // 下一条队列消息，迟到的 maker:steer 可能被 Claude/Codex 接到新 turn 上。
  if (state.steeringQueueClientIds.length > 0) return null;
  // Defensive: don't dispatch if a stray status-update still says the agent is
  // running. Wake points normally come from done/stop boundaries.
  if (state.isStreaming) return null;
  return head;
}

export function markDispatchStarted(
  state: SessionChatState,
  queued: QueuedMessage,
  dispatchCreatedAt: string,
  opts?: { shiftQueueHead?: boolean },
): SessionChatState {
  return {
    ...state,
    error: null,
    errorRetryText: null,
    isStreaming: true,
    activeTurnRetryText: queued.text || null,
    streamingClientId: null,
    streamingText: '',
    messages: [
      ...state.messages,
      { ...queued.chatMessage, createdAt: dispatchCreatedAt, isPendingPersist: true },
    ],
    pendingQueue: opts?.shiftQueueHead ? state.pendingQueue.slice(1) : state.pendingQueue,
  };
}

export function rollbackPreAcceptSendFailure(
  state: SessionChatState,
  queued: QueuedMessage,
  message: string,
  opts?: { shiftQueueHead?: boolean },
): SessionChatState {
  return {
    ...state,
    error: message,
    // dispatchToSdk shifts the queue head before calling maker.send. If
    // maker.send rejects before the agent accepts the turn (lazy-create,
    // attachment normalization, IPC failure), put that head back in front of any
    // tail rows. Retry recognizes this exact state and drains the existing head
    // instead of appending a duplicate behind the queue.
    errorRetryText: queuedMessageRetryToken(queued),
    activeTurnRetryText: null,
    messages: state.messages.filter((m) => m.clientId !== queued.clientId),
    pendingQueue: opts?.shiftQueueHead && !state.pendingQueue.some((q) => q.clientId === queued.clientId)
      ? [queued, ...state.pendingQueue]
      : state.pendingQueue,
    isStreaming: false,
  };
}

export function setQueueExpandedState(state: SessionChatState, expanded: boolean): SessionChatState {
  return state.queueExpanded === expanded ? state : { ...state, queueExpanded: expanded };
}

export function resumeQueueState(state: SessionChatState): SessionChatState {
  return state.queuePaused ? { ...state, queuePaused: false } : state;
}

export function setQueueInteractionLockState(
  state: SessionChatState,
  lockId: string,
  locked: boolean,
): SessionChatState {
  const hasLock = state.queueInteractionLocks.includes(lockId);
  if (locked) {
    if (hasLock) return state;
    return { ...state, queueInteractionLocks: [...state.queueInteractionLocks, lockId] };
  }
  if (!hasLock) return state;
  return {
    ...state,
    queueInteractionLocks: state.queueInteractionLocks.filter((id) => id !== lockId),
  };
}

export function setQueueEditLockState(
  state: SessionChatState,
  clientId: string,
  locked: boolean,
): SessionChatState {
  const hasLock = state.queueEditLocks.includes(clientId);
  if (locked) {
    if (hasLock) return state;
    return { ...state, queueEditLocks: [...state.queueEditLocks, clientId] };
  }
  if (!hasLock) return state;
  return {
    ...state,
    queueEditLocks: state.queueEditLocks.filter((id) => id !== clientId),
  };
}

export function moveQueueItemState(
  state: SessionChatState,
  clientId: string,
  targetIndex: number,
): SessionChatState {
  if (state.steeringQueueClientIds.includes(clientId)) return state;
  const fromIndex = state.pendingQueue.findIndex((q) => q.clientId === clientId);
  if (fromIndex < 0) return state;
  const next = [...state.pendingQueue];
  const [entry] = next.splice(fromIndex, 1);
  let insertIndex = Math.max(0, Math.min(targetIndex, state.pendingQueue.length));
  if (fromIndex < insertIndex) insertIndex -= 1;
  if (fromIndex === insertIndex) return state;
  if (!entry) return state;
  next.splice(insertIndex, 0, entry);
  return { ...state, pendingQueue: next };
}

export function removeFromQueueState(state: SessionChatState, clientId: string): SessionChatState {
  if (state.steeringQueueClientIds.includes(clientId)) return state;
  const removed = state.pendingQueue.find((q) => q.clientId === clientId);
  const next = state.pendingQueue.filter((q) => q.clientId !== clientId);
  if (next.length === state.pendingQueue.length) return state;
  const removedOwnsRetry = !!removed && state.errorRetryText === queuedMessageRetryToken(removed);
  return {
    ...state,
    pendingQueue: next,
    error: removedOwnsRetry ? null : state.error,
    errorRetryText: removedOwnsRetry ? null : state.errorRetryText,
    queuePaused: next.length > 0 ? state.queuePaused : false,
    steeringQueueClientIds: state.steeringQueueClientIds.filter((id) => id !== clientId),
    queueEditLocks: state.queueEditLocks.filter((id) => id !== clientId),
  };
}

export function updateQueueItemTextState(
  state: SessionChatState,
  clientId: string,
  newText: string,
): SessionChatState {
  if (state.steeringQueueClientIds.includes(clientId)) return state;
  const idx = state.pendingQueue.findIndex((q) => q.clientId === clientId);
  if (idx < 0) return state;
  const entry = state.pendingQueue[idx];
  if (!entry || entry.text === newText) return state;
  let nextPersisted = entry.persistedContent;
  try {
    const parsed = JSON.parse(entry.persistedContent) as Record<string, unknown>;
    nextPersisted = parsed && typeof parsed === 'object'
      ? JSON.stringify({ ...parsed, text: newText })
      : newText;
  } catch {
    nextPersisted = newText;
  }
  const next = [...state.pendingQueue];
  next[idx] = {
    ...entry,
    text: newText,
    persistedContent: nextPersisted,
    chatMessage: { ...entry.chatMessage, content: newText },
  };
  return { ...state, pendingQueue: next };
}

export function enqueueUserMessageState(
  state: SessionChatState,
  queued: QueuedMessage,
): SessionChatState {
  return {
    ...state,
    error: null,
    errorRetryText: null,
    isFirstMessage: false,
    pendingQueue: [...state.pendingQueue, queued],
  };
}

export function clearRetryErrorState(state: SessionChatState): SessionChatState {
  return {
    ...state,
    error: null,
    errorRetryText: null,
  };
}

export function enqueuePreparedMessageState(
  state: SessionChatState,
  queued: QueuedMessage,
): SessionChatState {
  // When a composer 插话 loses the active turn, dispatching it immediately as a
  // fresh turn would bypass existing queued rows, edit locks, and drag locks.
  // Re-enter the normal queue drain path so fallback behavior remains FIFO.
  return {
    ...state,
    error: null,
    errorRetryText: null,
    isFirstMessage: false,
    messages: state.messages.filter((m) => m.clientId !== queued.clientId),
    steeringQueueClientIds: state.steeringQueueClientIds.filter((id) => id !== queued.clientId),
    pendingQueue: state.pendingQueue.some((q) => q.clientId === queued.clientId)
      ? state.pendingQueue
      : [...state.pendingQueue, queued],
  };
}

export function moveQueuedRowToFrontForTurnState(
  state: SessionChatState,
  queued: QueuedMessage,
): SessionChatState {
  const fromIndex = state.pendingQueue.findIndex((q) => q.clientId === queued.clientId);
  if (fromIndex < 0) return state;
  const next = [...state.pendingQueue];
  const [entry] = next.splice(fromIndex, 1);
  if (!entry) return state;
  next.unshift(entry);
  return {
    ...state,
    error: null,
    errorRetryText: null,
    queuePaused: false,
    pendingQueue: next,
    steeringQueueClientIds: state.steeringQueueClientIds.filter((id) => id !== queued.clientId),
    queueEditLocks: state.queueEditLocks.filter((id) => id !== queued.clientId),
  };
}

export function beginSteerDeliveryState(
  state: SessionChatState,
  queued: QueuedMessage,
  deliveryCreatedAt: string,
): SessionChatState {
  return {
    ...state,
    error: null,
    errorRetryText: null,
    isFirstMessage: false,
    messages: state.messages.some((m) => m.clientId === queued.clientId)
      ? state.messages
      : [...state.messages, { ...queued.chatMessage, createdAt: deliveryCreatedAt, isPendingPersist: true }],
    steeringQueueClientIds: state.steeringQueueClientIds.includes(queued.clientId)
      ? state.steeringQueueClientIds
      : [...state.steeringQueueClientIds, queued.clientId],
  };
}

export function cancelSteerBubbleState(
  state: SessionChatState,
  queued: QueuedMessage,
): SessionChatState {
  return {
    ...state,
    messages: state.messages.filter((m) => m.clientId !== queued.clientId),
  };
}

export function clearSteerMarkerBeforeFallbackState(
  state: SessionChatState,
  queued: QueuedMessage,
): SessionChatState {
  return {
    ...state,
    messages: state.messages.filter((m) => m.clientId !== queued.clientId),
    steeringQueueClientIds: state.steeringQueueClientIds.filter((id) => id !== queued.clientId),
  };
}

export function failSteerDeliveryState(
  state: SessionChatState,
  queued: QueuedMessage,
  error: string,
): SessionChatState {
  return {
    ...state,
    error,
    activeTurnRetryText: null,
    errorRetryText: null,
    steeringQueueClientIds: state.steeringQueueClientIds.filter((id) => id !== queued.clientId),
    messages: state.messages.filter((m) => m.clientId !== queued.clientId),
  };
}

export function acceptSteerDeliveryState(
  state: SessionChatState,
  queued: QueuedMessage,
  opts?: { removeFromQueue?: boolean },
): SessionChatState {
  // Same-turn 插话不是“队列的另一种显示方式”，而是已经交给当前 agent turn 的
  // 可见 user message。成功后才从 queue 中移出，避免 expectedTurnId 竞态失败时
  // 把用户输入吞掉；这也是为什么 store action 返回 boolean 供 ChatInput 清草稿。
  return {
    ...state,
    error: null,
    activeTurnRetryText: null,
    errorRetryText: null,
    isFirstMessage: false,
    pendingQueue: opts?.removeFromQueue
      ? state.pendingQueue.filter((q) => q.clientId !== queued.clientId)
      : state.pendingQueue,
    queuePaused: opts?.removeFromQueue && state.pendingQueue.length === 1 ? false : state.queuePaused,
    steeringQueueClientIds: state.steeringQueueClientIds.filter((id) => id !== queued.clientId),
    queueEditLocks: opts?.removeFromQueue
      ? state.queueEditLocks.filter((id) => id !== queued.clientId)
      : state.queueEditLocks,
  };
}

export function canStartQueuedSteer(state: SessionChatState, clientId: string): boolean {
  if (!state.pendingQueue.some((q) => q.clientId === clientId)) return false;
  if (state.queueAbortPending) return false;
  // 插话是 session-scoped，而不是 row-scoped：Claude Code 走同一条输入队列，
  // Codex 还会 interrupt 当前 turn 再启动 follow-up turn。允许第二条插话 IPC
  // 并发进入同一个 session，会把两个“优先处理”的请求变成竞态。
  return state.steeringQueueClientIds.length === 0;
}

export function canStartComposerSteer(state: SessionChatState): boolean {
  if (state.queueAbortPending) return false;
  // Composer 插话和队列行插话共享同一个 vendor turn。这里故意不区分来源:
  // 有任意插话 IPC 在飞时,新的 composer 插话返回 false 让输入框保留草稿,
  // 避免两条“优先处理”请求同时打断/续写同一个 turn。
  return state.steeringQueueClientIds.length === 0;
}

export function resumePausedQueueWithRowNextState(
  state: SessionChatState,
  clientId: string,
): SessionChatState {
  const fromIndex = state.pendingQueue.findIndex((q) => q.clientId === clientId);
  if (fromIndex < 0) return state;
  const next = [...state.pendingQueue];
  const [entry] = next.splice(fromIndex, 1);
  if (!entry) return state;
  next.unshift(entry);
  return {
    ...state,
    error: null,
    errorRetryText: null,
    queuePaused: false,
    pendingQueue: next,
  };
}

export function releaseAbortLockState(state: SessionChatState): AbortLockReleaseResult {
  if (!state.queueAbortPending) return { state, released: false };
  return { state: { ...state, queueAbortPending: false }, released: true };
}

export function stopQueueState(
  state: SessionChatState,
  messagesAfterStop: ChatMessage[],
  opts?: QueueStopOptions,
): SessionChatState {
  const steeringIds = new Set(state.steeringQueueClientIds);
  const visibleMessages = steeringIds.size > 0
    ? messagesAfterStop.filter((m) => !steeringIds.has(m.clientId))
    : messagesAfterStop;
  const shouldPauseQueue = Boolean(opts?.keepQueue && opts?.pauseQueue && state.pendingQueue.length > 0);

  return {
    ...state,
    messages: visibleMessages,
    pendingQueue: opts?.keepQueue ? state.pendingQueue : [],
    steeringQueueClientIds: [],
    queuePaused: shouldPauseQueue,
    // Stop on a blocked/idle queue is only a pause request; there is no vendor
    // turn that can emit done/closed later, so installing queueAbortPending
    // would deadlock Continue. Pending steer markers do count as a boundary:
    // Stop clears the marker now, and only a later NO_ACTIVE_TURN/done/closed
    // boundary may release the lock. A late steer success is not safe enough:
    // it can still be ahead of the old vendor turn actually winding down.
    queueAbortPending: shouldPauseQueue && isDispatchBoundaryBusy(state),
    queueInteractionLocks: opts?.keepQueue ? state.queueInteractionLocks : [],
    queueEditLocks: opts?.keepQueue
      ? state.queueEditLocks.filter((id) => state.pendingQueue.some((q) => q.clientId === id))
      : [],
    // Visual expansion is reset on Stop so the paused banner starts compact; it
    // does not affect whether the queue can resume.
    queueExpanded: false,
  };
}

export function popQueueTailState(state: SessionChatState): { state: SessionChatState; tail: QueuedMessage | null } {
  const tail = state.pendingQueue[state.pendingQueue.length - 1];
  if (!tail) return { state, tail: null };
  if (state.steeringQueueClientIds.includes(tail.clientId)) return { state, tail: null };
  return {
    tail,
    state: {
      ...state,
      pendingQueue: state.pendingQueue.slice(0, -1),
      steeringQueueClientIds: state.steeringQueueClientIds.filter((id) => id !== tail.clientId),
      messages: state.messages.filter((m) => m.clientId !== tail.clientId),
    },
  };
}
