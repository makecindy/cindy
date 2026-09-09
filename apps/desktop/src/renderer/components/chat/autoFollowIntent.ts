/**
 * autoFollowIntent — auto-follow(流式贴底跟随)的解除 / 恢复判定纯函数集。
 * ---------------------------------------------------------------------------
 * 修复背景(2026-07 用户实报):流式输出期间「是否在底部」原来只有一条规则 —
 * `distanceFromBottom < 100px` 的纯距离判定。用户上滚一格滚轮(~40px)时距离
 * 仍 < 100px → 仍被判「在底」→ 下一批 token 到达,pin-to-bottom 又把 scrollTop
 * 钉回最底 → 下一格滚轮又从最底起步,永远越不过阈值。只有一次快速滚多行、在
 * 两次 pin 的间隙里瞬间离底超过 100px 才能停下自动滚动。叠加因素:pin 会短暂
 * 打开 programmaticScrollRef(rAF 后才清),流式期间 pin 几乎每帧发生,用户的
 * scroll 事件有相当比例落在该窗口内被当作程序滚动直接忽略,连参与距离判定的
 * 机会都没有。
 *
 * 修复思路:「解除跟随」与「恢复跟随」用不同的信号(VSCode 终端 / 各聊天流的
 * 通行做法):
 *  - **解除**:看用户输入意图,不看距离。wheel 上滚 / 触摸下拉 / PageUp 等
 *    只有用户能产生(程序化 scrollTop 赋值不发 wheel 事件),没有上述竞态,
 *    滚一行(哪怕一像素)立即解除,确定性响应。
 *  - **恢复**:两条互补信号,都不能只看「距底 < 100」:
 *      1. scroll 事件:距底 < threshold 且方向明确向下(防解除后紧跟的上滚
 *         scroll 把跟随立刻翻回去);
 *      2. 用户已经贴死底部(距底 ≤ REPIN_AT_BOTTOM_PX)时的向下意图
 *         (wheel / 触控上滑)。人已经在最底时继续往下滚往往不再产生
 *         scroll 事件,只靠 1 会表现为「滚到最后了,新生成却不跟」。
 *
 * 抽成纯函数为了单测覆盖 + 与 React 副作用解耦,pattern 同
 * scrollAnchoringDetect / viewportFillDetect。
 */

/**
 * 容器「真的可滚」的最小滚动余量(px)。
 * 与 viewportFillDetect.NO_SCROLL_TOLERANCE_PX 同源语义:DPR≠1 环境下
 * scrollHeight 可能比 clientHeight 大 1px 的 sub-pixel 圆整,视觉上滚不动。
 * 内容还没撑满一屏时不解除跟随 — 此时解除毫无视觉意义,却会在内容长出
 * 滚动条后表现为「不跟了」,而且因为滚不动、没有 scroll 事件,用户无法用
 * 「滚回底部」恢复跟随,等于永久失联。
 */
export const UNPIN_MIN_SCROLLABLE_PX = 1;

/**
 * 「已经贴死底部」的距离(px)。比 100px 近底阈值小一档:
 * 典型一格滚轮约 40px,停在这里说明人就在视口底,不是刚上滚一格后的残留。
 * 用于 wheel / 触控的恢复意图,以及 scroll 事件在 delta≈0 时的落地恢复。
 */
export const REPIN_AT_BOTTOM_PX = 8;

export interface WheelUnpinArgs {
  /** wheel 事件的 deltaX(水平分量,用于主轴判定) */
  deltaX: number;
  /** wheel 事件的 deltaY(负 = 向上) */
  deltaY: number;
  /** scroll 容器当前 scrollHeight */
  scrollHeight: number;
  /** scroll 容器当前 clientHeight */
  clientHeight: number;
}

/**
 * wheel 事件是否构成「用户想向上滚、应解除 auto-follow」。
 *
 * 条件(全部满足):
 *  - deltaY < 0:向上;
 *  - |deltaY| >= |deltaX|:垂直是主轴。触控板在横向可滚区域(如 overflow-x 的
 *    代码块,hasNestedScrollableAncestorThatCanScrollUp 只查纵向祖先拦不住)
 *    做水平平移时常带微小的负 deltaY 抖动,不加主轴判定会被误判成上滚意图、
 *    随手一划就停掉跟随;
 *  - 容器可滚(见 UNPIN_MIN_SCROLLABLE_PX)。
 *
 * caller 还需自行排除「事件目标在嵌套可滚祖先内」(DOM 查询,不属于纯函数)。
 */
export function shouldUnpinOnWheel({
  deltaX,
  deltaY,
  scrollHeight,
  clientHeight,
}: WheelUnpinArgs): boolean {
  if (deltaY >= 0) return false;
  if (Math.abs(deltaY) < Math.abs(deltaX)) return false;
  return scrollHeight - clientHeight > UNPIN_MIN_SCROLLABLE_PX;
}

export interface UpIntentUnpinArgs {
  /** scroll 容器当前 scrollHeight */
  scrollHeight: number;
  /** scroll 容器当前 clientHeight */
  clientHeight: number;
}

/**
 * 非 wheel 的向上意图(触摸下拉已过阈值 / PageUp 等历史导航键)是否应解除
 * auto-follow。方向语义由 caller 的事件分支保证(touchmove 下拉阈值 /
 * HISTORY_NAVIGATION_KEYS 白名单),这里只补「容器可滚」守卫。
 */
export function shouldUnpinOnUpIntent({ scrollHeight, clientHeight }: UpIntentUnpinArgs): boolean {
  return scrollHeight - clientHeight > UNPIN_MIN_SCROLLABLE_PX;
}

export interface ScrollbarDragUnpinArgs {
  /** 指针仍按在滚动容器上(滚动条拖拽中)。 */
  pointerDown: boolean;
  /** 相对按下时的 scrollTop 增量(负 = 向上)。 */
  scrollDelta: number;
  /** 方向判断死区(px)。 */
  directionDeadZonePx: number;
}

/**
 * 滚动条拖拽是否构成「用户想向上离开尾部」。
 *
 * 只认按下后的实际上移,不认单纯 mousedown:生成期间点一下滑块不该掐死跟随。
 * 流式 pin 会把 programmatic scroll 窗口几乎一直打开,handleScroll 的普通
 * 用户分支看不见这次拖拽,必须用按下态 + scrollTop 上移单独判定。
 */
export function shouldUnpinOnScrollbarDrag({
  pointerDown,
  scrollDelta,
  directionDeadZonePx,
}: ScrollbarDragUnpinArgs): boolean {
  return pointerDown && scrollDelta < -directionDeadZonePx;
}

export interface VerticalScrollbarPressArgs {
  /** mousedown 的 target 是否就是滚动容器本身。 */
  targetIsRoot: boolean;
  /** 相对滚动容器的 offsetX。 */
  offsetX: number;
  /** 滚动容器 clientWidth(不含纵向滚动条)。 */
  clientWidth: number;
}

/**
 * 这次 mousedown 是否落在纵向滚动条上。
 *
 * 滚动条生命周期不变量:
 *  - 进入拖拽:只有点到滑块/槽(target === 容器且 offsetX ≥ clientWidth);
 *    正文、链接、按钮上的按下不能进拖拽态,否则长按选字会停 pin、松手又被钉回;
 *  - 拖拽中:抑制 pin,scrollTop 上移过死区才 unpin;
 *  - 松开:若仍在跟随,补一次 pin(按住期间最后一批 token 可能已经 settle)。
 */
export function isVerticalScrollbarPress({
  targetIsRoot,
  offsetX,
  clientWidth,
}: VerticalScrollbarPressArgs): boolean {
  return targetIsRoot && offsetX >= clientWidth;
}

export interface WheelRepinArgs {
  /** wheel 事件的 deltaX(水平分量,用于主轴判定) */
  deltaX: number;
  /** wheel 事件的 deltaY(正 = 向下) */
  deltaY: number;
  /** 当前距底距离(scrollHeight - scrollTop - clientHeight) */
  distanceFromBottom: number;
}

/**
 * wheel 事件是否构成「用户已在底部、应恢复 auto-follow」。
 *
 * 与 shouldUnpinOnWheel 对称:看意图不看「能不能再滚」。人已经贴死底部时
 * 继续往下滚通常不再改变 scrollTop,handleScroll 收不到向下 delta,必须
 * 在 wheel 层恢复。距底必须 ≤ REPIN_AT_BOTTOM_PX,避免刚上滚一格(约 40px)
 * 后的回弹/惯性把跟随立刻翻回去。
 */
export function shouldRepinOnWheel({
  deltaX,
  deltaY,
  distanceFromBottom,
}: WheelRepinArgs): boolean {
  if (deltaY <= 0) return false;
  if (Math.abs(deltaY) < Math.abs(deltaX)) return false;
  return distanceFromBottom <= REPIN_AT_BOTTOM_PX;
}

export interface DownIntentRepinArgs {
  /** 当前距底距离(scrollHeight - scrollTop - clientHeight) */
  distanceFromBottom: number;
}

/**
 * 非 wheel 的向下意图(触摸上滑已过阈值)是否应恢复 auto-follow。
 * 方向语义由 caller 的事件分支保证,这里只判「已经贴死底部」。
 */
export function shouldRepinOnDownIntent({ distanceFromBottom }: DownIntentRepinArgs): boolean {
  return distanceFromBottom <= REPIN_AT_BOTTOM_PX;
}

export interface SelectTailUserMessageArgs<T extends { type: string }> {
  /** 当前有界窗口是否覆盖完整 render-item 尾部。 */
  windowCoversEnd: boolean;
  /** 当前 DOM 窗口的 render items。 */
  visibleItems: readonly T[];
  /** 内存中完整 render-item 序列。 */
  allItems: readonly T[];
  /** 从 render item 提取 user message id；非 user item 返回 null。 */
  userMessageId: (item: T | undefined) => string | null;
}

/** Walk items from the tail and return the first matching value. */
export function findLastMatching<T, U>(items: readonly T[], pick: (item: T) => U | null): U | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const value = pick(items[i]);
    if (value) return value;
  }
  return null;
}

/** Walk items from the tail and return the first matching id. */
export function findLastMatchingId<T>(
  items: readonly T[],
  pickId: (item: T) => string | null,
): string | null {
  return findLastMatching(items, pickId);
}

/**
 * 选择供「新用户发送」检测的尾消息。
 *
 * bounded window 未覆盖会话末尾时，visible 尾只代表历史切片边界，可能刚好是
 * 一条旧 user message；拿它建基线会误判跳回底部或遮蔽真正的新发送。因此该态
 * 必须无条件读取内存全量的真实尾部。窗口覆盖末尾时从 visible 尾往回找最近
 * 一条 user——发送后同一帧 assistant / 工具卡已经接在后面时，只看最后一项
 * 会把本次发送漏掉，后续不再强制跟底。
 */
export function selectTailUserMessageId<T extends { type: string }>({
  windowCoversEnd,
  visibleItems,
  allItems,
  userMessageId,
}: SelectTailUserMessageArgs<T>): string | null {
  return findLastMatchingId(windowCoversEnd ? visibleItems : allItems, userMessageId);
}

export interface ResolveRenderPinArgs {
  /** A saved non-bottom viewport is currently being restored. */
  restoring: boolean;
  /** The current render introduced a new user message at the tail. */
  newUserSend: boolean;
  /**
   * The tail user message was sent from this renderer's composer (local send,
   * edit-resend, or a device-link send initiated on this desktop). User
   * messages injected by other entries (IM channels, a mobile client driving
   * the session remotely, scheduler runs) arrive over IPC with no local
   * composer intent and must not steal the viewport (#2194).
   */
  sentFromThisRenderer: boolean;
  /** Auto-follow was active before this render. */
  nearBottom: boolean;
}

export interface ResolveRenderPinDecision {
  /** Explicit sends hand ownership back to the latest-message anchor. */
  clearRestoring: boolean;
  /** Pin the scroll container to its content end in this layout pass. */
  pinToBottom: boolean;
}

export interface ResolveLastUserMessageObservationArgs {
  /** A saved non-bottom viewport is currently being restored. */
  restoring: boolean;
  /** The current render's tail user message, if any. */
  tailUserMessageId: string | null;
  /** The last tail user message already observed by the mounted stream. */
  previousTailUserMessageId: string | null;
  /**
   * Every user message id already loaded on this mount. Receding the tail to
   * any of these (rollback, rewind, remount) is not a send.
   */
  knownUserMessageIds?: ReadonlySet<string>;
}

export interface ResolveLastUserMessageObservation {
  /** Baseline to store after observing the current render. */
  baselineUserMessageId: string | null;
  /** Whether the current tail user message is a newly sent message. */
  isNewUserSend: boolean;
}

/** Collect every user message id currently present. */
export function collectKnownUserMessageIds<T>(
  items: readonly T[],
  userMessageId: (item: T) => string | null,
): Set<string> {
  const ids = new Set<string>();
  for (const item of items) {
    const id = userMessageId(item);
    if (id) ids.add(id);
  }
  return ids;
}

/**
 * A tail-user change follows as a send only when that user id is new to this
 * mount. Rollback, rewind, remount, and history hydration re-expose ids that
 * were already loaded — those only move the baseline.
 */
export function resolveLastUserMessageObservation({
  restoring,
  tailUserMessageId,
  previousTailUserMessageId,
  knownUserMessageIds,
}: ResolveLastUserMessageObservationArgs): ResolveLastUserMessageObservation {
  if (
    tailUserMessageId !== null &&
    tailUserMessageId !== previousTailUserMessageId &&
    knownUserMessageIds?.has(tailUserMessageId)
  ) {
    return { baselineUserMessageId: tailUserMessageId, isNewUserSend: false };
  }
  const baselineUserMessageId =
    restoring && previousTailUserMessageId === null && tailUserMessageId !== null
      ? tailUserMessageId
      : previousTailUserMessageId;
  return {
    baselineUserMessageId,
    isNewUserSend: tailUserMessageId !== null && tailUserMessageId !== baselineUserMessageId,
  };
}

/**
 * Resolve the render-time priority between a saved history anchor and auto-follow.
 * Reopening a session must preserve a real reading position, but a user message
 * sent from this renderer during that mounted session is an explicit request to
 * resume at the tail. A user message injected by another entry (IM channel,
 * mobile client, scheduler) carries no such intent: it follows the ordinary
 * rule — pin only while the user is still near the bottom.
 */
export function resolveRenderPinDecision({
  restoring,
  newUserSend,
  nearBottom,
  sentFromThisRenderer,
}: ResolveRenderPinArgs): ResolveRenderPinDecision {
  if (newUserSend && sentFromThisRenderer) {
    return { clearRestoring: restoring, pinToBottom: true };
  }
  if (restoring) return { clearRestoring: false, pinToBottom: false };
  return { clearRestoring: false, pinToBottom: nearBottom };
}

export interface ResolveSendWindowHandoffArgs {
  /** The current render introduced a new user message at the tail. */
  isNewUserSend: boolean;
  /** The tail user message was sent from this renderer's composer. */
  sentFromThisRenderer: boolean;
  /** The stream is currently showing an anchored (non-default-tail) window. */
  hasWindowAnchor: boolean;
  /** The current bounded window already includes the real session tail. */
  windowCoversEnd: boolean;
}

export interface ResolveSendWindowHandoff {
  /** Local send while reading an anchored window: switch back to the default tail. */
  clearWindowAnchor: boolean;
  /**
   * The current visible slice does not include the real tail, so pinning this
   * frame would land on the old slice. Wait for the next render's tail window.
   */
  deferPinToNextRender: boolean;
}

/**
 * After a local send, leave any historical render window so later assistant /
 * tool items keep auto-following the real tail.
 *
 * An anchored window that still covers the end at send time used to stop
 * following as soon as the next item moved the real tail past its bound. Local
 * sends hand off eagerly so the optimistic row is shown at the real tail; the
 * generic coverage-loss handoff below protects anchors created by auto-fill.
 * External injections must not take this eager handoff (#2194).
 */
export function resolveSendWindowHandoff({
  isNewUserSend,
  sentFromThisRenderer,
  hasWindowAnchor,
  windowCoversEnd,
}: ResolveSendWindowHandoffArgs): ResolveSendWindowHandoff {
  const clearWindowAnchor = isNewUserSend && sentFromThisRenderer && hasWindowAnchor;
  return {
    clearWindowAnchor,
    deferPinToNextRender: clearWindowAnchor && !windowCoversEnd,
  };
}

export type WindowCoverageLossAction = 'none' | 'handoff-to-tail' | 'preserve-anchor';

export interface ResolveWindowCoverageLossArgs {
  /** The stream is currently showing an anchored (non-default-tail) window. */
  hasWindowAnchor: boolean;
  /** The anchored window covered the real session tail before this render. */
  wasCoveringEnd: boolean;
  /** The anchored window still covers the real session tail after this render. */
  windowCoversEnd: boolean;
  /** Auto-follow intent before the tail item was appended. */
  wasFollowingTail: boolean;
}

/**
 * Decide how an anchored render window should react when an appended item moves
 * the real session tail beyond its bounded end.
 *
 * An automatically expanded window can still be following the tail. In that
 * case the bounded anchor is only an implementation detail, so hand it back to
 * the default tail window instead of interpreting the append as user scroll
 * intent. A user who already left the tail keeps the anchored reading window.
 */
export function resolveWindowCoverageLossAction({
  hasWindowAnchor,
  wasCoveringEnd,
  windowCoversEnd,
  wasFollowingTail,
}: ResolveWindowCoverageLossArgs): WindowCoverageLossAction {
  if (!hasWindowAnchor || !wasCoveringEnd || windowCoversEnd) return 'none';
  return wasFollowingTail ? 'handoff-to-tail' : 'preserve-anchor';
}

export interface ResolveNearBottomArgs {
  /** scroll 事件前的跟随态(isNearBottomRef) */
  wasNearBottom: boolean;
  /** 当前距底距离(scrollHeight - scrollTop - clientHeight) */
  distanceFromBottom: number;
  /** 本次 scroll 事件的 scrollTop 增量(正 = 向下) */
  scrollDelta: number;
  /** 「近底」距离阈值(px) */
  thresholdPx: number;
  /** 方向判断死区(px),增量绝对值不超过它不算方向 */
  directionDeadZonePx: number;
  /**
   * 「已经贴死底部」的距离(px)。已解除且距底不超过它、且不是上滚时恢复跟随。
   * 人滚到最底后最后一次 scroll 常为 delta≈0,只靠向下方向会永远恢复不了。
   */
  atBottomPx?: number;
}

/**
 * scroll 事件驱动的跟随态迁移(handleScroll 消费)。
 *
 *  - 距底 >= threshold 且(已解除, 或明确上滚) → false。这是滚动条拖拽
 *    等无 wheel 路径的解除兜底。**已在跟、却只是内容在下方长高**
 *    (发送后首块 assistant / 工具卡撑高、迟到的程序化 scroll 事件)
 *    不得解除 — pin / ResizeObserver 会补上。
 *  - 距底 < threshold 且原本在跟 → 保持 true。阈值带内的微小上移不在这里
 *    解除(滚动条微拖、布局收缩钳位等 scrollTop 被动上移会误伤),wheel /
 *    touch / 键盘的意图解除路径已经覆盖了真实的用户上滚。
 *  - 距底 < threshold 且原本没在跟 → 只有明确向下(delta > 死区)才恢复
 *    跟随。**不能只看距离**:意图解除后紧跟着到达的用户上滚 scroll 事件距底
 *    仍 < threshold,若无方向守卫会把刚解除的跟随立刻翻回去(修复的核心)。
 *  - 已贴死底部(距底 ≤ atBottomPx)且不是上滚(delta ≥ 0)→ 恢复。人已经在
 *    最底时最后一次 scroll 常为 delta≈0;1px 上滚解除后的 scroll 带负 delta,
 *    不会误恢复。
 */
export function resolveNearBottomOnScroll({
  wasNearBottom,
  distanceFromBottom,
  scrollDelta,
  thresholdPx,
  directionDeadZonePx,
  atBottomPx = REPIN_AT_BOTTOM_PX,
}: ResolveNearBottomArgs): boolean {
  if (distanceFromBottom >= thresholdPx) {
    if (!wasNearBottom) return false;
    return scrollDelta >= -directionDeadZonePx;
  }
  if (wasNearBottom) return true;
  if (distanceFromBottom <= atBottomPx && scrollDelta >= 0) return true;
  return scrollDelta > directionDeadZonePx;
}

export interface ResolveEffectiveNearBottomArgs {
  /** Current bounded window includes the real session tail. */
  windowCoversEnd: boolean;
  /** Distance/direction resolver result for this scroll event. */
  nowNearBottom: boolean;
  /** Follow state before this scroll event. */
  wasNearBottom: boolean;
}

/**
 * Combine slice coverage with the scroll-event follow decision.
 *
 * A historical slice scrolled to its own bottom is not the session tail, so
 * we must not *start* following there. An explicit follow (composer send /
 * jump-to-latest) already set wasNearBottom; a late scroll event while the
 * window has not yet switched back to the default tail must not cancel it.
 */
export function resolveEffectiveNearBottom({
  windowCoversEnd,
  nowNearBottom,
  wasNearBottom,
}: ResolveEffectiveNearBottomArgs): boolean {
  if (windowCoversEnd) return nowNearBottom;
  return wasNearBottom ? nowNearBottom : false;
}

/**
 * A composer send that started on session A must not pin session B after the
 * user switched routes. FadeSwitcher only remounts on the first path segment,
 * so CCAgentSessionView state survives `/cc-agent/:id` changes.
 */
export function shouldApplyFollowLatestRequest(
  sourceSessionId: string | null | undefined,
  currentSessionId: string | null | undefined,
): boolean {
  return Boolean(sourceSessionId && sourceSessionId === currentSessionId);
}

const sendFollowCancelGenerations = new Map<string, number>();

export function readSendFollowCancelGeneration(sessionId: string | null | undefined): number {
  if (!sessionId) return 0;
  return sendFollowCancelGenerations.get(sessionId) ?? 0;
}

/** User up-intent on this stream cancels a still-pending follow-latest. */
export function bumpSendFollowCancelGeneration(sessionId: string | null | undefined): void {
  if (!sessionId) return;
  sendFollowCancelGenerations.set(sessionId, (sendFollowCancelGenerations.get(sessionId) ?? 0) + 1);
}

export function shouldBumpSendFollowCancelOnScroll({
  wasNearBottom,
  effectiveNearBottom,
}: {
  wasNearBottom: boolean;
  effectiveNearBottom: boolean;
  scrollDelta: number;
  directionDeadZonePx: number;
}): boolean {
  // Only leaving the tail cancels a pending follow. Continued up-scroll while
  // already away is leftover reading inertia and must not void the next send.
  return wasNearBottom && !effectiveNearBottom;
}

export function shouldCommitFollowLatestRequest({
  sourceSessionId,
  currentSessionId,
  startGeneration,
  currentGeneration,
}: {
  sourceSessionId: string | null | undefined;
  currentSessionId: string | null | undefined;
  startGeneration: number;
  currentGeneration: number;
}): boolean {
  if (!shouldApplyFollowLatestRequest(sourceSessionId, currentSessionId)) return false;
  return startGeneration === currentGeneration;
}

const followLatestListeners = new Set<() => void>();
const followLatestRequests = new Map<string, number>();

export function subscribeFollowLatestRequests(onStoreChange: () => void): () => void {
  followLatestListeners.add(onStoreChange);
  return () => {
    followLatestListeners.delete(onStoreChange);
  };
}

export function readFollowLatestRequestKey(sessionId: string | null | undefined): number {
  if (!sessionId) return 0;
  return followLatestRequests.get(sessionId) ?? 0;
}

/** Accepted local send from any entry (composer, edit-resend) requests follow. */
export function tryRequestFollowLatest({
  sourceSessionId,
  currentSessionId,
  startGeneration,
}: {
  sourceSessionId: string | null | undefined;
  currentSessionId: string | null | undefined;
  startGeneration: number;
}): boolean {
  if (
    !shouldCommitFollowLatestRequest({
      sourceSessionId,
      currentSessionId,
      startGeneration,
      currentGeneration: readSendFollowCancelGeneration(sourceSessionId),
    })
  ) {
    return false;
  }
  if (!sourceSessionId) return false;
  followLatestRequests.set(sourceSessionId, (followLatestRequests.get(sourceSessionId) ?? 0) + 1);
  for (const listener of followLatestListeners) listener();
  return true;
}
