/**
 * xdt-helper/cancel_queued_message.ts —— 撤回一条尚未被消费的 lead 排队消息。
 *
 * 只能撤回 lead 自己发出的排队条目;撤回后消息不会送达 worker,host 侧会同步
 * 结清该消息暂存的 accepted 副作用回调(与 Stop 清队列同一条 settle 路径)。
 */

import { z } from 'zod';

import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { ControlResult } from '../types.js';
import type { QueuedMessageControlErrorCode } from './update_queued_message.js';
import { errorPayload, okPayload } from './_payload.js';

export interface CancelQueuedMessageDeps {
  getSessionContext?: () => {
    sessionId?: string;
  };
  cancelWorkerQueuedMessage: (params: {
    callerLeadSessionId: string;
    workerRef: string;
    queuedMessageId: string;
  }) => Promise<
    ControlResult<{ workerId: string; queuedMessageId: string }, QueuedMessageControlErrorCode>
  >;
}

const DESCRIPTION =
  '撤回一条尚未被 worker 消费的排队消息(撤回后不会送达 worker)。' +
  'queued_message_id 来自 send_to_worker / create_worker 的排队回传或 get_worker_queue_status。' +
  '只能撤回你自己(lead)发出的排队条目;用户或 scheduler 的排队消息不可撤回。' +
  '需要把多条相关消息合成一条时用 merge_queued_messages,不要连续 update/cancel 模拟。' +
  '失败码: LEAD_NOT_SUPPORTED / WORKER_NOT_FOUND / QUEUED_MESSAGE_NOT_FOUND(已被消费或已撤回) / ' +
  'NOT_LEAD_MESSAGE / MESSAGE_CONSUMING(正在投递中)。';

export function registerCancelQueuedMessageTool(
  registry: XdtHelperToolRegistry,
  deps: CancelQueuedMessageDeps,
): void {
  registry.register({
    name: 'cancel_queued_message',
    category: 'control',
    description: DESCRIPTION,
    inputShape: {
      worker_id: z
        .string()
        .min(1)
        .describe('目标 worker 的 worker_id 或 session_id 任一'),
      queued_message_id: z
        .string()
        .min(1)
        .describe('要撤回的排队消息 id(来自排队回传或 get_worker_queue_status)'),
    },
    handler: async ({ worker_id, queued_message_id }) => {
      const ctx = deps.getSessionContext?.();
      if (!ctx?.sessionId) {
        return errorPayload('LEAD_NOT_SUPPORTED', '当前 session 类型不支持作为 Lead, 已拒绝 worker 队列操作。');
      }
      const result = await deps.cancelWorkerQueuedMessage({
        callerLeadSessionId: ctx.sessionId,
        workerRef: worker_id,
        queuedMessageId: queued_message_id,
      });
      if (!result.ok) {
        return errorPayload(result.errorCode, result.message);
      }
      return okPayload({
        worker_id: result.workerId,
        queued_message_id: result.queuedMessageId,
        cancelled: true,
      });
    },
  });
}
