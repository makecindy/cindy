/**
 * 群 lane（编排层的 userId）→「群聊」总表里的群 ID。私聊与认不出的路由键返回 null。
 * 话题 / thread 跟随所属的群（Discord 跟随父频道）。
 */

import {
  decodeDingTalkLaneUserId,
  decodeDiscordLaneUserId,
  decodeFeishuLaneUserId,
  decodeTelegramLaneUserId,
  decodeWecomLane,
} from '@cindy/im';

import { isImChatId, type ImChatSettingsChannel } from '../../../shared/imChatSettings.js';

export function imChatIdOfLane(channel: ImChatSettingsChannel, userId: string): string | null {
  const chatId = (() => {
    switch (channel) {
      case 'feishu':
        return decodeFeishuLaneUserId(userId)?.chatId ?? null;
      case 'telegram':
        return decodeTelegramLaneUserId(userId)?.chatId ?? null;
      case 'discord': {
        const lane = decodeDiscordLaneUserId(userId);
        return lane ? `${lane.guildId}/${lane.channelId}` : null;
      }
      case 'dingtalk':
        return decodeDingTalkLaneUserId(userId)?.conversationId ?? null;
      case 'wecom':
        try {
          const lane = decodeWecomLane(userId);
          return lane.kind === 'group' ? lane.targetId : null;
        } catch {
          return null;
        }
    }
  })();
  return chatId && isImChatId(channel, chatId) ? chatId : null;
}
