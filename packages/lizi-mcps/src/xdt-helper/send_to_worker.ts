/**
 * xdt-helper/send_to_worker.ts —— 把一条消息投递到指定 worker session。
 *
 * 重命名自 send_to_session, 语义从"通用 session 间 handoff"收窄为"Lead → Worker 派活"。
 */

import { BRAND_NAME } from '@cindy/maker-shared/branding';
import { z } from 'zod';

import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { ControlResult } from '../lizi_xdtHelperMcpServer.js';
import { errorPayload, okPayload } from './_payload.js';

export interface SendToWorkerDeps {
  getSessionContext?: () => {
    sessionId?: string;
  };
  sendToWorker: (params: {
    callerLeadSessionId: string;
    targetSessionId: string;
    message: string;
  }) => Promise<
    ControlResult<
      {
        agentKind: 'claude-code' | 'codex' | 'pi';
        wakeKind: 'resumed' | 'already-active' | 'queued';
        targetTitle: string | null;
        targetLastUserSendAt: string | null;
        queuedMessageId?: string;
      },
      'NOT_FOUND' | 'ARCHIVED' | 'DELETED' | 'BUSY' | 'AGENT_NOT_READY' | 'INVALID_ARGS'
    >
  >;
  interruptWorker: (params: {
    callerLeadSessionId: string;
    targetSessionId: string;
    message: string;
  }) => Promise<
    ControlResult<
      {
        agentKind: 'claude-code' | 'codex' | 'pi';
        queuedMessageId: string;
        stopOutcome:
          | 'requested'
          | 'waiting-for-safe-point'
          | 'no-active-turn'
          | 'unconfirmed'
          | 'unsupported';
        queuePaused: boolean;
      },
      'NOT_FOUND' | 'ARCHIVED' | 'DELETED' | 'BUSY' | 'AGENT_NOT_READY' | 'INVALID_ARGS'
    >
  >;
}

const DESCRIPTION =
  '向指定 worker 投递消息(派活/追问)。' +
  'worker 正忙时消息自动排队(wake_kind=queued)并回传 queued_message_id;' +
  '在它被消费前可用 get_worker_queue_status / update_queued_message / cancel_queued_message 查看、修改或撤回。' +
  '需要替换 worker 当前任务时改用 interrupt_worker;本工具只保留普通直发/排队语义。' +
  '失败码: LEAD_NOT_SUPPORTED / NOT_FOUND / ARCHIVED / DELETED / BUSY / AGENT_NOT_READY。';

export function registerSendToWorkerTool(
  registry: XdtHelperToolRegistry,
  deps: SendToWorkerDeps,
): void {
  registry.register({
    name: 'send_to_worker',
    category: 'control',
    description: DESCRIPTION,
    inputShape: {
      target_session_id: z
        .string()
        .min(1)
        .describe('目标 worker session 的 business id (lead session 是 UUID, worker session 是 cuid, 都按字符串处理)'),
      message: z
        .string()
        .min(1)
        .describe('要投递给 worker 的消息正文'),
    },
    handler: async ({ target_session_id, message }) => {
      const ctx = deps.getSessionContext?.();
      if (!ctx?.sessionId) {
        return errorPayload('LEAD_NOT_SUPPORTED', '当前 session 类型不支持作为 Lead, 已拒绝 worker 控制操作。');
      }
      const result = await deps.sendToWorker({
        callerLeadSessionId: ctx.sessionId,
        targetSessionId: target_session_id,
        message,
      });

      if (!result.ok) {
        if (result.errorCode === 'HOST_NOT_READY') {
          return errorPayload('HOST_NOT_READY', `${BRAND_NAME} 主进程会话服务尚未就绪。`);
        }
        return errorPayload(result.errorCode, result.message);
      }

      return okPayload({
        target_session_id,
        agent_kind: result.agentKind,
        wake_kind: result.wakeKind,
        target_title: result.targetTitle,
        target_last_user_send_at: result.targetLastUserSendAt,
        ...(result.queuedMessageId ? { queued_message_id: result.queuedMessageId } : {}),
      });
    },
  });

  registry.register({
    name: 'interrupt_worker',
    category: 'control',
    description:
      '原子地把新指令预留为 worker 下一条输入,再请求优雅停止当前 turn。' +
      'This ends the unfinished turn. Do not use it for additional context, progress requests, or independent follow-up work; use send_to_worker instead. ' +
      '只在新指令必须替换当前任务时使用;普通追加任务请用 send_to_worker。' +
      '即使 stop_outcome=unsupported/unconfirmed,消息仍保留在优先队首,不会硬 abort。',
    inputShape: {
      target_session_id: z
        .string()
        .min(1)
        .describe('目标 worker session 的 business id'),
      message: z.string().min(1).describe('必须成为下一条输入的新指令正文'),
    },
    handler: async ({ target_session_id, message }) => {
      const ctx = deps.getSessionContext?.();
      if (!ctx?.sessionId) {
        return errorPayload('LEAD_NOT_SUPPORTED', '当前 session 类型不支持作为 Lead, 已拒绝 worker 控制操作。');
      }
      const result = await deps.interruptWorker({
        callerLeadSessionId: ctx.sessionId,
        targetSessionId: target_session_id,
        message,
      });
      if (!result.ok) return errorPayload(result.errorCode, result.message);
      return okPayload({
        target_session_id,
        agent_kind: result.agentKind,
        queued_message_id: result.queuedMessageId,
        stop_outcome: result.stopOutcome,
        queue_paused: result.queuePaused,
      });
    },
  });
}
