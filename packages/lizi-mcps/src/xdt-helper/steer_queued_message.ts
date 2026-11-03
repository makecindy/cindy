/**
 * xdt-helper/steer_queued_message.ts —— 把一条排队中的协同消息转为插话。
 *
 * 排队消息默认按顺序在目标下一次空闲时投递;本工具让 Lead 把其中一条提前插进
 * 目标当前 turn(same-turn steer)。可操作范围与 update/cancel 同口径「只能动自己的」:
 * worker 队列里只能操作 Lead 自己发的条目;省略 worker_id 时操作调用方自身队列里
 * 的协同消息(Lead 收到的 Worker 回报,或 Worker 收到的 Lead 消息)。没插成时消息
 * 原样留在队列,结果带 reason。
 */

import { z } from 'zod';

import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { ControlResult } from '../types.js';
import type { QueuedMessageControlErrorCode } from './update_queued_message.js';
import { errorPayload, okPayload } from './_payload.js';

/** 转插话未成功、消息仍留在队列时的原因。 */
export type QueuedMessageSteerReason =
  | 'NO_ACTIVE_TURN'
  | 'STEER_UNSUPPORTED'
  | 'INPUT_BOUNDARY_BUSY'
  | 'STEER_UNCERTAIN';

export interface SteerQueuedMessageDeps {
  getSessionContext?: () => {
    sessionId?: string;
  };
  steerWorkerQueuedMessage: (params: {
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
        delivery: 'steered' | 'queued';
        reason?: QueuedMessageSteerReason;
      },
      QueuedMessageControlErrorCode
    >
  >;
}

const DESCRIPTION =
  '把一条排队中的协同消息插进目标当前 turn。只能操作你发的条目;省略 worker_id 时操作你自己队列里的协同消息。' +
  'delivery=queued 表示没插成、消息仍在队列,reason: NO_ACTIVE_TURN / STEER_UNSUPPORTED / ' +
  'INPUT_BOUNDARY_BUSY / STEER_UNCERTAIN(无法确认是否送达,队列已暂停)。' +
  '失败码: LEAD_NOT_SUPPORTED / WORKER_NOT_FOUND / QUEUED_MESSAGE_NOT_FOUND / NOT_LEAD_MESSAGE / ' +
  'NOT_ORCA_MESSAGE / MESSAGE_CONSUMING。';

export function registerSteerQueuedMessageTool(
  registry: XdtHelperToolRegistry,
  deps: SteerQueuedMessageDeps,
): void {
  registry.register({
    name: 'steer_queued_message',
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
        .describe('要转插话的排队消息 id(来自排队回传或 get_worker_queue_status)'),
    },
    handler: async ({ worker_id, queued_message_id }) => {
      const ctx = deps.getSessionContext?.();
      if (!ctx?.sessionId) {
        return errorPayload('LEAD_NOT_SUPPORTED', '当前 session 类型不支持作为 Lead, 已拒绝 worker 队列操作。');
      }
      const result = await deps.steerWorkerQueuedMessage({
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
        delivery: result.delivery,
        ...(result.reason ? { reason: result.reason } : {}),
      });
    },
  });
}
