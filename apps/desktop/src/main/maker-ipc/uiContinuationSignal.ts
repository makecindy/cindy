/**
 * main/maker-ipc/uiContinuationSignal.ts
 * ---------------------------------------------------------------------------
 * 把「桌面端续跑」这件事的几个关键时刻发成进程内信号, 供 hook-control 把那一轮的
 * 结果接回渠道里那条已经收口的消息(协议阶段 18 的 turn.reopen)。
 *
 * 消费者是 hook-control: 一个 hook 任务以失败收口后, 渠道里那条消息就停在失败上;
 * 用户往往转头在桌面端点「重试」, 那会在同一会话里起一个新 turn, 但它是 origin=user
 * 的普通 turn, hook 早已摘掉监听、协议里也没有会话级通道 —— 结果是任务确实继续跑了
 * 而渠道消息永远不动。
 *
 * ## 归属键: clientId
 *
 * 这里的核心不是"有没有续跑", 而是**哪一轮**才是那条渠道消息的延续。事件流里没有这个
 * 信息(AgentEvent.turnOrigin 只有 kind), 所以早先只能靠"首个事件 + isBusy 快照 +
 * 固定超时"推断 —— 那套推断关不完窗口: 绕过 coordinator 的路径(silent-stop 自动续跑)
 * 照样能 send, 远端会话冷启动又可能慢过任何固定窗口。
 *
 * 现在改用 coordinator 手里的 `clientId` 作权威归属键, 三个时刻各发一条信号:
 *
 *   1. `retry(sessionId, clientId)` —— 用户点了错误横幅「重试」(retryLastError)。
 *      **必须走回调而不能靠文本认**: retryLastError 只在失败 turn 已有产出时才改发
 *      CONTINUE_AFTER_ERROR_PROMPT; 零产出(派发即失败 / 首个 API 调用就挂 —— 上游
 *      过载最典型、也最需要回流的形态)走的是克隆重发原文, 文本上与普通消息无从区分。
 *   2. `turnDispatching(sessionId, clientId)` —— 那条消息即将 vendor dispatch
 *      (coordinator 的 beforeDispatchUserTurn, 被 await)。clientId 对得上就是目标轮:
 *      此刻挂监听不丢正文开头, 而 live session 必然已就绪(马上就要 dispatch)。
 *      绕过 coordinator 的 turn 不产生本信号, 于是结构上不可能被误认。
 *   3. `turnUndispatched(sessionId, clientId)` —— 那条消息落库了却没能 dispatch
 *      (取消 / 失败)。目标轮没起来, 记账该还回去, 而不是等超时。
 *
 * 另有一条与归属无关、但同样必要的信号:
 *   - `sessionIntervention(sessionId)` —— 会话被一条**新**消息推进(enqueue 入口)。
 *     记账只按 sessionId 记, 而"重试哪一轮"与"渠道消息对应哪一轮"是两件事: 用户跑过
 *     无关 turn 之后点重试, 重试的是那个无关 turn, 不该把它的输出写进渠道旧消息。
 *     判据是**入口**而不是文本: 零产出重试重发原文, 按文本判会让它撤掉自己。
 *
 * 中断横幅「继续任务」不经 retryLastError(renderer 直发 CONTINUE_AFTER_APP_EXIT_PROMPT),
 * 但它照样经 coordinator 的 enqueue —— 那里能同时看到 originalSyntheticTrigger 与
 * clientId, 所以它也从 enqueue 发意图信号。于是**两条续跑来源都在 coordinator 里、
 * 都带 clientId**, 发送事务上那条按文本认的兜底判定随之取消(它是唯一拿不到归属键的
 * 来源, 留着只会让"有没有归属"这件事分叉)。
 *
 * 依赖方向与 register.ts 的 onSilentStopSettled 一致: maker-ipc 发布, hook-control
 * 订阅 —— 反向依赖会把 Electron/hook 拉进发送事务。
 */

/** 按 clientId 归属的 turn 信号(续跑意图与生命周期共用同一形态)。 */
export type UiTurnAttributionListener = (sessionId: string, clientId: string) => void;
export type UiSessionListener = (sessionId: string) => void;

const retryListeners = new Set<UiTurnAttributionListener>();
const dispatchingListeners = new Set<UiTurnAttributionListener>();
const undispatchedListeners = new Set<UiTurnAttributionListener>();
const interventionListeners = new Set<UiSessionListener>();

/** 旁路通知: 监听方抛错不影响这一轮 turn(回流是增强, 不是关键路径)。 */
function fanout<T extends (...args: never[]) => void>(set: Set<T>, invoke: (listener: T) => void) {
  for (const listener of [...set]) {
    try {
      invoke(listener);
    } catch {
      // best-effort
    }
  }
}

/** 订阅「用户显式续跑了某会话」; 返回退订函数。 */
export function onUiContinuation(listener: UiTurnAttributionListener): () => void {
  retryListeners.add(listener);
  return () => {
    retryListeners.delete(listener);
  };
}

/** 发布一次续跑意图。clientId 是消费方做归属匹配的键, 恒有值。 */
export function publishUiContinuation(sessionId: string, clientId: string): void {
  fanout(retryListeners, (l) => l(sessionId, clientId));
}

/** 订阅「这条消息即将 vendor dispatch」(权威归属点, 见模块注释)。 */
export function onUiTurnDispatching(listener: UiTurnAttributionListener): () => void {
  dispatchingListeners.add(listener);
  return () => {
    dispatchingListeners.delete(listener);
  };
}

export function publishUiTurnDispatching(sessionId: string, clientId: string): void {
  fanout(dispatchingListeners, (l) => l(sessionId, clientId));
}

/** 订阅「这条消息落库了却没能 dispatch」(目标轮没起来, 记账该还回去)。 */
export function onUiTurnUndispatched(listener: UiTurnAttributionListener): () => void {
  undispatchedListeners.add(listener);
  return () => {
    undispatchedListeners.delete(listener);
  };
}

export function publishUiTurnUndispatched(sessionId: string, clientId: string): void {
  fanout(undispatchedListeners, (l) => l(sessionId, clientId));
}

/** 订阅「某会话被一条新消息推进了」(enqueue 入口; 见模块注释)。 */
export function onUiSessionIntervention(listener: UiSessionListener): () => void {
  interventionListeners.add(listener);
  return () => {
    interventionListeners.delete(listener);
  };
}

export function publishUiSessionIntervention(sessionId: string): void {
  fanout(interventionListeners, (l) => l(sessionId));
}

/** 仅供测试: 清空订阅, 防跨用例串台。 */
export function resetUiContinuationListenersForTest(): void {
  retryListeners.clear();
  dispatchingListeners.clear();
  undispatchedListeners.clear();
  interventionListeners.clear();
}
