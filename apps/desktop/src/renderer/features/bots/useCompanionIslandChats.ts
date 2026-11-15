import { useEffect } from 'react';
import { getDataOwnerGeneration, isDataOwnerPushCurrent } from '@/contexts/dataOwnerGeneration';
import type { AgentIslandCompanionChatInput } from '../../../shared/agentIsland';
import { AGENT_ISLAND_REMOTE_SESSIONS_MAX } from '../../../shared/agentIsland';
import { canonicalBotSessionId, type BotProfile } from './botStore';
import { markBotRead } from './botReadState';
import { isRemoteBotUnread, type RemoteBot } from './remoteBotRoster';
import { markRemoteBotRead } from './useRemoteBots';
import { createLogger } from '@/lib/logger';

const log = createLogger('companionIslandChats');

export function buildCompanionIslandChats(
  allBots: readonly BotProfile[],
  visibleBots: readonly BotProfile[],
  unread: Readonly<Record<string, number>>,
  remoteBots: readonly RemoteBot[],
): AgentIslandCompanionChatInput[] {
  const visibleIds = new Set(visibleBots.map(bot => bot.id));
  const chats = new Map<string, AgentIslandCompanionChatInput>();
  for (const bot of allBots) {
    const sessionId = canonicalBotSessionId(bot);
    if (!sessionId) continue;
    chats.set(sessionId, {
      sessionId, botId: bot.id, deviceId: null,
      companion: { name: bot.name, avatar: bot.avatar, avatarColor: bot.avatarColor },
      visible: visibleIds.has(bot.id) && !bot.hiddenAt && bot.status !== 'archived' && bot.status !== 'deleting',
      unread: (unread[bot.id] ?? 0) > 0,
      lastMessageAt: bot.lastMessageAt ?? bot.createdAt,
      preview: bot.lastMessageRole === 'assistant' ? bot.lastMessagePreview ?? '' : '',
    });
  }
  // Cached unread remains useful while its home is offline. The roster already handles revocation.
  for (const bot of remoteBots) {
    if (!bot.sessionId) continue;
    chats.set(bot.sessionId, {
      sessionId: bot.sessionId, botId: bot.id, deviceId: bot.deviceId,
      companion: { name: bot.name, avatar: bot.avatar, avatarColor: bot.avatarColor },
      visible: true, unread: isRemoteBotUnread(bot),
      lastMessageAt: bot.lastReplyAt ?? bot.activityAt, preview: bot.preview,
    });
  }
  return [...chats.values()].slice(0, AGENT_ISLAND_REMOTE_SESSIONS_MAX);
}

/** Shares the sidebar's existing read positions; no second unread ledger or startup replay. */
export function useCompanionIslandChats(
  allBots: readonly BotProfile[],
  visibleBots: readonly BotProfile[],
  unread: Readonly<Record<string, number>>,
  remoteBots: readonly RemoteBot[],
): void {
  const owner = getDataOwnerGeneration();
  const signature = JSON.stringify(buildCompanionIslandChats(allBots, visibleBots, unread, remoteBots));
  // Re-send on reconnect so an unavailable avatar can use the existing thumbnail lookup again.
  const availability = remoteBots.map(bot => `${bot.deviceId}:${bot.id}:${bot.online}`).join('|');
  useEffect(() => {
    const set = window.electronAPI?.agentIsland?.setCompanionChats;
    if (!set) return;
    void set({ dataOwnerId: owner.dataOwnerId, ownerGeneration: owner.generation,
      chats: JSON.parse(signature) }).catch(error => {
      log.warn('failed to sync companion chats', error);
    });
  }, [signature, availability, owner]);
  useEffect(() => window.electronAPI?.agentIsland?.onCompanionChatRead?.((chat, stamp) => {
    if (!isDataOwnerPushCurrent(stamp)) return;
    if (chat.deviceId) markRemoteBotRead(chat.deviceId, chat.botId, chat.readThroughAt);
    else markBotRead(chat.botId, chat.readThroughAt);
  }), []);
}
