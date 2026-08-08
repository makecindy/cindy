/**
 * PinnedPlanPanel —— agent 计划清单的常驻胶囊(composer 上方)。
 *
 * 对齐 Codex IDE 扩展的交互模型:计划不进聊天流(MessageStream 已把 plan 工具
 * 调用整体吞掉),唯一呈现就是这里 —— 输入框上方一枚居中小胶囊(Step N / M),
 * 鼠标悬停时完整清单以浮层向上展开,原地实时更新,不会被后续消息冲走。
 * 数据从会话消息派生(findLatestMessageTodoInsertion):跨 source(TodoWrite /
 * update_plan / Task*)取最近更新的 plan session 快照;历史 session 不再逐张
 * 展示。无计划时返回 null,不占位。
 *
 * **退场条件是 host 的终态章,不是"步骤全勾完"**(`insertion.sealed`,来源见
 * maker-shared 的 `terminalPlanSnapshot`)。agent 收尾时漏勾最后几步是常态,
 * 以"全勾完"为退场条件会让干完的活儿永远挂在屏幕上;而中断、失败、断线自动
 * 续跑都不盖章,那种情况计划必须留着——任务还活着,用户正要接着指挥。
 *
 * 盖章后同样保留 2 秒再收起,时刻锚在章上(章落库,所以重载/新窗口看到的是
 * 同一个时刻,不会重新数 2 秒)。旧数据没有章,按"全勾完"兜底,行为不变。
 * 兜底只属于旧数据:turn 还在流式时,未盖章的 codex 计划正在等 host 的终态章,
 * 这时候按"全勾完"抢跑退场,会在章晚到(>2s)时先消失再被章复活闪回 2 秒。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { getLatestMessageTodoState } from '@cindy/maker-shared/message-render';

import { TodoListCard } from '@/components/chat/TodoListCard';
import type { ChatMessage } from '@/lib/makerChatStore';
import { cn } from '@/lib/utils';

const COMPLETED_PLAN_VISIBLE_MS = 2_000;

export function PinnedPlanPanel({
  sessionId,
  messages,
  animated,
  width,
  taskHistoryMayBeIncomplete = false,
  visible = true,
  streaming = false,
  className,
}: {
  sessionId: string | null;
  messages: readonly ChatMessage[];
  /**
   * 会话是否真的在跑(调用方传 isStreaming)。胶囊上的进度环始终静态;该值只
   * 透传给浮层里 in_progress 行的呼吸动画——空闲时静止,不谎报步骤仍在执行。
   */
  animated: boolean;
  /** 与 composer 同宽(inputWidth),胶囊在该宽度内居中,浮层不超出。 */
  width: number;
  taskHistoryMayBeIncomplete?: boolean;
  /** 交互卡接管底部区域时只隐藏视图,保留完成后的计时与已收起状态。 */
  visible?: boolean;
  /** turn 还在流式:未盖章的 codex 计划正在等终态章,不走"全勾完"兜底退场。 */
  streaming?: boolean;
  className?: string;
}): React.ReactElement | null {
  const todoState = useMemo(
    () => getLatestMessageTodoState(messages, { taskHistoryMayBeIncomplete }),
    [messages, taskHistoryMayBeIncomplete],
  );
  const insertion = todoState.insertion;
  // `streaming` is session-wide, but a legacy plan can outlive its turn. Only
  // suppress the legacy all-done fallback while the latest normal user turn
  // still owns this plan; steer rows do not start a new turn.
  const latestNormalUserIndex = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role === 'user' && message.delivery !== 'steer') return index;
    }
    return -1;
  }, [messages]);
  const planBelongsToLatestTurn =
    todoState.latestInsertionIndex < 0 || latestNormalUserIndex <= todoState.latestInsertionIndex;
  const allDone = Boolean(
    insertion &&
    insertion.todos.length > 0 &&
    insertion.todos.every((todo) => todo.status === 'completed'),
  );
  // codex 计划有两种"任务还活着"的状态,都不得走全勾完兜底:
  // - turn 流式中且未盖章:正在等 host 的终态章,agent 提前勾完不算数——按
  //   allDone 抢跑会在章晚到时产生"消失再闪回";
  // - host 给该行盖了 turnCompleted:false(中断/失败终态,见 persistCodexPlanOnDone):
  //   按设计不盖章,计划必须留在屏幕上供用户继续指挥,哪怕步骤恰好全勾完。
  // TodoWrite / Task 永远不会有这两种印记,codex 旧历史数据也不会再有,它们照旧
  // 走全勾完兜底——否则旧会话的计划会永远挂着。
  const codexPlanAlive =
    insertion?.source === 'codex' &&
    insertion.sealed !== true &&
    ((streaming && planBelongsToLatestTurn) || insertion.turnFailed === true);
  // 退场 = host 盖了终态章(权威),或计划自己勾完了(没有章的旧数据兜底)。
  const retired =
    Boolean(insertion) && (insertion?.sealed === true || (allDone && !codexPlanAlive));
  const completedAtMs =
    insertion?.sealedAtMs ?? insertion?.updatedAtMs ?? Date.parse(insertion?.createdAt ?? '');
  // 章的时刻来自执行端时钟;device-link 被控场景下本机时钟可能与其偏差任意大。
  // "未来"的时刻不可信(执行端偏快会让胶囊多挂整个偏差时长)——按缺失处理,
  // 落进下方 fallback 通道:按身份一次性记"本地看到章的此刻 + 2 秒",不随渲染
  // 滑动。过去的时刻照用(重载/新窗口不重数 2 秒;执行端偏慢最多提前收起,
  // 无害)。
  const persistedCompletionDeadlineMs =
    retired && Number.isFinite(completedAtMs) && completedAtMs <= Date.now()
      ? completedAtMs + COMPLETED_PLAN_VISIBLE_MS
      : null;
  const [fallbackCompletionVisibility, setFallbackCompletionVisibility] = useState<{
    identity: string;
    deadlineMs: number;
  } | null>(null);
  const completionIdentity = insertion ? `${sessionId ?? 'unknown'}:${insertion.key}` : null;
  const fallbackDeadlineMs =
    retired && fallbackCompletionVisibility?.identity === completionIdentity
      ? fallbackCompletionVisibility.deadlineMs
      : null;
  // 执行端偏慢的另一半:实时 done 先按本地时刻(updatedAtMs/createdAt)起了
  // 2 秒缓冲,随后到达的落库行带"过去"的执行端 sealedAtMs,重算出的期限已
  // 过期——直接替换会把进行中的缓冲瞬间掐断。规则:同一身份的期限单调不减
  // (render 间用 ref 记地板),后算出的更早期限只能取 max,不能倒退。重载/
  // 新窗口是全新组件,地板为空,过期的章照旧立即隐藏(不重数 2 秒)。
  const rawDeadlineMs =
    persistedCompletionDeadlineMs !== null && fallbackDeadlineMs !== null
      ? Math.max(persistedCompletionDeadlineMs, fallbackDeadlineMs)
      : (persistedCompletionDeadlineMs ?? fallbackDeadlineMs);
  // 地板只在 effect 里写(render 阶段写 ref 在 StrictMode 双渲染 / 并发渲染下
  // 会读到被上一次渲染污染的值,review P2);render 阶段只读。
  const deadlineFloorRef = useRef<{ identity: string; deadlineMs: number } | null>(null);
  const floor = deadlineFloorRef.current;
  const completionDeadlineMs =
    rawDeadlineMs !== null && floor && completionIdentity && floor.identity === completionIdentity
      ? Math.max(rawDeadlineMs, floor.deadlineMs)
      : rawDeadlineMs;
  useEffect(() => {
    if (completionDeadlineMs === null || !completionIdentity) return;
    const current = deadlineFloorRef.current;
    if (current?.identity === completionIdentity && current.deadlineMs >= completionDeadlineMs) return;
    deadlineFloorRef.current = { identity: completionIdentity, deadlineMs: completionDeadlineMs };
  }, [completionDeadlineMs, completionIdentity]);
  const snapshotIdentity = insertion
    ? JSON.stringify([
        sessionId ?? 'unknown',
        insertion.key,
        insertion.updatedAtMs ?? insertion.createdAt ?? null,
        insertion.todos.map((todo) => [todo.status, todo.content]),
      ])
    : null;
  const completedPlanExpired = Boolean(
    completionDeadlineMs !== null && completionDeadlineMs <= Date.now(),
  );
  const [hiddenInsertionKey, setHiddenInsertionKey] = useState<string | null>(null);
  const [dismissedSnapshotIdentity, setDismissedSnapshotIdentity] = useState<string | null>(null);

  useEffect(() => {
    if (!insertion || !retired) {
      setHiddenInsertionKey(null);
      setFallbackCompletionVisibility(null);
      return;
    }

    if (completionDeadlineMs === null) {
      setHiddenInsertionKey(null);
      setFallbackCompletionVisibility({
        identity: completionIdentity ?? insertion.key,
        deadlineMs: Date.now() + COMPLETED_PLAN_VISIBLE_MS,
      });
      return;
    }

    const remainingMs = Math.max(0, completionDeadlineMs - Date.now());
    if (remainingMs === 0) {
      setHiddenInsertionKey(insertion.key);
      return;
    }

    setHiddenInsertionKey(null);
    const timer = window.setTimeout(() => {
      setHiddenInsertionKey(insertion.key);
    }, remainingMs);
    return () => window.clearTimeout(timer);
  }, [retired, completionDeadlineMs, completionIdentity, insertion?.key]);

  if (
    !visible ||
    !insertion ||
    insertion.todos.length < 2 ||
    completedPlanExpired ||
    hiddenInsertionKey === insertion.key ||
    dismissedSnapshotIdentity === snapshotIdentity
  )
    return null;

  return (
    <div
      data-pinned-plan="true"
      className={cn('mb-1.5 flex h-8 w-auto max-w-full shrink-0 items-center', className)}
    >
      {/* key 按 plan session 锚定:新计划重挂载,浮层/进度从头开始。 */}
      <TodoListCard
        key={insertion.key}
        todos={insertion.todos}
        animated={animated}
        maxWidth={width}
        onDismiss={() => setDismissedSnapshotIdentity(snapshotIdentity)}
      />
    </div>
  );
}
