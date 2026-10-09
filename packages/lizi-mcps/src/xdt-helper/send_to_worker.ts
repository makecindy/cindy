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

/** 协同消息投递方式:queue = 普通直发/排队(缺省),steer = 尝试插进对方当前 turn。 */
export type OrcaMessageDelivery = 'queue' | 'steer';

/** 请求 steer 但未插成、消息进入队列时的原因。 */
export type SteerFallbackReason = 'STEER_UNSUPPORTED' | 'INPUT_BOUNDARY_BUSY' | 'STEER_UNCERTAIN';

export interface SendToWorkerDeps {
  getSessionContext?: () => {
    sessionId?: string;
  };
  sendToWorker: (params: {
    callerLeadSessionId: string;
    targetSessionId: string;
    message: string;
    /** 仅调用方显式选择时传入;缺省等价 'queue'(普通直发/排队)。 */
    delivery?: OrcaMessageDelivery;
    /** 可选, 随消息发给 worker 的本机图片绝对路径; 仅本机 worker 支持, SSH 远端 worker 会被拒绝。 */
    images?: string[];
  }) => Promise<
    ControlResult<
      {
        agentKind: 'claude-code' | 'codex' | 'pi';
        wakeKind: 'resumed' | 'already-active' | 'queued' | 'steered';
        targetTitle: string | null;
        targetLastUserSendAt: string | null;
        queuedMessageId?: string;
        /** 请求了 steer 但消息进了队列时的原因;空闲直发不带。 */
        steerFallbackReason?: SteerFallbackReason;
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
  '纠错或 worker 正在等的信息可用 delivery=steer 插进其当前 turn(返回 steered=true);新任务保持默认。' +
  '要给 worker 发图片时用 images 传地址(仅本机 worker), 并在 message 里说明每张图是什么;' +
  '用户在对话里贴的图, 把上下文 <cindy-host-image-references> 里的 uri 原样传入即可。' +
  '没插成时照常直发或排队,排队时附 steer_fallback_reason。' +
  '需要替换 worker 当前任务时改用 interrupt_worker。' +
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
      delivery: z
        .enum(['queue', 'steer'])
        .optional()
        .describe('投递方式:queue(默认)= 直发或排队;steer = 尝试插进 worker 当前 turn'),
      images: z
        .array(z.string().min(1))
        .max(8)
        .optional()
        .describe('可选, 随消息发给 worker 的图片(png/jpeg/gif/webp, 最多 8 张); 仅本机 worker 支持, SSH 远端 worker 会被拒绝。地址两类: (a) 用户在对话里贴的图 — 把上下文 <cindy-host-image-references> 里的 uri 原样传入; (b) Lead 自己落盘的本机绝对路径'),
    },
    handler: async ({ target_session_id, message, delivery, images }) => {
      const ctx = deps.getSessionContext?.();
      if (!ctx?.sessionId) {
        return errorPayload('LEAD_NOT_SUPPORTED', '当前 session 类型不支持作为 Lead, 已拒绝 worker 控制操作。');
      }
      const result = await deps.sendToWorker({
        callerLeadSessionId: ctx.sessionId,
        targetSessionId: target_session_id,
        message,
        ...(delivery ? { delivery } : {}),
        ...(images ? { images } : {}),
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
        // 插话是投递给已在线的 session:wake_kind 沿用 already-active(Lead 提示词据此判定已派发),
        // 另用 steered 标记它进了当前 turn。
        wake_kind: result.wakeKind === 'steered' ? 'already-active' : result.wakeKind,
        ...(result.wakeKind === 'steered' ? { steered: true } : {}),
        target_title: result.targetTitle,
        target_last_user_send_at: result.targetLastUserSendAt,
        ...(result.queuedMessageId ? { queued_message_id: result.queuedMessageId } : {}),
        ...(result.steerFallbackReason ? { steer_fallback_reason: result.steerFallbackReason } : {}),
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
