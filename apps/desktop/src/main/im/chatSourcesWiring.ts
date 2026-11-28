/**
 * 「群聊」总表的群名单来源：设置页那份个人机器人各登记一份（见 shared/chatSources.ts）。
 */

import { isDiscordLaneEnabled } from '@cindy/im';

import { discordChannelAccessStore } from './discord/channelAccessStore';
import { cachedFeishuGroupAvatar, feishuBotGroups } from './feishu/groupList';
import { discordIm, dingtalkIm, feishuIm, telegramIm, wecomIm } from './host';
import { DINGTALK_PERSONAL_GROUP_WINDOW, WECOM_PERSONAL_GROUP_WINDOW } from './shared/channelGroupWindow';
import { registerImChatSource, type ImChatEntry } from './shared/chatSources';
import { listTelegramKnownGroups } from './telegram/groupWindow';

function windowEntries(rows: Array<{ chatId: string; chatName: string | null }>): ImChatEntry[] {
  return rows.map((row) => ({ chatId: row.chatId, name: row.chatName?.trim() || null, avatarUrl: null, kind: 'group' }));
}

export function registerPersonalImChatSources(): void {
  registerImChatSource('feishu', {
    botId: () => feishuIm.getBotAppId() || null,
    connected: () => feishuIm.getStatus().kind === 'connected',
    remote: (refresh) => feishuBotGroups(feishuIm, feishuIm.getBotAppId() ?? '', refresh),
    cachedAvatar: cachedFeishuGroupAvatar,
  });
  registerImChatSource('telegram', {
    botId: () => telegramIm.botContextId || null,
    connected: () => telegramIm.getStatus().kind === 'connected',
    known: async (botId) => windowEntries(await listTelegramKnownGroups(botId)),
    // 「群成员也能提问」= 群准入(你邀请的群自动批准, 别人拉的群在私聊卡里批准)。
    members: {
      get: (chatId) => telegramIm.groupApprovalOf(chatId) === 'approved',
      set: (chatId, on, name) => telegramIm.setGroupApproval(chatId, on, name),
    },
  });
  // Discord: 机器人所在服务器里、白名单开着的文字频道(服务器频道页管「在哪里工作」, 这里管每个频道怎么回)。
  registerImChatSource('discord', {
    botId: () => discordIm.botContextId || null,
    connected: () => discordIm.getStatus().kind === 'connected',
    remote: async () => {
      const access = discordChannelAccessStore.read();
      return discordIm.listGuilds().flatMap((guild) => guild.channels
        .filter((channel) => isDiscordLaneEnabled(access, { guildId: guild.id, channelId: channel.id }))
        .map((channel): ImChatEntry => ({
          chatId: `${guild.id}/${channel.id}`,
          name: `${guild.name} #${channel.name}`,
          avatarUrl: null,
          kind: 'channel',
        })));
    },
  });
  registerImChatSource('dingtalk', {
    botId: () => dingtalkIm.getPublicState().appKey || null,
    connected: () => dingtalkIm.getStatus().kind === 'connected',
    known: async (botId) => windowEntries(await DINGTALK_PERSONAL_GROUP_WINDOW.listKnownGroups(botId)),
  });
  registerImChatSource('wecom', {
    botId: () => wecomIm.getConfigState().botId || null,
    connected: () => wecomIm.getStatus().kind === 'connected',
    known: async (botId) => windowEntries(await WECOM_PERSONAL_GROUP_WINDOW.listKnownGroups(botId)),
  });
}
