import type { LiziMcpSessionContext } from '@cindy/mcps';
import type { FeishuToolScope, FeishuToolTransport } from '../im/shared/channelToolScope';

/** Host pins both connection and target; the model never supplies a chat or operator identity. */
export function createManagedFeishuCardHost(deps: {
  resolve: (
    context: LiziMcpSessionContext,
  ) => Promise<{ im: FeishuToolTransport; assertCurrent: () => void }>;
  readScope: (context: LiziMcpSessionContext) => FeishuToolScope | null;
}) {
  async function target(context: LiziMcpSessionContext) {
    if (!context.sessionId || !context.sessionInstanceId) throw new Error('NO_SESSION_CONTEXT');
    const scope = deps.readScope(context);
    const resolved = await deps.resolve(context);
    resolved.assertCurrent();
    // Do not redirect a scope that expired while transport lookup was pending.
    if (deps.readScope(context) !== scope) throw new Error('FEISHU_SCOPE_CHANGED');
    const lane = scope?.laneUserId ?? resolved.im.getOwnerOpenId();
    if (!lane) throw new Error('NO_CHAT_CONTEXT');
    return {
      ...resolved,
      lane,
      assertCurrent: () => {
        resolved.assertCurrent();
        if (deps.readScope(context) !== scope) throw new Error('FEISHU_SCOPE_CHANGED');
      },
    };
  }
  return {
    send: async (
      card: Record<string, unknown>,
      requestId: string,
      context: LiziMcpSessionContext,
    ) => {
      const { im, assertCurrent, lane } = await target(context);
      if (!im.sendManagedCard) throw new Error('MANAGED_CARDS_UNAVAILABLE');
      assertCurrent();
      return im.sendManagedCard(lane, card, requestId);
    },
    update: async (
      messageId: string,
      card: Record<string, unknown>,
      context: LiziMcpSessionContext,
    ) => {
      const { im, assertCurrent, lane } = await target(context);
      if (!im.updateManagedCard) throw new Error('MANAGED_CARDS_UNAVAILABLE');
      assertCurrent();
      await im.updateManagedCard(lane, messageId, card);
      return { ok: true, messageId };
    },
  };
}
