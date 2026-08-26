/**
 * xdt-helper/update_queued_message.ts —— 修改一条尚未被消费的 lead 排队消息。
 *
 * 只能修改 lead 自己发出的排队条目(send_to_worker / initial_task 排队产生);
 * 整条正文替换,host 会按原派发格式重建消息体,消息在队列中的位置与身份不变。
 */

import { z } from 'zod';

import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { ControlResult } from '../types.js';
import { errorPayload, okPayload } from './_payload.js';

/** update / cancel 共用的失败码(与 host WorkerQueuedMessageFailureCode 同构)。 */
export type QueuedMessageControlErrorCode =
  | 'WORKER_NOT_FOUND'
  | 'QUEUED_MESSAGE_NOT_FOUND'
  | 'NOT_LEAD_MESSAGE'
  | 'MESSAGE_CONSUMING'
  | 'INVALID_ARGS';

export interface UpdateQueuedMessageDeps {
  getSessionContext?: () => {
    sessionId?: string;
  };
  updateWorkerQueuedMessage: (params: {
    callerLeadSessionId: string;
    workerRef: string;
    queuedMessageId: string;
    message: string;
  }) => Promise<
    ControlResult<{ workerId: string; queuedMessageId: string }, QueuedMessageControlErrorCode>
  >;
}

const DESCRIPTION =
  '修改一条尚未被 worker 消费的排队消息(整条正文替换)。' +
  'queued_message_id 来自 send_to_worker / create_worker 的排队回传或 get_worker_queue_status。' +
  '只能修改你自己(lead)发出的排队条目;用户或 scheduler 的排队消息不可修改。' +
  '需要把多条相关消息合成一条时用 merge_queued_messages,不要连续 update/cancel 模拟。' +
  '失败码: LEAD_NOT_SUPPORTED / WORKER_NOT_FOUND / QUEUED_MESSAGE_NOT_FOUND(已被消费或已撤回) / ' +
  'NOT_LEAD_MESSAGE / MESSAGE_CONSUMING(正在投递中)。';

export function registerUpdateQueuedMessageTool(
  registry: XdtHelperToolRegistry,
  deps: UpdateQueuedMessageDeps,
): void {
  registry.register({
    name: 'update_queued_message',
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
        .describe('要修改的排队消息 id(来自排队回传或 get_worker_queue_status)'),
      message: z
        .string()
        .min(1)
        .describe('替换后的完整消息正文(整条替换,不是追加)'),
    },
    handler: async ({ worker_id, queued_message_id, message }) => {
      const ctx = deps.getSessionContext?.();
      if (!ctx?.sessionId) {
        return errorPayload('LEAD_NOT_SUPPORTED', '当前 session 类型不支持作为 Lead, 已拒绝 worker 队列操作。');
      }
      const result = await deps.updateWorkerQueuedMessage({
        callerLeadSessionId: ctx.sessionId,
        workerRef: worker_id,
        queuedMessageId: queued_message_id,
        message,
      });
      if (!result.ok) {
        return errorPayload(result.errorCode, result.message);
      }
      return okPayload({
        worker_id: result.workerId,
        queued_message_id: result.queuedMessageId,
        updated: true,
      });
    },
  });
}
