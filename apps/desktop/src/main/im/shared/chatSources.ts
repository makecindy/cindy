/**
 * 「群聊」总表的群名单来源：每个平台的个人机器人在装配时登记一份（im/index.ts），设置页列群、
 * Telegram / 钉钉第一次整理群成员默认值都从这里取，免得共享代码直接引用各平台的传输层实例。
 *
 * 名单 = 平台接口返回的机器人所在群（飞书、Discord）或本机群消息窗口记得的群（Telegram、钉钉、
 * 企业微信）+ 本机任务记录里机器人用过的群 + 已保存设置的群（由调用方合并）。
 */

import { and, eq, like } from 'drizzle-orm';

import type { ImChatSettingsChannel } from '../../../shared/imChatSettings.js';
import { getDbClient } from '../../localDb/client/current.js';
import { sessions } from '../../localDb/schema.js';
import { imChatIdOfLane } from './chatLanes.js';

export interface ImChatEntry {
  chatId: string;
  name: string | null;
  avatarUrl: string | null;
  kind: 'group' | 'channel';
}

export interface ImChatSource {
  /** 当前个人机器人的标识（与入站消息的 contextId 相同）；没配置返回 null。 */
  botId(): string | null;
  connected(): boolean;
  /** 平台接口返回的机器人所在群；读不到时抛错（带 code / httpStatus 时可判断是否缺权限）。 */
  remote?(refresh: boolean): Promise<ImChatEntry[]>;
  /** 本机记得的群（群消息窗口）。 */
  known?(botId: string): Promise<ImChatEntry[]>;
  /** 保存后从上次名单里找头像（保存不重新拉名单）。 */
  cachedAvatar?(botId: string, chatId: string): string | null;
  /**
   * 「群成员也能提问」由平台自己的准入管（Telegram 的群批准）：设置页读写它，不写「群聊」设置文件。
   * `set` 返回是否已保存。
   */
  members?: {
    get(chatId: string): boolean;
    set(chatId: string, on: boolean, name: string | null): boolean;
  };
}

const sources = new Map<ImChatSettingsChannel, ImChatSource>();

export function registerImChatSource(channel: ImChatSettingsChannel, source: ImChatSource): void {
  sources.set(channel, source);
}

export function imChatSource(channel: ImChatSettingsChannel): ImChatSource | null {
  return sources.get(channel) ?? null;
}

/** 任务标题去掉渠道前缀（如「[飞书·群] 」「钉钉群聊 · 」），当作群名的退路。 */
function nameFromTitle(title: string | null): string | null {
  const name = title?.replace(/^\[[^\]]*\]\s*/, '').replace(/^.{1,8}?群聊\s*·\s*/, '').trim();
  return name || null;
}

/** 机器人在本机用过的群（群主线 / 话题任务的路由键里带群 ID），用主线任务的标题当群名。 */
export async function locallyUsedImChats(channel: ImChatSettingsChannel, botId: string): Promise<ImChatEntry[]> {
  const db = getDbClient().drizzle;
  const rows = channel === 'feishu'
    ? await db.select({ lane: sessions.feishuOpenId, title: sessions.title }).from(sessions)
      .where(and(eq(sessions.source, 'feishu'), eq(sessions.feishuBotAppId, botId), like(sessions.feishuOpenId, 'g/%')))
    : await db.select({ lane: sessions.imUserId, title: sessions.title }).from(sessions)
      .where(and(eq(sessions.source, channel), eq(sessions.imBotContextId, botId),
        like(sessions.imUserId, channel === 'wecom' ? 'group/%' : 'g/%')));
  const byChat = new Map<string, string | null>();
  for (const row of rows) {
    if (!row.lane) continue;
    const chatId = imChatIdOfLane(channel, row.lane);
    if (!chatId) continue;
    // 主线(不带话题)的标题才是群名。
    const isMain = row.lane.split('/').length <= (channel === 'discord' ? 3 : 2);
    if (!byChat.has(chatId) || (isMain && row.title)) byChat.set(chatId, isMain ? nameFromTitle(row.title) : byChat.get(chatId) ?? null);
  }
  return [...byChat].map(([chatId, name]) => ({
    chatId,
    name,
    avatarUrl: null,
    kind: channel === 'discord' ? 'channel' as const : 'group' as const,
  }));
}
