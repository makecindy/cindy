import type {AgentInputQueuedMessage} from '@cindy/maker-shared/agent-input-queue';
export function sessionQueueOriginForDispatcher(params: {
  dispatcherSessionId?: string;
  /** 来源会话当前标题快照；缺失时接收方 renderer 回退实时查询或通用文案。 */
  dispatcherSessionTitle?: string | null;
  /** 来源会话所属伙伴；有则接收方标签显示「由伙伴「X」发送」。 */
  dispatcherBot?: { id: string; name: string } | null;
  message: string;
  explicitOrigin?: AgentInputQueuedMessage['origin'];
}): AgentInputQueuedMessage['origin'] | undefined {
  if (params.explicitOrigin) return params.explicitOrigin;
  if (!params.dispatcherSessionId) return undefined;
  const senderSessionTitle = params.dispatcherSessionTitle?.trim();
  return {
    kind: 'session',
    senderSessionId: params.dispatcherSessionId,
    displayText: params.message,
    ...(senderSessionTitle ? { senderSessionTitle } : {}),
    ...(params.dispatcherBot
      ? { senderBotId: params.dispatcherBot.id, senderBotName: params.dispatcherBot.name }
      : {}),
  };
}
