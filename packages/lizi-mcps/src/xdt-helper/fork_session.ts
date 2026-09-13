/**
 * xdt-helper/fork_session.ts —— 在某条历史消息处分叉出新 session(control 类)。
 *
 * 对应 GUI 的消息级「Fork」。host 侧复用 maker-orchestration/fork 的 forkSessionAtMessage:
 * 新会话继承到该消息为止的上文,原会话不变。message_id 用 history/get_chat_history
 * 返回的消息 id(host 内部换算成 fork 所需的 clientId)。
 */

import { BRAND_NAME } from '@cindy/maker-shared/branding';
import { z } from 'zod';

import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { ControlResult } from '../lizi_xdtHelperMcpServer.js';
import type { LiziMcpSessionContext } from '../types.js';
import { errorPayload, okPayload } from './_payload.js';
import { hostErrorPayload, sessionOpItemToPayload, type SessionOpItem } from './_session_ops.js';

export type ForkSessionResult = ControlResult<
  { session: SessionOpItem },
  | 'NOT_FOUND'
  | 'PRECONDITION_FAILED'
  | 'INVALID_ARGS'
  | 'UNSUPPORTED_CAPABILITY'
  | 'HOST_NOT_READY'
  | 'INTERNAL'
>;

export interface ForkSessionDeps {
  getSessionContext(): LiziMcpSessionContext;
  forkSession(params: { sessionId: string; messageId: string }): Promise<ForkSessionResult>;
}

const DESCRIPTION =
  `在 ${BRAND_NAME} 某个历史对话/session 的一条消息处分叉出一个新 session(等价于 GUI 的 Fork):` +
  '新会话继承到该消息为止的全部上文,原会话保持不变,新会话会出现在侧栏。' +
  'message_id 取 history/get_chat_history 返回的消息 id;只能在 user 或 assistant 消息上分叉,' +
  '且必须在至少一条 AI 回复之后。远程会话不支持。' +
  '失败码: NOT_FOUND(会话或消息不存在) / INVALID_ARGS(消息角色不合法) / ' +
  'PRECONDITION_FAILED(原会话尚未运行 / 无前置 AI 回复 / 远程会话) / UNSUPPORTED_CAPABILITY(该 agent 或历史格式不支持 fork) / HOST_NOT_READY / INTERNAL。';

export function registerForkSessionTool(
  registry: XdtHelperToolRegistry,
  deps: ForkSessionDeps,
): void {
  registry.register({
    name: 'fork_session',
    category: 'control',
    description: DESCRIPTION,
    inputShape: {
      session_id: z.string().min(1).describe('要分叉的源 session id。'),
      message_id: z
        .string()
        .min(1)
        .describe('在哪条消息处分叉:history/get_chat_history 返回的消息 id。'),
    },
    handler: async ({ session_id, message_id }) => {
      const ctx = deps.getSessionContext();
      if (!ctx.sessionId) {
        return errorPayload(
          'NO_SESSION_CONTEXT',
          `本次 MCP 调用没有绑定 ${BRAND_NAME} session,无法写库。`,
        );
      }
      const result = await deps.forkSession({ sessionId: session_id, messageId: message_id });
      if (!result.ok) return hostErrorPayload(result, BRAND_NAME);
      return okPayload({
        source_session_id: session_id,
        forked_at_message_id: message_id,
        session: sessionOpItemToPayload(result.session),
      });
    },
  });
}
