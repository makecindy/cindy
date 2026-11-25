/**
 * Explicitly acknowledge a Worker report already read and handled by its Lead.
 */
import { z } from 'zod';
import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import { errorPayload, okPayload } from './_payload.js';

export interface AcknowledgeQueuedMessageDeps {
  getSessionContext?: () => { sessionId?: string };
  acknowledgeWorkerQueuedMessage: (params: {
    callerLeadSessionId: string;
    queuedMessageId: string;
    acknowledgementToken: string;
  }) => Promise<{ ok: true; queuedMessageId: string } | { ok: false; errorCode: string; message: string }>;
}

const DESCRIPTION =
  '确认一条已经从你自己的队列读取并处理过的 Worker 回报。' +
  'get_worker_queue_status 只是只读查看,不会消费消息;仅当你已基于 source=worker 且 consuming=false 的回报完成处理后，才用该条回报的 acknowledgement_token 调用本工具。' +
  '只有完整读过并处理完的纯文本回报可以确认；正文截断或带附件时让它正常投递。确认后不会再次投递，也不会新增一条可见历史消息。不要用 cancel_queued_message 代替确认。' +
  '失败码: LEAD_NOT_SUPPORTED / QUEUED_MESSAGE_NOT_FOUND / MESSAGE_CONSUMING / NOT_ORCA_MESSAGE / QUEUE_CHANGED（重新读取队列）/ INTERNAL（无法确认结果，不要盲目重试）。';

export function registerAcknowledgeQueuedMessageTool(
  registry: XdtHelperToolRegistry,
  deps: AcknowledgeQueuedMessageDeps,
): void {
  registry.register({
    name: 'acknowledge_queued_message',
    category: 'control',
    description: DESCRIPTION,
    inputShape: {
      queued_message_id: z.string().min(1).describe('已读取并处理的 Worker 回报排队消息 id'),
      acknowledgement_token: z.string().min(1).describe('从队列读取结果原样传入的回报版本'),
    },
    handler: async ({ queued_message_id, acknowledgement_token }) => {
      const ctx = deps.getSessionContext?.();
      if (!ctx?.sessionId) return errorPayload('LEAD_NOT_SUPPORTED', '当前 session 类型不支持作为 Lead, 已拒绝队列确认。');
      const result = await deps.acknowledgeWorkerQueuedMessage({
        callerLeadSessionId: ctx.sessionId,
        queuedMessageId: queued_message_id,
        acknowledgementToken: acknowledgement_token,
      });
      if (!result.ok) return errorPayload(result.errorCode, result.message);
      return okPayload({ queued_message_id: result.queuedMessageId, acknowledged: true });
    },
  });
}
