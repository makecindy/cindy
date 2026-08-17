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
 *  - **恢复**:保留距离判定(距底 < threshold),但要求 scroll 事件方向向下 —
 *    否则解除跟随后紧跟着到达的那个用户上滚 scroll 事件(距底仍 < threshold)
 *    会把刚解除的跟随立刻翻回去,修复失效。
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

export interface SelectTailUserMessageArgs<T extends { type: string }> {
  /** 当前有界窗口是否覆盖完整 render-item 尾部。 */
  windowCoversEnd: boolean;
  /** 当前 DOM 窗口最后一个 render item。 */
  visibleLastItem: T | undefined;
  /** 内存中完整 render-item 序列最后一个 item。 */
  realLastItem: T | undefined;
  /** 从 render item 提取 user message id；非 user item 返回 null。 */
  userMessageId: (item: T | undefined) => string | null;
}

/**
 * 选择供「新用户发送」检测的尾消息。
 *
 * bounded window 未覆盖会话末尾时，visible 尾只代表历史切片边界，可能刚好是
 * 一条旧 user message；拿它建基线会误判跳回底部或遮蔽真正的新发送。因此该态
 * 必须无条件读取内存全量的真实尾部。窗口覆盖末尾时 visible 尾与真实尾同义，
 * 保留 visible 路径避免纯扩窗造成额外观察变化。
 */
export function selectTailUserMessageId<T extends { type: string }>({
  windowCoversEnd,
  visibleLastItem,
  realLastItem,
  userMessageId,
}: SelectTailUserMessageArgs<T>): string | null {
  return userMessageId(windowCoversEnd ? visibleLastItem : realLastItem);
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
}

export interface ResolveLastUserMessageObservation {
  /** Baseline to store after observing the current render. */
  baselineUserMessageId: string | null;
  /** Whether the current tail user message is a newly sent message. */
  isNewUserSend: boolean;
}

/**
 * Distinguish restored history hydration from a user send at the tail.
 *
 * A restored stream can mount before its first history batch arrives. If that
 * batch ends in a user message, it must establish the baseline rather than
 * taking ownership from the restored viewport as a new send.
 */
export function resolveLastUserMessageObservation({
  restoring,
  tailUserMessageId,
  previousTailUserMessageId,
}: ResolveLastUserMessageObservationArgs): ResolveLastUserMessageObservation {
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
 * An anchored window that still covers the end at send time would otherwise
 * stay anchored; the next appended items flip `windowCoversEnd` to false and
 * the stream treats that as "left the bottom", stopping follow. External
 * injections must not take this handoff (#2194).
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
 */
export function resolveNearBottomOnScroll({
  wasNearBottom,
  distanceFromBottom,
  scrollDelta,
  thresholdPx,
  directionDeadZonePx,
}: ResolveNearBottomArgs): boolean {
  if (distanceFromBottom >= thresholdPx) {
    if (!wasNearBottom) return false;
    return scrollDelta >= -directionDeadZonePx;
  }
  if (wasNearBottom) return true;
  return scrollDelta > directionDeadZonePx;
}
