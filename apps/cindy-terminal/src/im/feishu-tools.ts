import type { FeishuIM } from '@cindy/im';
import type { LiziMcpSessionContext } from '@cindy/mcps';
import { readChannelToolScope } from '@cindy/im-runtime/channelToolScope';
import type { createFeishuNotifications } from '@cindy/im-runtime/channels/feishu/notificationOrigin';
import { createFeishuBotMcpServer } from '../../../../packages/lizi-mcps/src/cindy_feishuBotMcpServer.js';
import type { TerminalTaskHost } from '../tasks/host.js';
import { createFeishuTransportRouting } from '@cindy/app-runtime/feishuTransportRouting';

export function createTerminalFeishuTools(host: {
  getSessionContext(): LiziMcpSessionContext;
  tasks: TerminalTaskHost;
  source?: string;
  personal: FeishuIM;
  getCompanionTransport?(botId:string,ownerOpenId?:string):FeishuIM|null;
  notifications: ReturnType<typeof createFeishuNotifications>;
}) {
  const lane = () => {
    const context = host.getSessionContext(), scope = readChannelToolScope(context);
    return scope?.channel === 'feishu' ? { ...scope, workingDir: context.workingDir } : null;
  };
  const resolve = async (target?: string) => {
    const context = host.getSessionContext(), current = lane();
    if (current) {
      const assertCurrent = () => {
        const next = lane();
        if (!next || next.im !== current.im || next.triggerMessageId !== current.triggerMessageId || next.chatId !== current.chatId ||
          target && target !== current.laneUserId) throw new Error('FEISHU_TURN_CHANGED');
      };
      assertCurrent();
      return { im: current.im, context, target: current.laneUserId, assertCurrent, notification: false };
    }
    const database=await host.tasks.database,conversations=await host.tasks.conversations;
    const routing=createFeishuTransportRouting({
      getCurrentDbClientSnapshot:database.getCurrentDbClientSnapshot,
      activeOwnerScopeKey:()=>{host.getSessionContext();return conversations.broadcastTap.captureDataOwnerBroadcastScope().ownerScopeKey!;},
      isAppSessionBoundaryPending:()=>{try{host.getSessionContext();return false;}catch{return true;}},
    }).createFeishuTransportResolver({
      readTurnScope:()=>lane(),personalIm:host.personal,
      getCompanionTransport:(id,owner)=>host.getCompanionTransport?.(id,owner)??null,
    });
    const resolved=await routing(context,target);resolved.assertCurrent();
    const explicit = typeof context.vendorOptions?.feishuChatId === 'string' ? context.vendorOptions.feishuChatId : null;
    const recipient = explicit ?? resolved.im.getOwnerOpenId();
    const assertCurrent = () => {
      host.getSessionContext();resolved.assertCurrent();
      if (lane() || target && target !== recipient || !explicit && recipient !== resolved.im.getOwnerOpenId()) throw new Error('FEISHU_RECIPIENT_CHANGED');
    };
    assertCurrent();
    return { im: resolved.im, context, target: recipient, assertCurrent, notification: resolved.im===host.personal&&!explicit };
  };
  return createFeishuBotMcpServer({
    getLaneScope: lane,
    getChatId: async () => (await resolve()).target,
    sessionSource: host.source,
    sendFile: async (target, file, name) => {
      try { const resolved = await resolve(target); resolved.assertCurrent(); return await resolved.im.sendFile(target, file, name); }
      catch { return { ok: false, reason: 'SEND_FAIL' }; }
    },
    sendMessage: async (target, text) => {
      try {
        const resolved = await resolve(target); resolved.assertCurrent();
        if (resolved.notification && resolved.context.sessionId) {
          const receipt = await host.notifications.sendFeishuSessionNotification(host.personal, resolved.context.sessionId, text);
          return { ok: true, messageId: receipt.messageId, sessionLinked: receipt.sessionLinked };
        }
        return { ok: true, ...await resolved.im.sendMarkdownText(target, text) };
      } catch { return { ok: false, reason: 'SEND_FAIL' }; }
    },
  });
}
