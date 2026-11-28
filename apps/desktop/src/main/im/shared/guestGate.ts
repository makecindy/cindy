/**
 * 个人 IM 机器人的「群成员也能提问」（2026-11-24 主人裁决，照微信插件）。
 *
 * 只管设置页那份个人机器人、且由 Cindy 自己回复时的群消息（交给伙伴回复、伙伴连接都按伙伴规则）。
 * 非主人在群里的提问：
 *   - 这个群没勾「群成员也能提问」→ 不回答（静默；飞书传输层另有礼貌提示）。
 *   - 主人不在群里说话时，群成员连续问满 10 次（第 10 次仍回答）→ 先暂停回答他们，群里说一次
 *     「先暂停」；主人在群里 @ 机器人说话或在设置里点「恢复」→ 清零继续。暂停状态存在「群聊」设置里，
 *     重启不丢；计数只在内存里。
 * 群成员的轮次最高按自动审批（各渠道的群轮次策略 + turnRunner 的 personalGuests 兜底），排队上限
 * 与 `/ctr` 隔离也在 turnRunner。命令只认主人（messageHandler 的命令门）。
 *
 * 钉钉升级前就回答群成员：第一次见到这个机器人时把它用过的群记为勾选（seedImChatMembers），之后新加进的群
 * 默认不勾。Telegram 由传输层的群准入决定（设置页的勾选就是批准），这里默认放行它已放进来的成员。
 */

import type { IMMessageEvent } from '@cindy/im';

import {
  IM_CHAT_LEGACY_MEMBER_CHANNELS,
  IM_CHAT_MEMBER_BREAKER_LIMIT,
  type ImChatSettingsChannel,
} from '../../../shared/imChatSettings.js';
import { createLogger } from '../../logger.js';
import { imChatIdOfLane } from './chatLanes.js';
import { imChatSource, locallyUsedImChats, type ImChatEntry } from './chatSources.js';
import {
  imChatMembersAllowed,
  isImChatMembersSeeded,
  readImChatSettings,
  seedImChatMembers,
  writeImChatSettings,
} from './chatSettingsStore.js';

const log = createLogger('im/guest-gate');

/** 连续提问计数：渠道 + 机器人 + 群 → 主人上次说话以来群成员问了几次。 */
const streaks = new Map<string, number>();
const seeding = new Map<string, Promise<void>>();

function streakKey(channel: ImChatSettingsChannel, botId: string, chatId: string): string {
  return `${channel}\n${botId}\n${chatId}`;
}

/** 设置里点「恢复」/ 改动勾选：清零计数（暂停状态由调用方写入设置）。 */
export function resetImChatMemberStreak(channel: ImChatSettingsChannel, botId: string, chatId: string): void {
  streaks.delete(streakKey(channel, botId, chatId));
}

/**
 * 钉钉：把机器人升级前用过的群记为「群成员也能提问」，每个机器人一次（进程内去重）。
 * 失败只记日志，下次再试；没整理完之前钉钉的群照旧回答群成员（保持现状）。
 */
export function ensureImChatMembersSeeded(channel: ImChatSettingsChannel, botId: string): Promise<void> {
  if (!IM_CHAT_LEGACY_MEMBER_CHANNELS.includes(channel) || !botId) return Promise.resolve();
  const key = `${channel}\n${botId}`;
  const inflight = seeding.get(key);
  if (inflight) return inflight;
  if (isImChatMembersSeeded(channel, botId)) return Promise.resolve();
  const run = (async () => {
    const chats = new Map<string, ImChatEntry>();
    const add = (list: ImChatEntry[]) => { for (const chat of list) if (!chats.has(chat.chatId)) chats.set(chat.chatId, chat); };
    add(await locallyUsedImChats(channel, botId));
    const known = imChatSource(channel)?.known;
    if (known) add(await known(botId));
    seedImChatMembers(channel, botId, [...chats.values()].map(({ chatId, name }) => ({ chatId, name })));
    log.info(`${channel} legacy member access recorded for ${chats.size} group(s)`);
  })().catch((err: unknown) => {
    log.warn(`${channel} legacy member access not recorded: ${err instanceof Error ? err.message : String(err)}`);
  }).finally(() => {
    seeding.delete(key);
  });
  seeding.set(key, run);
  return run;
}

export interface PersonalGuestGate {
  /**
   * 群里非主人的消息能否进入 Cindy。false = 丢弃（不起任务）。`notify` 用来在暂停那一刻向群里
   * 说一句。
   */
  admit(event: IMMessageEvent, notify: (text: string) => Promise<void>): Promise<boolean>;
  /** 主人在群里说话：清零连续计数，解除暂停。 */
  ownerSpoke(event: IMMessageEvent): void;
}

export function createPersonalGuestGate(channel: ImChatSettingsChannel, pausedNotice: () => string): PersonalGuestGate {
  return {
    async admit(event, notify) {
      const botId = event.contextId;
      const chatId = imChatIdOfLane(channel, event.senderId);
      // 私聊的非主人在各传输层就被挡住; 万一漏到这里也不回答。
      if (!chatId || !botId) return false;
      void ensureImChatMembersSeeded(channel, botId);
      if (!imChatMembersAllowed(channel, botId, chatId)) return false;
      if (readImChatSettings(channel, botId, chatId)?.membersPaused) return false;
      const key = streakKey(channel, botId, chatId);
      const prior = streaks.get(key) ?? 0;
      // 暂停没能写进设置时, 计数停在上限, 在内存里暂停到主人下次说话。
      if (prior >= IM_CHAT_MEMBER_BREAKER_LIMIT) return false;
      const count = prior + 1;
      streaks.set(key, count);
      if (count >= IM_CHAT_MEMBER_BREAKER_LIMIT) {
        try {
          writeImChatSettings(channel, botId, chatId, { membersPaused: true }, null);
          streaks.delete(key);
        } catch (err) {
          log.warn(`${channel} member pause not saved: ${err instanceof Error ? err.message : String(err)}`);
        }
        void notify(pausedNotice()).catch(() => {
          log.warn(`${channel} member pause notice failed`);
        });
      }
      // 第 10 次仍然回答(同微信插件)。
      return true;
    },
    ownerSpoke(event) {
      const botId = event.contextId;
      const chatId = imChatIdOfLane(channel, event.senderId);
      if (!chatId || !botId) return;
      void ensureImChatMembersSeeded(channel, botId);
      streaks.delete(streakKey(channel, botId, chatId));
      if (!readImChatSettings(channel, botId, chatId)?.membersPaused) return;
      try {
        writeImChatSettings(channel, botId, chatId, { membersPaused: false }, null);
      } catch (err) {
        log.warn(`${channel} member resume not saved: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}

export const __testing = {
  reset(): void {
    streaks.clear();
    seeding.clear();
  },
};
