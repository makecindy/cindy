import { MAKER_INVOKE } from '@cindy/maker-shared/maker-channels';
import type { BotGroupChatService } from './botGroupChatService.js';
export function registerBotGroupHandlers<Event>(host: {
 ipcMain: {handle(channel: string, handler: (event: Event, ...args: any[]) => unknown): void};
 assertTrustedAppRendererEvent(event: Event): void;
 getService(): BotGroupChatService | null | undefined;
}) {
const {ipcMain,assertTrustedAppRendererEvent,getService} = host;
  // Bot group chat is local to this Desktop in phase 1; device-link does not route these channels.
  const botGroupNotReady = { ok: false as const, errorCode: 'HOST_NOT_READY' as const, message: '伙伴群聊服务尚未就绪' };
  // Narrow chat operations; credentials and transport stay in main.
  ipcMain.handle(MAKER_INVOKE.CHAT_SERVER_STATUS, async (event, input) => {
    assertTrustedAppRendererEvent(event);
    const botGroupChatServiceHolder = getService();
    const chat = botGroupChatServiceHolder?.chatServer;
    return chat ? chat.status() : { enabled: false, connected: false };
  });
  ipcMain.handle(MAKER_INVOKE.CHAT_SERVER_THREAD, async (event, input) => {
    assertTrustedAppRendererEvent(event);
    const botGroupChatServiceHolder = getService();
    const chat = botGroupChatServiceHolder?.chatServer;
    return chat ? chat.thread(input) : { ok: false, errorCode: 'HOST_NOT_READY' };
  });
  ipcMain.handle(MAKER_INVOKE.CHAT_SERVER_REPLY, async (event, input) => {
    assertTrustedAppRendererEvent(event);
    const botGroupChatServiceHolder = getService();
    const chat = botGroupChatServiceHolder?.chatServer;
    return chat ? chat.reply(input) : { ok: false, errorCode: 'HOST_NOT_READY' };
  });
  ipcMain.handle(MAKER_INVOKE.CHAT_SERVER_SHARETOMAIN, async (event, input) => {
    assertTrustedAppRendererEvent(event);
    const botGroupChatServiceHolder = getService();
    const chat = botGroupChatServiceHolder?.chatServer;
    return chat ? chat.shareToMain(input) : { ok: false, errorCode: 'HOST_NOT_READY' };
  });
  ipcMain.handle(MAKER_INVOKE.CHAT_SERVER_REACT, async (event, input) => {
    assertTrustedAppRendererEvent(event);
    const botGroupChatServiceHolder = getService();
    const chat = botGroupChatServiceHolder?.chatServer;
    return chat ? chat.react(input) : { ok: false, errorCode: 'HOST_NOT_READY' };
  });
  ipcMain.handle(MAKER_INVOKE.CHAT_SERVER_FOLLOWTHREAD, async (event, input) => {
    assertTrustedAppRendererEvent(event);
    const botGroupChatServiceHolder = getService();
    const chat = botGroupChatServiceHolder?.chatServer;
    return chat ? chat.followThread(input) : { ok: false, errorCode: 'HOST_NOT_READY' };
  });
  ipcMain.handle(MAKER_INVOKE.CHAT_SERVER_REACTORS, async (event, input) => {
    assertTrustedAppRendererEvent(event);
    const botGroupChatServiceHolder = getService();
    const chat = botGroupChatServiceHolder?.chatServer;
    return chat ? chat.reactors(input) : { ok: false, errorCode: 'HOST_NOT_READY' };
  });
  ipcMain.handle(MAKER_INVOKE.CHAT_SERVER_CREATEINVITE, async (event, input) => {
    assertTrustedAppRendererEvent(event);
    const botGroupChatServiceHolder = getService();
    const chat = botGroupChatServiceHolder?.chatServer;
    return chat ? chat.createInvite(input) : { ok: false, errorCode: 'HOST_NOT_READY' };
  });
  ipcMain.handle(MAKER_INVOKE.CHAT_SERVER_PREVIEWINVITE, async (event, input) => {
    assertTrustedAppRendererEvent(event);
    const botGroupChatServiceHolder = getService();
    const chat = botGroupChatServiceHolder?.chatServer;
    return chat ? chat.previewInvite(input) : { ok: false, errorCode: 'HOST_NOT_READY' };
  });
  ipcMain.handle(MAKER_INVOKE.CHAT_SERVER_REVOKEINVITE, async (event, input) => {
    assertTrustedAppRendererEvent(event);
    const botGroupChatServiceHolder = getService();
    const chat = botGroupChatServiceHolder?.chatServer;
    return chat ? chat.revokeInvite(input) : { ok: false, errorCode: 'HOST_NOT_READY' };
  });
  ipcMain.handle(MAKER_INVOKE.CHAT_SERVER_ACCEPTINVITE, async (event, input) => {
    assertTrustedAppRendererEvent(event);
    const botGroupChatServiceHolder = getService();
    const chat = botGroupChatServiceHolder?.chatServer;
    return chat ? chat.acceptInvite(input) : { ok: false, errorCode: 'HOST_NOT_READY' };
  });
  ipcMain.handle(MAKER_INVOKE.CHAT_SERVER_MANAGE, async (event, input) => {
    assertTrustedAppRendererEvent(event);
    const botGroupChatServiceHolder = getService();
    const chat = botGroupChatServiceHolder?.chatServer;
    return chat ? chat.manage(input) : { ok: false, errorCode: 'HOST_NOT_READY' };
  });
  ipcMain.handle(MAKER_INVOKE.CHAT_SERVER_OWNEDBOTS, async (event, input) => {
    assertTrustedAppRendererEvent(event);
    const botGroupChatServiceHolder = getService();
    const chat = botGroupChatServiceHolder?.chatServer;
    return chat ? chat.ownedBots() : { ok: false, errorCode: 'HOST_NOT_READY' };
  });
  ipcMain.handle(MAKER_INVOKE.CHAT_SERVER_REFRESHPROFILE, async (event, input) => {
    assertTrustedAppRendererEvent(event);
    const botGroupChatServiceHolder = getService();
    const chat = botGroupChatServiceHolder?.chatServer;
    return chat ? chat.refreshProfile() : { ok: false, errorCode: 'HOST_NOT_READY' };
  });
  ipcMain.handle(MAKER_INVOKE.BOT_GROUP_LIST, async (event) => {
    assertTrustedAppRendererEvent(event);
    const botGroupChatServiceHolder = getService();
    return botGroupChatServiceHolder ? botGroupChatServiceHolder.listGroups() : botGroupNotReady;
  });
  ipcMain.handle(MAKER_INVOKE.BOT_GROUP_GET, async (event, groupId: unknown, options: unknown) => {
    assertTrustedAppRendererEvent(event);
    const botGroupChatServiceHolder = getService();
    return botGroupChatServiceHolder ? botGroupChatServiceHolder.getGroup(groupId, options) : botGroupNotReady;
  });
  ipcMain.handle(MAKER_INVOKE.BOT_GROUP_CREATE, async (event, input: unknown) => {
    assertTrustedAppRendererEvent(event);
    const botGroupChatServiceHolder = getService();
    return botGroupChatServiceHolder ? botGroupChatServiceHolder.createGroup(input) : botGroupNotReady;
  });
  ipcMain.handle(MAKER_INVOKE.BOT_GROUP_UPDATE, async (event, input: unknown) => {
    assertTrustedAppRendererEvent(event);
    const botGroupChatServiceHolder = getService();
    return botGroupChatServiceHolder ? botGroupChatServiceHolder.updateGroup(input) : botGroupNotReady;
  });
  ipcMain.handle(MAKER_INVOKE.BOT_GROUP_SET_MEMBERS, async (event, input: unknown) => {
    assertTrustedAppRendererEvent(event);
    const botGroupChatServiceHolder = getService();
    return botGroupChatServiceHolder ? botGroupChatServiceHolder.setMembers(input) : botGroupNotReady;
  });
  ipcMain.handle(MAKER_INVOKE.BOT_GROUP_DELETE, async (event, groupId: unknown) => {
    assertTrustedAppRendererEvent(event);
    const botGroupChatServiceHolder = getService();
    return botGroupChatServiceHolder ? botGroupChatServiceHolder.deleteGroup(groupId) : botGroupNotReady;
  });
  ipcMain.handle(MAKER_INVOKE.BOT_GROUP_SEND, async (event, input: unknown) => {
    assertTrustedAppRendererEvent(event);
    const botGroupChatServiceHolder = getService();
    return botGroupChatServiceHolder ? botGroupChatServiceHolder.sendMessage(input) : botGroupNotReady;
  });
  ipcMain.handle(MAKER_INVOKE.BOT_GROUP_CONTINUE, async (event, groupId: unknown) => {
    assertTrustedAppRendererEvent(event);
    const botGroupChatServiceHolder = getService();
    return botGroupChatServiceHolder ? botGroupChatServiceHolder.continueRound(groupId) : botGroupNotReady;
  });
  ipcMain.handle(MAKER_INVOKE.BOT_GROUP_STOP, async (event, groupId: unknown, scope?: unknown) => {
    assertTrustedAppRendererEvent(event);
    const botGroupChatServiceHolder = getService();
    return botGroupChatServiceHolder ? botGroupChatServiceHolder.stopRound(groupId, scope === 'all' ? 'all' : undefined) : botGroupNotReady;
  });
  ipcMain.handle(MAKER_INVOKE.BOT_GROUP_PLAN_START, async (event, input: unknown) => {
    assertTrustedAppRendererEvent(event);
    const botGroupChatServiceHolder = getService();
    return botGroupChatServiceHolder ? botGroupChatServiceHolder.startPlan(input) : botGroupNotReady;
  });
  ipcMain.handle(MAKER_INVOKE.BOT_GROUP_PLAN_DISMISS, async (event, input: unknown) => {
    assertTrustedAppRendererEvent(event);
    const botGroupChatServiceHolder = getService();
    return botGroupChatServiceHolder ? botGroupChatServiceHolder.dismissPlan(input) : botGroupNotReady;
  });
  ipcMain.handle(MAKER_INVOKE.BOT_GROUP_PLAN_CONTINUE, async (event, input: unknown) => {
    assertTrustedAppRendererEvent(event);
    const botGroupChatServiceHolder = getService();
    return botGroupChatServiceHolder ? botGroupChatServiceHolder.continuePlan(input) : botGroupNotReady;
  });
  ipcMain.handle(MAKER_INVOKE.BOT_GROUP_PLAN_RETRY, async (event, input: unknown) => {
    assertTrustedAppRendererEvent(event);
    const botGroupChatServiceHolder = getService();
    return botGroupChatServiceHolder ? botGroupChatServiceHolder.retryPlan(input) : botGroupNotReady;
  });
  ipcMain.handle(MAKER_INVOKE.BOT_GROUP_PLAN_EDIT, async (event, input: unknown) => {
    assertTrustedAppRendererEvent(event);
    const botGroupChatServiceHolder = getService();
    return botGroupChatServiceHolder ? botGroupChatServiceHolder.editPlanStep(input) : botGroupNotReady;
  });
}
