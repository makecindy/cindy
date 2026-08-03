/**
 * PinnedPlanPanel —— agent 计划清单的常驻胶囊(composer 上方)。
 *
 * 对齐 Codex IDE 扩展的交互模型:计划不进聊天流(MessageStream 已把 plan 工具
 * 调用整体吞掉),唯一呈现就是这里 —— 输入框上方一枚居中小胶囊(Step N / M),
 * 鼠标悬停时完整清单以浮层向上展开,原地实时更新,不会被后续消息冲走。
 * 数据从会话消息派生(findLatestMessageTodoInsertion):跨 source(TodoWrite /
 * update_plan / Task*)取最近更新的 plan session 快照;历史 session 不再逐张
 * 展示。无计划时返回 null,不占位;计划完成后保留 2 秒再收起。
 */

import { useEffect, useMemo, useState } from 'react';
import { findLatestMessageTodoInsertion } from '@cindy/maker-shared/message-render';

import { TodoListCard } from '@/components/chat/TodoListCard';
import type { ChatMessage } from '@/lib/makerChatStore';

const COMPLETED_PLAN_VISIBLE_MS = 2_000;

export function PinnedPlanPanel({
  sessionId,
  messages,
  animated,
  width,
  taskHistoryMayBeIncomplete = false,
  visible = true,
}: {
  sessionId: string | null;
  messages: readonly ChatMessage[];
  /** 会话仍在流式时进行中项呼吸/旋转;停止后冻结。 */
  animated: boolean;
  /** 与 composer 同宽(inputWidth),胶囊在该宽度内居中,浮层不超出。 */
  width: number;
  taskHistoryMayBeIncomplete?: boolean;
  /** 交互卡接管底部区域时只隐藏视图,保留完成后的计时与已收起状态。 */
  visible?: boolean;
}): React.ReactElement | null {
  const insertion = useMemo(
    () => findLatestMessageTodoInsertion(messages, { taskHistoryMayBeIncomplete }),
    [messages, taskHistoryMayBeIncomplete],
  );
  const allDone = Boolean(
    insertion &&
    insertion.todos.length > 0 &&
    insertion.todos.every((todo) => todo.status === 'completed'),
  );
  const completedAtMs = insertion?.updatedAtMs ?? Date.parse(insertion?.createdAt ?? '');
  const persistedCompletionDeadlineMs =
    allDone && Number.isFinite(completedAtMs)
      ? completedAtMs + COMPLETED_PLAN_VISIBLE_MS
      : null;
  const [fallbackCompletionVisibility, setFallbackCompletionVisibility] = useState<{
    identity: string;
    deadlineMs: number;
  } | null>(null);
  const completionIdentity = insertion ? `${sessionId ?? 'unknown'}:${insertion.key}` : null;
  const completionDeadlineMs =
    persistedCompletionDeadlineMs ??
    (allDone && fallbackCompletionVisibility?.identity === completionIdentity
      ? fallbackCompletionVisibility.deadlineMs
      : null);
  const completedPlanExpired = Boolean(
    completionDeadlineMs !== null && completionDeadlineMs <= Date.now(),
  );
  const [hiddenInsertionKey, setHiddenInsertionKey] = useState<string | null>(null);

  useEffect(() => {
    if (!insertion || !allDone) {
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
  }, [allDone, completionDeadlineMs, completionIdentity, insertion?.key]);

  if (
    !visible ||
    !insertion ||
    insertion.todos.length < 2 ||
    completedPlanExpired ||
    hiddenInsertionKey === insertion.key
  )
    return null;

  return (
    <div className="mb-1.5 max-w-full" style={{ width }}>
      {/* key 按 plan session 锚定:新计划重挂载,浮层/进度从头开始。 */}
      <TodoListCard
        key={insertion.key}
        todos={insertion.todos}
        animated={animated}
        maxWidth={width}
      />
    </div>
  );
}
