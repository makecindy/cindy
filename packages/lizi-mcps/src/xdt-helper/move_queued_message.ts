/**
 * xdt-helper/move_queued_message.ts —— 调整一条排队中的协同消息在队列中的位置。
 *
 * 可操作范围与 steer_queued_message 相同:worker 队列里只能移动 Lead 自己发的条目;
 * 省略 worker_id 时移动调用方自身队列里的协同消息。position 越界时放到队尾,
 * 返回 host 实际落定的位置。
 */

import { z } from 'zod';

import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { ControlResult } from '../types.js';
import type { QueuedMessageControlErrorCode } from './update_queued_message.js';
import { errorPayload, okPayload } from './_payload.js';

export interface MoveQueuedMessageDeps {
  getSessionContext?: () => {
    sessionId?: string;
  };
  moveWorkerQueuedMessage: (params: {
    callerLeadSessionId: string;
    /** 省略即操作调用方自己的输入队列。 */
    workerRef?: string;
    queuedMessageId: string;
    position: number;
  }) => Promise<
    ControlResult<
      {
        /** 操作调用方自身队列时为 null。 */
        workerId: string | null;
        queuedMessageId: string;
        /** 移动后的实际位置。 */
        position: number;
      },
      QueuedMessageControlErrorCode
    >
  >;
}

const DESCRIPTION =
  '把一条排队中的协同消息移到指定位置(0 = 队首,超出放队尾),返回实际位置。' +
  '只能移动你发的条目;省略 worker_id 时操作你自己队列里的协同消息。' +
  '失败码: LEAD_NOT_SUPPORTED / WORKER_NOT_FOUND / QUEUED_MESSAGE_NOT_FOUND / NOT_LEAD_MESSAGE / ' +
  'NOT_ORCA_MESSAGE / MESSAGE_CONSUMING。';

export function registerMoveQueuedMessageTool(
  registry: XdtHelperToolRegistry,
  deps: MoveQueuedMessageDeps,
): void {
  registry.register({
    name: 'move_queued_message',
    category: 'control',
    description: DESCRIPTION,
    inputShape: {
      worker_id: z
        .string()
        .min(1)
        .optional()
        .describe('目标 worker 的 worker_id 或 session_id 任一;省略时操作你自己的输入队列'),
      queued_message_id: z
        .string()
        .min(1)
        .describe('要移动的排队消息 id(来自排队回传或 get_worker_queue_status)'),
      position: z
        .number()
        .int()
        .min(0)
        .describe('目标位置,0 = 队首;超出队列长度时放到队尾'),
    },
    handler: async ({ worker_id, queued_message_id, position }) => {
      const ctx = deps.getSessionContext?.();
      if (!ctx?.sessionId) {
        return errorPayload('LEAD_NOT_SUPPORTED', '当前 session 类型不支持作为 Lead, 已拒绝 worker 队列操作。');
      }
      const result = await deps.moveWorkerQueuedMessage({
        callerLeadSessionId: ctx.sessionId,
        ...(worker_id ? { workerRef: worker_id } : {}),
        queuedMessageId: queued_message_id,
        position,
      });
      if (!result.ok) {
        return errorPayload(result.errorCode, result.message);
      }
      return okPayload({
        worker_id: result.workerId,
        queued_message_id: result.queuedMessageId,
        position: result.position,
      });
    },
  });
}
