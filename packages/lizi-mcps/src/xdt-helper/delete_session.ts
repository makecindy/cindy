import { z } from 'zod';
import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { ControlResult, LiziMcpSessionContext } from '../types.js';
import { parseQualifiedSessionId } from './send_to_session.js';
import { errorPayload, okPayload } from './_payload.js';

export type DeleteSessionCallback = (params: { sessionId: string; callerSessionId?: string }) =>
  Promise<ControlResult<{ sessionId: string; status: 'deleted' }, string>>;

export function registerDeleteSessionTool(registry: XdtHelperToolRegistry, deps: {
  getSessionContext(): LiziMcpSessionContext; deleteSession: DeleteSessionCallback;
}): void {
  registry.register({
    name: 'delete_session', category: 'control',
    description: '删除明确指定的任务，复用界面的删除与运行清理流程。不能删除当前调用任务；删除后不能用 unarchive_sessions 恢复。' +
      '跨电脑传 deviceId::sessionId，沿用同账号远程控制。风险固定为逐次确认；结果不明时先查询状态，不自动重发。',
    inputShape: { session_id: z.string().min(1).describe('明确的目标任务 ID；跨电脑使用 deviceId::sessionId。') },
    handler: async ({ session_id }) => {
      const ctx = deps.getSessionContext();
      if (!ctx.sessionId && ctx.hostCaller?.kind !== 'plugin') return errorPayload('NO_SESSION_CONTEXT', '当前调用没有绑定任务。');
      const target = parseQualifiedSessionId(session_id);
      const id = target?.deviceId === 'local' ? target.sessionId : session_id;
      if (id.includes('::') && target?.deviceId === 'local') return errorPayload('INVALID_ARGS', '不能嵌套设备前缀。');
      if (ctx.sessionId === id) return errorPayload('INVALID_ARGS', '不能删除当前调用任务。');
      const result = await deps.deleteSession({ sessionId: id, callerSessionId: ctx.sessionId });
      return result.ok ? okPayload({ session_id: result.sessionId, status: result.status })
        : errorPayload(result.errorCode, result.message);
    },
  });
}
