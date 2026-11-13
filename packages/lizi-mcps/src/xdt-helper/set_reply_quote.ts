import { z } from 'zod';
import type { LiziMcpSessionContext } from '../types.js';
import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import { errorPayload, okPayload } from './_payload.js';

export type SetReplyQuote = (context: LiziMcpSessionContext, messageId: string | null) => Promise<
  { ok: true } | { ok: false; errorCode: string; message: string }
>;

export function registerSetReplyQuoteTool(registry: XdtHelperToolRegistry, deps: {
  getSessionContext: () => LiziMcpSessionContext;
  setReplyQuote: SetReplyQuote;
}): void {
  registry.register({
    name: 'set_reply_quote',
    category: 'control',
    description: '为当前伙伴聊天本轮后续回复选择引用原消息。对话隔了较多消息、回到较早话题或指代容易混淆时可用；紧接着的回答通常无需引用。先用 get_chat_history 找当前任务中原消息的 id，再在输出回复前调用。引用摘要由宿主读取，不要自行编造。只影响本轮后续回复，不发送消息、不改变显示偏好；传 null 取消。桌面与手机均显示主动选择的引用。',
    inputShape: { message_id: z.string().min(1).max(256).nullable().describe('当前任务内原消息的 id 或 clientId；null 取消。') },
    handler: async ({ message_id }) => {
      const context = deps.getSessionContext();
      if (!context.sessionId) return errorPayload('NO_SESSION_CONTEXT', '当前调用未绑定任务。');
      const result = await deps.setReplyQuote(context, message_id);
      return result.ok ? okPayload({ selected: message_id !== null }) : errorPayload(result.errorCode, result.message);
    },
  });
}
