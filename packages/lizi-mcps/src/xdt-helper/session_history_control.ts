import { z } from 'zod';
import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { ControlResult, LiziMcpSessionContext } from '../types.js';
import { errorPayload, okPayload } from './_payload.js';
import type { ForkTarget, ForkOutcome } from '@cindy/maker-shared/fork-request';

export type SessionHistoryCallback = (params: {
  kind: 'fork' | 'rewind'; sessionId: string; messageClientId: string; callerSessionId?: string;
  stopIfRunning?: boolean; allowFileRestore?: boolean;
  requestId?: string; checkResult?: boolean; target?: ForkTarget;
}) => Promise<ControlResult<{ sessionId: string; forkOutcome?: ForkOutcome }, string>>;

export function registerSessionHistoryTools(registry: XdtHelperToolRegistry, deps: {
  getSessionContext(): LiziMcpSessionContext; call: SessionHistoryCallback;
}): void {
  for (const kind of ['fork', 'rewind'] as const) registry.register({
    name: kind === 'fork' ? 'fork_session' : 'rewind_session', category: 'control',
    description: kind === 'fork'
      ? '从指定历史消息分叉为新任务，使用宿主原生历史分叉路径。user 锚点复制它之前的历史；assistant 锚点复制至下一条 user 之前。返回新任务 ID，不自动发送消息。跨电脑使用 deviceId::sessionId。'
      : '回到指定 user 消息之前，复用界面的检查点与原生历史回退、持久化屏障及清理。风险固定为逐次确认。默认不停止运行中的任务；restore_files=false 只回退对话。跨电脑使用 deviceId::sessionId。',
    inputShape: {
      session_id: z.string().min(1).describe('明确的目标任务 ID；不推断当前任务。'),
      message_client_id: z.string().min(1).describe('get_chat_history 返回的消息 clientId；回退只接受 user 消息。'),
      ...(kind === 'rewind' ? {
        stop_if_running: z.boolean().default(false).describe('明确要求先停止运行，再回退。'),
        restore_files: z.boolean().default(true).describe('按宿主已有检查点恢复文件；false 仅回退对话。'),
      } : {
        request_id: z.string().uuid().optional().describe('本次分叉的 UUID。首次生成后保留；超时后用同一值查询或重试，不能换值盲目重发。'),
        check_result: z.boolean().optional().describe('只查询同一次请求的创建结果，不执行分叉。须提供 request_id。'),
        target: z.object({
          agentKind: z.enum(['claude-code', 'codex', 'pi', 'acp']), model: z.string().min(1).max(512),
          providerId: z.string().min(1).max(512).nullable(), agentDeviceId: z.string().max(128).nullable(),
          effort: z.string().max(64).optional(), fastMode: z.union([z.boolean(), z.literal('ultrafast')]).optional(),
        }).strict().optional().describe('用户显式选择的聊天记录交接目标；agentDeviceId=null 为任务电脑。保留任务与文件位置；有界交接不能保留完整原生推理与工具状态。须提供 request_id。'),
      }),
    },
    handler: async (args) => {
      const requestId = 'request_id' in args ? args.request_id : undefined;
      const checkResult = 'check_result' in args ? args.check_result : undefined;
      const target = 'target' in args ? args.target : undefined;
      const ctx = deps.getSessionContext();
      if (!ctx.sessionId && ctx.hostCaller?.kind !== 'plugin') return errorPayload('NO_SESSION_CONTEXT', '当前调用没有绑定任务。');
      const sessionId = args.session_id.startsWith('local::') ? args.session_id.slice(7) : args.session_id;
      if (!sessionId || args.session_id.startsWith('local::') && sessionId.includes('::')) return errorPayload('INVALID_ARGS', '不能嵌套设备前缀。');
      if (kind === 'fork' && (target || checkResult) && !requestId) return errorPayload('INVALID_ARGS', 'History handoff and result lookup require request_id.');
      const result = await deps.call({ kind, sessionId, messageClientId: args.message_client_id, callerSessionId: ctx.sessionId,
        ...(kind === 'rewind' ? { stopIfRunning: 'stop_if_running' in args && args.stop_if_running === true,
          allowFileRestore: !('restore_files' in args) || args.restore_files !== false }
          : { ...(requestId ? { requestId } : {}), ...(checkResult !== undefined ? { checkResult } : {}), ...(target ? { target } : {}) }) });
      return result.ok ? okPayload({ session_id: result.sessionId,
        ...(result.forkOutcome ? { fork_outcome: result.forkOutcome } : {}),
        ...(requestId ? { request_id: requestId } : {}) }) : errorPayload(result.errorCode, result.message);
    },
  });
}
