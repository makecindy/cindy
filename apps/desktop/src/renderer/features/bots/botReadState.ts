/** Synchronous unread consumers read a Main-owned, account-scoped in-memory projection. */
import type { BotGroupSummary } from '../../../shared/botGroupChat';
import { botReadStateProjection, localBotReadIdentity } from './botReadStateSync';
export { startBotReadStateSync, getBotReadStateSyncStatus } from './botReadStateSync';

/** AuthContext has already committed the data-owner generation before this callback. */
export function setBotReadStateOwner(ownerId: string | null): void {
  // The caller's label is not a second owner authority; use the committed auth fence.
  void ownerId;
  botReadStateProjection.ensureOwner();
}
export const getBotLastReadAtMap = () => botReadStateProjection.localMap();
export const getBotLastReadAt = (botId: string): number | null => botReadStateProjection.read(localBotReadIdentity(botId)) ?? null;

/** Returns a projection change, not a claim that persistence has already succeeded. */
export function markBotRead(botId: string, at: number = Date.now()): boolean {
  if (!botId || !Number.isFinite(at) || at <= 0) return false;
  return botReadStateProjection.ack(localBotReadIdentity(botId), Math.floor(at));
}
export function seedMissingBotReadState(botIds: readonly string[], at: number = Date.now()): boolean {
  if (!Number.isFinite(at) || at <= 0) return false;
  let changed = false;
  for (const id of botIds) if (id) changed = botReadStateProjection.seed(localBotReadIdentity(id), Math.floor(at)) || changed;
  return changed;
}
/** A partial, hidden or stale roster is never authoritative evidence of deletion. */
export function pruneBotReadState(botIds: readonly string[]): boolean { void botIds; return false; }
export const subscribeBotReadState = (listener: () => void): (() => void) => botReadStateProjection.subscribe(listener);
export const resetBotReadStateForTests = () => botReadStateProjection.reset();

export const getRemoteBotReadAt = (deviceId: string, botId: string): number | undefined =>
  botReadStateProjection.read({ kind: 'remote-bot', deviceId, botId });
export function seedRemoteBotReadState(deviceId: string, botId: string, at: number): void {
  botReadStateProjection.seed({ kind: 'remote-bot', deviceId, botId }, at);
}
export function acknowledgeRemoteBotRead(deviceId: string, botId: string, at: number): void {
  botReadStateProjection.ack({ kind: 'remote-bot', deviceId, botId }, at);
}

/** Group replies use the same owner-scoped, monotonic local read positions. */
export const botGroupReadKey = (groupId: string) => `group:${groupId}`;
type GroupReadSummary = Pick<BotGroupSummary, 'id' | 'lastReplyAt'> & Partial<Pick<BotGroupSummary, 'lastMessage' | 'serverUnread'>> & {
  /**
   * ISO times of the group's latest (up to 99) messages from others — Bots and other humans,
   * never the reader's own or notices — oldest first. Older hosts omit it.
   */
  incomingMessageTimes?: readonly string[];
};

function latestGroupReplyAt(group: GroupReadSummary): number {
  // Older hosts may omit lastReplyAt; other humans count just like companions.
  const last = group.lastMessage;
  return Math.max(group.lastReplyAt ?? 0,
    last && last.authorKind !== 'system' && (last.authorKind === 'bot' || last.isSelf === false) ? last.createdAt : 0);
}

/**
 * Messages from others after the local read mark: counted from `incomingMessageTimes` (so at
 * most 99); a host without the list only says whether anything is new (1).
 */
export function botGroupUnreadCount(group: GroupReadSummary): number {
  if (group.serverUnread) return group.serverUnread.count;
  const readAt = getBotLastReadAt(botGroupReadKey(group.id));
  if (readAt === null) return 0;
  const latestUnread = latestGroupReplyAt(group) > readAt ? 1 : 0;
  const times = group.incomingMessageTimes;
  if (!Array.isArray(times)) return latestUnread;
  let count = 0;
  for (const time of times) {
    const at = Date.parse(time);
    if (Number.isFinite(at) && at > readAt) count += 1;
  }
  return Math.max(count, latestUnread);
}

export function isBotGroupUnread(group: GroupReadSummary): boolean {
  return botGroupUnreadCount(group) > 0;
}
export function seedBotGroupReadState(groups: readonly GroupReadSummary[]): void {
  for (const group of groups) {
    botReadStateProjection.seed(localBotReadIdentity(botGroupReadKey(group.id)), Math.max(1, latestGroupReplyAt(group)));
  }
}

/** Private-chat topics use the same owner-scoped, monotonic local read positions, per topic Session. */
export const botDmThreadReadKey = (threadSessionId: string) => `thread:${threadSessionId}`;

/** A topic has a companion reply the reader has not seen in its panel. */
export function isBotDmThreadUnread(thread: { sessionId: string; lastAssistantAt: number | null }): boolean {
  if (thread.lastAssistantAt === null) return false;
  const readAt = getBotLastReadAt(botDmThreadReadKey(thread.sessionId));
  return readAt === null || thread.lastAssistantAt > readAt;
}
