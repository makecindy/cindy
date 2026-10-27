import { z } from 'zod';
import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { LiziMcpSessionContext } from '../types.js';
import { errorPayload, okPayload } from './_payload.js';
import { parseQualifiedSessionId } from './send_to_session.js';

export type SetSessionProjectPin = (params: {
  sessionId: string; pinned: boolean; deviceId?: string;
}) => Promise<
  | { ok: true; projectPinnedAt: string | null }
  | { ok: false; errorCode: string; message: string }
>;

export function registerSetSessionProjectPinTool(registry: XdtHelperToolRegistry, deps: {
  getSessionContext(): LiziMcpSessionContext;
  setSessionProjectPin: SetSessionProjectPin;
}): void {
  registry.register({
    name: 'set_session_project_pin',
    category: 'control',
    description: '在任务所属项目内置顶或取消置顶，独立于全局置顶。仅 active 项目任务可置顶。默认本机；跨电脑传 deviceId::sessionId，沿用同账号远程控制和当前任务权限。旧宿主不支持时明确报错。REMOTE_RESULT_UNKNOWN 表示可能已生效，先查询目标任务再决定是否重试，不自动重发。',
    inputShape: {
      session_id: z.string().trim().min(1).max(256),
      pinned: z.boolean(),
    },
    handler: async ({ session_id, pinned }) => {
      if (!deps.getSessionContext().sessionId) return errorPayload('NO_SESSION_CONTEXT', '当前调用未绑定任务。');
      const target = parseQualifiedSessionId(session_id);
      if ((session_id.includes('::') && !target) || target?.sessionId.includes('::')) {
        return errorPayload('INVALID_ARGS', '任务 ID 必须为 sessionId 或 deviceId::sessionId。');
      }
      const result = await deps.setSessionProjectPin({
        sessionId: target?.sessionId ?? session_id, pinned,
        ...(target && target.deviceId !== 'local' ? { deviceId: target.deviceId } : {}),
      });
      return result.ok
        ? okPayload({ session_id, project_pinned_at: result.projectPinnedAt })
        : errorPayload(result.errorCode, result.message);
    },
  });
}
