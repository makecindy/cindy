import { BRAND_NAME } from '@cindy/maker-shared/branding';
import type { SessionActivitySnapshot } from '@cindy/maker-shared/session-activity';
import { z } from 'zod';

import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { ControlResult, LiziMcpSessionContext } from '../types.js';
import { errorPayload, okPayload } from './_payload.js';

export type SessionQueueControlErrorCode =
  | 'NOT_FOUND'
  | 'QUEUED_MESSAGE_NOT_FOUND'
  | 'MESSAGE_CONSUMING'
  | 'NOT_AUTHORIZED'
  | 'INVALID_ARGS';

export type SessionSteerErrorCode =
  | 'NOT_FOUND'
  | 'NO_ACTIVE_TURN'
  | 'UNSUPPORTED_CAPABILITY'
  | 'INPUT_LOCKED'
  | 'DELIVERY_FAILED';

export type SessionStopErrorCode = 'NOT_FOUND' | 'UNSUPPORTED_CAPABILITY';

export type SessionRuntimeSnapshot = SessionActivitySnapshot;

export interface SessionControlDeps {
  getSessionContext: () => LiziMcpSessionContext;
  updateQueuedMessage(params: {
    callerSessionId: string;
    targetSessionId: string;
    queuedMessageId: string;
    message: string;
  }): Promise<ControlResult<{ queuedMessageId: string }, SessionQueueControlErrorCode>>;
  cancelQueuedMessage(params: {
    callerSessionId: string;
    targetSessionId: string;
    queuedMessageId: string;
  }): Promise<ControlResult<{ queuedMessageId: string }, SessionQueueControlErrorCode>>;
  steerSession(params: {
    callerSessionId: string;
    targetSessionId: string;
    message: string;
  }): Promise<ControlResult<{ queuedMessageId: string }, SessionSteerErrorCode>>;
  stopSessionTurn(params: {
    targetSessionId: string;
  }): Promise<
    ControlResult<
      {
        status: 'no-active-turn' | 'waiting-for-safe-point' | 'requested' | 'unconfirmed';
        turnGeneration?: number;
        reason?: string;
      },
      SessionStopErrorCode
    >
  >;
  getSessionRuntime(params: {
    targetSessionId: string;
  }): Promise<ControlResult<{ runtime: SessionRuntimeSnapshot }, 'NOT_FOUND'>>;
}

function requireCallerSession(deps: SessionControlDeps): string | null {
  return deps.getSessionContext().sessionId ?? null;
}

function mapControlFailure(result: { ok: false; errorCode: string; message: string }) {
  if (result.errorCode === 'HOST_NOT_READY') {
    return errorPayload('HOST_NOT_READY', `${BRAND_NAME} 主进程会话服务尚未就绪，请稍后重试。`);
  }
  return errorPayload(result.errorCode, result.message);
}

export function registerUpdateSessionQueuedMessageTool(
  registry: XdtHelperToolRegistry,
  deps: SessionControlDeps,
): void {
  registry.register({
    name: 'update_session_queued_message',
    category: 'control',
    description:
      '修改你通过 send_to_session 投递、且目标 session 尚未消费的一条排队消息。' +
      '只能修改当前调用 session 自己投递的消息；正在投递或其它来源的消息会被拒绝。',
    inputShape: {
      session_id: z.string().min(1).describe('目标 session id。'),
      queued_message_id: z.string().min(1).describe('来自 send_to_session 或 list_session_queue 的消息 id。'),
      message: z.string().min(1).describe('替换后的完整消息正文。'),
    },
    handler: async ({ session_id, queued_message_id, message }) => {
      const callerSessionId = requireCallerSession(deps);
      if (!callerSessionId) {
        return errorPayload('NO_SESSION_CONTEXT', '当前 MCP 调用没有绑定 session，无法校验消息所有权。');
      }
      const result = await deps.updateQueuedMessage({
        callerSessionId,
        targetSessionId: session_id,
        queuedMessageId: queued_message_id,
        message,
      });
      if (!result.ok) return mapControlFailure(result);
      return okPayload({
        session_id,
        queued_message_id: result.queuedMessageId,
        updated: true,
      });
    },
  });
}

export function registerCancelSessionQueuedMessageTool(
  registry: XdtHelperToolRegistry,
  deps: SessionControlDeps,
): void {
  registry.register({
    name: 'cancel_session_queued_message',
    category: 'control',
    description:
      '撤回你通过 send_to_session 投递、且目标 session 尚未消费的一条排队消息。' +
      '只能撤回当前调用 session 自己投递的消息；正在投递或其它来源的消息会被拒绝。',
    inputShape: {
      session_id: z.string().min(1).describe('目标 session id。'),
      queued_message_id: z.string().min(1).describe('来自 send_to_session 或 list_session_queue 的消息 id。'),
    },
    handler: async ({ session_id, queued_message_id }) => {
      const callerSessionId = requireCallerSession(deps);
      if (!callerSessionId) {
        return errorPayload('NO_SESSION_CONTEXT', '当前 MCP 调用没有绑定 session，无法校验消息所有权。');
      }
      const result = await deps.cancelQueuedMessage({
        callerSessionId,
        targetSessionId: session_id,
        queuedMessageId: queued_message_id,
      });
      if (!result.ok) return mapControlFailure(result);
      return okPayload({
        session_id,
        queued_message_id: result.queuedMessageId,
        cancelled: true,
      });
    },
  });
}

export function registerSteerSessionTool(
  registry: XdtHelperToolRegistry,
  deps: SessionControlDeps,
): void {
  registry.register({
    name: 'steer_session',
    category: 'control',
    description:
      '向正在运行的本机 session 高优先级插话；消息复用该 session 的原生 same-turn steer，' +
      '在 provider 的下一个输入安全间隙可见，不等待当前 turn 结束。目标不在运行或不支持时明确失败。',
    inputShape: {
      session_id: z.string().min(1).describe('目标 session id。'),
      message: z.string().min(1).describe('要注入当前 turn 的完整消息正文。'),
    },
    handler: async ({ session_id, message }) => {
      const callerSessionId = requireCallerSession(deps);
      if (!callerSessionId) {
        return errorPayload('NO_SESSION_CONTEXT', '当前 MCP 调用没有绑定 session，无法记录插话来源。');
      }
      const result = await deps.steerSession({
        callerSessionId,
        targetSessionId: session_id,
        message,
      });
      if (!result.ok) return mapControlFailure(result);
      return okPayload({
        session_id,
        queued_message_id: result.queuedMessageId,
        steered: true,
      });
    },
  });
}

export function registerStopSessionTurnTool(
  registry: XdtHelperToolRegistry,
  deps: SessionControlDeps,
): void {
  registry.register({
    name: 'stop_session_turn',
    category: 'control',
    description:
      '请求另一个本机 session 的当前 turn 优雅停止。若正在执行工具，会等全部当前工具结果返回后再发送 provider 软中断；' +
      '不会关闭 transport、重建 session 或硬杀进程。',
    inputShape: {
      session_id: z.string().min(1).describe('目标 session id。'),
    },
    handler: async ({ session_id }) => {
      const result = await deps.stopSessionTurn({ targetSessionId: session_id });
      if (!result.ok) return mapControlFailure(result);
      return okPayload({
        session_id,
        status: result.status,
        ...(result.turnGeneration !== undefined
          ? { turn_generation: result.turnGeneration }
          : {}),
        ...(result.reason ? { reason: result.reason } : {}),
      });
    },
  });
}

export function registerGetSessionRuntimeTool(
  registry: XdtHelperToolRegistry,
  deps: SessionControlDeps,
): void {
  registry.register({
    name: 'get_session_runtime',
    category: 'control',
    description:
      '只读查询本机 session 的统一状态：记录生命周期、运行/等待/正常结束/出错结束、标题工作流语义、' +
      '开始时间、最后活动时间、动作摘要和优雅停止状态；' +
      '不返回提示词正文、工具参数或凭证。',
    inputShape: {
      session_id: z.string().min(1).describe('目标 session id。'),
    },
    handler: async ({ session_id }) => {
      const result = await deps.getSessionRuntime({ targetSessionId: session_id });
      if (!result.ok) return mapControlFailure(result);
      const runtime = result.runtime;
      return okPayload({
        session_id,
        phase: runtime.phase,
        active: runtime.phase === 'running' || runtime.phase === 'needs-interaction',
        record_status: runtime.recordStatus ?? null,
        source: runtime.source,
        attention: runtime.attention,
        workflow: runtime.workflow,
        turn_generation: runtime.turnGeneration,
        started_at: runtime.startedAtMs === null ? null : new Date(runtime.startedAtMs).toISOString(),
        last_activity_at:
          runtime.lastActivityAtMs === null ? null : new Date(runtime.lastActivityAtMs).toISOString(),
        current_action_summary: runtime.currentActionSummary,
        graceful_stop_state: runtime.gracefulStopState,
      });
    },
  });
}
