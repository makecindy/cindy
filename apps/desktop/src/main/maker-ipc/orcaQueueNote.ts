import { buildOrcaQueueNote } from '@cindy/maker-shared/orca-queue';

import type { AgentInputQueuedMessage } from '../../shared/agentInputQueue.js';

type OrcaCollaborationMessage = AgentInputQueuedMessage & {
  origin: Extract<NonNullable<AgentInputQueuedMessage['origin']>, { kind: 'orca' }>;
};

/**
 * 队列项是不是一条协同成员真正发出的消息。
 *
 * 失败轮的 Retry／自动续跑会复制原条目（连同 `origin`）生成宿主自己的恢复输入：隐藏的
 * 续跑指令，或零产出时的克隆重发。它们沿用了协同来源，却不是发送方的消息——不能当成
 * 「Worker 的回报」让 Worker 改写或撤回（那会毁掉接收方的恢复），也不该出现在 Queue note 里。
 */
export function isOrcaCollaborationMessage(
  item: AgentInputQueuedMessage,
): item is OrcaCollaborationMessage {
  return (
    item.origin?.kind === 'orca' &&
    item.originalSyntheticTrigger === undefined &&
    item.autoResume !== true &&
    item.recoveryCheckpoint === undefined &&
    item.retrySourceClientId === undefined &&
    item.supersedesUserClientId === undefined
  );
}

/**
 * 一条排队的协同消息轮到送达时，告诉接收方后面还排着哪些协同消息（Queue note）。
 *
 * 同一个发送方连续发来的消息常常互相修正或替代；接收方不知道后面还有，就会按第一条
 * 的旧结论先动手。这里只在送达的这条本身是协同消息、且后面确有协同消息时生成说明，
 * 用户手打与定时任务的排队项既不触发、也不出现在说明里——它们的派发内容保持逐字不变。
 *
 * 契约见 docs/dev-rules/orca-team-architecture.md「消息派发与 auto-bridge」第 11 条。
 */
export function buildOrcaQueueDispatchNote(
  item: AgentInputQueuedMessage,
  pendingQueue: readonly AgentInputQueuedMessage[],
): string | null {
  if (!isOrcaCollaborationMessage(item)) return null;
  const headSenderSessionId = item.origin.senderSessionId;
  return buildOrcaQueueNote(
    pendingQueue.flatMap((queued) =>
      isOrcaCollaborationMessage(queued)
        ? [
            {
              queuedMessageId: queued.clientId,
              // 老快照没有 senderSessionId：无法确认时按不同发送方处理，不猜。
              sameSender:
                headSenderSessionId !== undefined &&
                queued.origin.senderSessionId === headSenderSessionId,
              senderLabel: queued.origin.senderLabel,
              content: queued.origin.displayText ?? queued.text,
            },
          ]
        : [],
    ),
  );
}
