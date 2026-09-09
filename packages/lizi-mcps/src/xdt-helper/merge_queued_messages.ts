import { z } from 'zod';

import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { ControlResult } from '../types.js';
import { errorPayload, okPayload } from './_payload.js';
import type { QueuedMessageControlErrorCode } from './update_queued_message.js';
import type { WorkerQueuedMessageEntry } from './get_worker_queue_status.js';

export interface MergeQueuedMessagesDeps {
  getSessionContext?: () => { sessionId?: string };
  mergeWorkerQueuedMessages: (params: {
    callerLeadSessionId: string;
    workerRef: string;
    queuedMessageIds: string[];
    message: string;
  }) => Promise<
    ControlResult<
      {
        workerId: string;
        queuedMessageId: string;
        messages: WorkerQueuedMessageEntry[];
      },
      QueuedMessageControlErrorCode | 'QUEUE_CHANGED'
    > & { messages?: WorkerQueuedMessageEntry[] }
  >;
}

const DESCRIPTION =
  '原子合并至少两条连续、尚未消费且由当前 Lead 发出的 worker 排队消息。' +
  '最前一条保留原位置与 queued_message_id,其余条目一次移除并结清暂存回调。' +
  '队列已变化、目标不连续、含非 Lead 消息或 consuming 条目时整次零修改,返回 QUEUE_CHANGED 和最新队列。' +
  '不要用多次 update/cancel/send 模拟合并。';

export function registerMergeQueuedMessagesTool(
  registry: XdtHelperToolRegistry,
  deps: MergeQueuedMessagesDeps,
): void {
  registry.register({
    name: 'merge_queued_messages',
    category: 'control',
    description: DESCRIPTION,
    inputShape: {
      worker_id: z
        .string()
        .min(1)
        .describe('目标 worker 的 worker_id 或 session_id 任一'),
      queued_message_ids: z
        .array(z.string().min(1))
        .min(2)
        .describe('按当前队列顺序排列的至少两个连续消息 id,不得重复'),
      message: z.string().min(1).describe('合并后的完整消息正文'),
    },
    handler: async ({ worker_id, queued_message_ids, message }) => {
      const ctx = deps.getSessionContext?.();
      if (!ctx?.sessionId) {
        return errorPayload(
          'LEAD_NOT_SUPPORTED',
          '当前 session 类型不支持作为 Lead, 已拒绝 worker 队列操作。',
        );
      }
      const result = await deps.mergeWorkerQueuedMessages({
        callerLeadSessionId: ctx.sessionId,
        workerRef: worker_id,
        queuedMessageIds: queued_message_ids,
        message,
      });
      if (!result.ok) {
        return errorPayload(result.errorCode, result.message, {
          ...(result.messages ? { queue: projectQueue(result.messages) } : {}),
        });
      }
      return okPayload({
        worker_id: result.workerId,
        queued_message_id: result.queuedMessageId,
        merged_count: queued_message_ids.length,
        queue: projectQueue(result.messages),
      });
    },
  });
}

function projectQueue(messages: WorkerQueuedMessageEntry[]) {
  return messages.map((entry) => ({
    queued_message_id: entry.queuedMessageId,
    position: entry.position,
    source: entry.source,
    content: entry.content,
    consuming: entry.consuming,
  }));
}
