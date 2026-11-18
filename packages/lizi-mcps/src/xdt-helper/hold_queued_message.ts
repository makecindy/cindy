/**
 * xdt-helper/hold_queued_message.ts —— 把队列停点挂到一条排队消息上 / 解掉自己的停点。
 *
 * 停点与插话(steer)是同一层能力:都在决定「哪些消息什么时候派发」。挂上停点后,
 * 它之前的消息照常执行,到它为止不再自动发送,等用户决定。至多一个停点,挂新的会
 * 顶掉旧的(含用户手设的)。可操作范围与 steer/update 同口径「只能动自己的」:
 * worker 队列里只能挂在自己发的条目上。
 *
 * 解除只能作用于调用方自己的队列:worker 队列上的停点是用户按下去的手,由用户自己抬。
 */

import { z } from 'zod';

import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { ControlResult } from '../types.js';
import type { QueuedMessageControlErrorCode } from './update_queued_message.js';
import { errorPayload, okPayload } from './_payload.js';

export interface HoldQueuedMessageDeps {
  getSessionContext?: () => {
    sessionId?: string;
  };
  holdWorkerQueuedMessage: (params: {
    callerLeadSessionId: string;
    /** 省略即操作调用方自己的输入队列。 */
    workerRef?: string;
    queuedMessageId: string;
  }) => Promise<
    ControlResult<
      {
        /** 操作调用方自身队列时为 null。 */
        workerId: string | null;
        queuedMessageId: string;
      },
      QueuedMessageControlErrorCode
    >
  >;
  releaseOwnQueueHold: (params: {
    callerLeadSessionId: string;
  }) => Promise<ControlResult<{ released: true }, QueuedMessageControlErrorCode>>;
}

const HOLD_FAILURE_CODES =
  '失败码: LEAD_NOT_SUPPORTED / WORKER_NOT_FOUND / QUEUED_MESSAGE_NOT_FOUND / NOT_LEAD_MESSAGE / ' +
  'NOT_ORCA_MESSAGE / MESSAGE_CONSUMING(已开始投递,挂不上)。';

export function registerHoldQueuedMessageTool(
  registry: XdtHelperToolRegistry,
  deps: HoldQueuedMessageDeps,
): void {
  registry.register({
    name: 'hold_queued_message',
    category: 'control',
    description:
      '把队列停点挂到一条排队中的协同消息上:它之前的消息照常执行,到它为止不再自动发送,等用户决定。' +
      '只能挂在自己发的条目上;省略 worker_id 时挂到你自己队列里的协同消息。' +
      '至多一个停点,挂新的会顶掉旧的(含用户手设的);用户按停止不会清掉停点。' +
      HOLD_FAILURE_CODES,
    inputShape: {
      worker_id: z
        .string()
        .min(1)
        .optional()
        .describe('目标 worker 的 worker_id 或 session_id 任一;省略时操作你自己的输入队列'),
      queued_message_id: z
        .string()
        .min(1)
        .describe('要挂停点的排队消息 id(来自排队回传或 get_worker_queue_status)'),
    },
    handler: async ({ worker_id, queued_message_id }) => {
      const ctx = deps.getSessionContext?.();
      if (!ctx?.sessionId) {
        return errorPayload('LEAD_NOT_SUPPORTED', '当前 session 类型不支持作为 Lead, 已拒绝 worker 队列操作。');
      }
      const result = await deps.holdWorkerQueuedMessage({
        callerLeadSessionId: ctx.sessionId,
        ...(worker_id ? { workerRef: worker_id } : {}),
        queuedMessageId: queued_message_id,
      });
      if (!result.ok) {
        return errorPayload(result.errorCode, result.message);
      }
      return okPayload({
        worker_id: result.workerId,
        queued_message_id: result.queuedMessageId,
      });
    },
  });

  registry.register({
    name: 'release_queue_hold',
    category: 'control',
    description:
      '解掉你自己队列上的停点,队列恢复自动派发。只能解自己的队列——worker 队列上的停点由用户自己抬,你解不了。' +
      '队列没有停点时也返回成功。',
    inputShape: {},
    handler: async () => {
      const ctx = deps.getSessionContext?.();
      if (!ctx?.sessionId) {
        return errorPayload('LEAD_NOT_SUPPORTED', '当前 session 类型不支持作为 Lead, 已拒绝队列操作。');
      }
      const result = await deps.releaseOwnQueueHold({ callerLeadSessionId: ctx.sessionId });
      if (!result.ok) {
        return errorPayload(result.errorCode, result.message);
      }
      return okPayload({ released: true });
    },
  });
}
