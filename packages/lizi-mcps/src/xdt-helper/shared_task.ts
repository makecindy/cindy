import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { LiziMcpSessionContext } from '../types.js';
import { errorPayload, okPayload } from './_payload.js';

export type SharedTaskToolResult =
  | { ok: true; sessionId: string; device: 'local'; available: boolean; sharedTaskId: string | null; invitationLink?: string }
  | { ok: false; errorCode: string; message: string };

export type SharedTaskToolCallback = (
  context: LiziMcpSessionContext, action: 'state' | 'invite',
) => Promise<SharedTaskToolResult>;

/** Sharing is bound to the calling task, including a phone controlling its host. */
export function registerSharedTaskTools(
  registry: XdtHelperToolRegistry,
  getContext: () => LiziMcpSessionContext,
  execute: SharedTaskToolCallback,
): void {
  for (const action of ['state', 'invite'] as const) {
    registry.register({
      name: action === 'state' ? 'get_shared_task_state' : 'create_shared_task_invitation',
      category: 'control',
      description: action === 'state'
        ? 'Read native sharing state for this calling task on its Cindy host, including when the user controls it from a phone or another computer. No arguments. Does not open sharing or generate an invitation. available=false means unsupported; available=true and sharedTaskId=null means no active share was found. Use after an uncertain result; sharing state does not prove an invitation was received or a notification was sent.'
        : 'Create a native invitation into this calling task on its Cindy host, including when controlled from a phone or another computer. No arguments. Reuses the active share or opens sharing first. Invitees can read the full history, attachments and tool results and use the same Agent with the task’s existing permissions. The link is transferable, not bound to a recipient. Owner management only, subject to normal task permissions; unavailable in Plan mode. Does not send messages or create a separate task. Pass the returned invitationLink unchanged to the requesting workflow; never fabricate it or write it to logs or repository files. If the result is unknown, read sharing state before deciding whether to retry; do not automatically repeat.',
      inputShape: {},
      handler: async () => {
        try {
          const context = getContext();
          if (!context.sessionId || !context.sessionInstanceId) {
            return errorPayload('NO_SESSION_CONTEXT', '无法确认当前任务，请在原任务中调用。');
          }
          const result = await execute(context, action);
          return result.ok ? okPayload(result) : errorPayload(result.errorCode, result.message);
        } catch {
          return errorPayload(action === 'invite' ? 'SHARED_TASK_RESULT_UNKNOWN' : 'SHARED_TASK_UNAVAILABLE',
            action === 'invite'
              ? '未取得共享回执，操作可能已生效。请先查询共享状态，再决定是否重试。'
              : '无法确认当前任务的共享状态，请检查账号与共享连接后再查询。');
        }
      },
    });
  }
}
