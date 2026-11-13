import { z } from 'zod';
import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { ControlResult, LiziMcpSessionContext } from '../types.js';
import { errorPayload, okPayload } from './_payload.js';

export type SessionHistoryCallback = (params: {
  kind: 'fork' | 'rewind'; sessionId: string; messageClientId: string; callerSessionId?: string;
  stopIfRunning?: boolean; allowFileRestore?: boolean;
}) => Promise<ControlResult<{ sessionId: string }, string>>;

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
      } : {}),
    },
    handler: async (args) => {
      const ctx = deps.getSessionContext();
      if (!ctx.sessionId && ctx.hostCaller?.kind !== 'plugin') return errorPayload('NO_SESSION_CONTEXT', '当前调用没有绑定任务。');
      const sessionId = args.session_id.startsWith('local::') ? args.session_id.slice(7) : args.session_id;
      if (!sessionId || args.session_id.startsWith('local::') && sessionId.includes('::')) return errorPayload('INVALID_ARGS', '不能嵌套设备前缀。');
      const result = await deps.call({ kind, sessionId, messageClientId: args.message_client_id, callerSessionId: ctx.sessionId,
        ...(kind === 'rewind' ? { stopIfRunning: args.stop_if_running === true, allowFileRestore: args.restore_files !== false } : {}) });
      return result.ok ? okPayload({ session_id: result.sessionId }) : errorPayload(result.errorCode, result.message);
    },
  });
}
