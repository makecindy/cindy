import { z } from 'zod';

import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { LiziMcpSessionContext } from '../types.js';
import { errorPayload, okPayload } from './_payload.js';

export interface BotMessagingCallbacks {
  messageAgent(params: {
    callerSessionId: string;
    targetBotId: string;
    message: string;
  }): Promise<
    | {
        ok: true;
        targetBotId: string;
        targetBotName: string;
        targetSessionId: string;
        wakeKind: 'resumed' | 'already-active' | 'created' | 'queued';
      }
    | {
        ok: false;
        errorCode: string;
        message: string;
        availableBots?: Array<{ id: string; name: string }>;
      }
  >;
}

export interface BotMessagingToolDeps {
  getSessionContext: () => LiziMcpSessionContext;
  callbacks: BotMessagingCallbacks;
}

export function registerBotMessagingTools(
  registry: XdtHelperToolRegistry,
  deps: BotMessagingToolDeps,
): void {
  registry.register({
    name: 'message_agent',
    category: 'bots',
    description: [
      '给另一个 Cindy Bot 的主任务发送一条直接消息，并在需要时唤醒它。',
      '适合通知、提问、协调或轻量接力；调用只确认消息是否被目标任务收下，不等待回复。',
      '有明确交付物、预算、取消和结果回传要求的工作请使用 delegate_to_bot；两者互不替代。',
    ].join('\n'),
    inputShape: {
      target_bot_id: z.string().min(1).max(128),
      message: z.string().min(1).max(16_000),
    },
    handler: async ({ target_bot_id, message }) => {
      const callerSessionId = deps.getSessionContext().sessionId;
      if (!callerSessionId) {
        return errorPayload('NOT_A_BOT_SESSION', '当前 MCP 调用未绑定 Cindy 任务，无法验证 Bot 身份。');
      }
      const result = await deps.callbacks.messageAgent({
        callerSessionId,
        targetBotId: target_bot_id,
        message,
      });
      if (!result.ok) {
        return errorPayload(result.errorCode, result.message, {
          ...(Array.isArray(result.availableBots)
            ? { available_bots: result.availableBots }
            : {}),
        });
      }
      return okPayload({
        target_bot_id: result.targetBotId,
        target_bot_name: result.targetBotName,
        target_session_id: result.targetSessionId,
        wake_kind: result.wakeKind,
      });
    },
  });
}
