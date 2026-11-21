import { z } from 'zod';
import { FeishuBotToolRegistry } from './cindy_feishuBotToolRegistry';
import type { LiziMcpSessionContext } from './types.js';

export interface ManagedFeishuCardTools {
  send(card: Record<string, unknown>, requestId: string): Promise<unknown>;
  update(messageId: string, card: Record<string, unknown>): Promise<unknown>;
}
export interface ManagedFeishuCardHost {
  send(
    card: Record<string, unknown>,
    requestId: string,
    context: LiziMcpSessionContext,
  ): Promise<unknown>;
  update(
    messageId: string,
    card: Record<string, unknown>,
    context: LiziMcpSessionContext,
  ): Promise<unknown>;
}

/** Dedicated tools do not loosen the raw call_api turn-scope gate. */
export function registerManagedFeishuCardTools(
  registry: FeishuBotToolRegistry,
  tools: ManagedFeishuCardTools,
  channelNote = '',
): void {
  const result = (value: unknown) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
  });
  registry.register({
    name: 'send_card',
    category: 'bot',
    description:
      '发送飞书原生 Schema 2.0 业务卡片并登记异步点击。目标固定为当前群/话题，非飞书轮次只通知本连接主人。requestId 用于去重；点击作为新渠道消息回流同一 lane，支持 checked、form_value、option 和原始 value。有效期 30 天。registered=false 表示已发出但未接通回调，不要重发。此工具不处理凭据或主人授权。' +
      channelNote,
    inputShape: {
      card: z
        .record(z.string(), z.unknown())
        .describe(
          '飞书 Schema 2.0 卡片 JSON，含 body.elements；不填写密码或令牌',
        ),
      requestId: z
        .string()
        .regex(/^[A-Za-z0-9_-]{1,128}$/)
        .describe('同一业务请求重试时保持不变'),
    },
    handler: async ({ card, requestId }) =>
      result(await tools.send(card, requestId)),
  });
  registry.register({
    name: 'update_card',
    category: 'bot',
    description:
      '更新当前 lane 已登记的业务卡片，保留原消息。不可更新系统授权卡、其他群或其他连接的卡片。' +
      channelNote,
    inputShape: {
      messageId: z.string().min(1),
      card: z.record(z.string(), z.unknown()),
    },
    handler: async ({ messageId, card }) =>
      result(await tools.update(messageId, card)),
  });
}
