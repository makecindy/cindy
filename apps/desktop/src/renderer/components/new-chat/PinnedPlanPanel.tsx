/**
 * PinnedPlanPanel —— agent 计划清单的常驻胶囊(composer 上方)。
 *
 * 对齐 Codex IDE 扩展的交互模型:计划不进聊天流(MessageStream 已把 plan 工具
 * 调用整体吞掉),唯一呈现就是这里 —— 输入框上方一枚居中小胶囊(Step N / M),
 * 鼠标悬停时完整清单以浮层向上展开,原地实时更新,不会被后续消息冲走。
 * 数据从会话消息派生(findLatestMessageTodoInsertion):跨 source(TodoWrite /
 * update_plan / Task*)取最近更新的 plan session 快照;历史 session 不再逐张
 * 展示。无计划时返回 null,不占位。
 */

import { useMemo } from 'react';
import { findLatestMessageTodoInsertion } from '@cindy/maker-shared/message-render';

import { TodoListCard } from '@/components/chat/TodoListCard';
import type { ChatMessage } from '@/lib/makerChatStore';

export function PinnedPlanPanel({
  messages,
  animated,
  width,
}: {
  messages: readonly ChatMessage[];
  /** 会话仍在流式时进行中项呼吸/旋转;停止后冻结。 */
  animated: boolean;
  /** 与 composer 同宽(inputWidth),胶囊在该宽度内居中,浮层不超出。 */
  width: number;
}): React.ReactElement | null {
  const insertion = useMemo(() => findLatestMessageTodoInsertion(messages), [messages]);

  if (!insertion || insertion.todos.length === 0) return null;

  return (
    <div className="mb-1.5 max-w-full" style={{ width }}>
      {/* key 按 plan session 锚定:新计划重挂载,浮层/进度从头开始。 */}
      <TodoListCard key={insertion.key} todos={insertion.todos} animated={animated} maxWidth={width} />
    </div>
  );
}
