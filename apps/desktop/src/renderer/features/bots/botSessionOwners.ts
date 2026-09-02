/**
 * sessionId → 它属于哪个伙伴。
 *
 * 会话行本身不带 botId(归属存在 `bot_session_links` 里),而侧栏分组要按伙伴分组,
 * 所以需要这样一张表。它从 botStore 已有的会话投影现拼 —— **不走新的 IPC、不给
 * 会话列表那条热路径加 join**:伙伴数量是个位数,投影本来就在内存里。
 *
 * 主对话、渠道任务、归档历史三种都算进来:用户要找"小柴昨天干的那件事",不会先
 * 想清楚那是主对话还是 Telegram 里的对话。
 */

import type { BotSessionOwner } from '@/features/cc-agent/lib/projectGrouping';
import type { BotProfile } from './botStore';

/**
 * Find the Bot that owns a real Cindy Session through the projected
 * `bot_session_links` registry. The compatibility mirror on BotProfile is
 * deliberately ignored: a stale mirror must never grant Bot-only UI or tools
 * to an unrelated Session.
 */
export function findBotProfileForSession(
  profiles: readonly BotProfile[],
  sessionId: string,
): BotProfile | undefined {
  return profiles.find((profile) =>
    profile.sessions.some((session) => session.id === sessionId),
  );
}

export function buildBotSessionOwners(
  profiles: readonly BotProfile[],
): Map<string, BotSessionOwner> {
  const map = new Map<string, BotSessionOwner>();
  for (const profile of profiles) {
    const owner: BotSessionOwner = {
      botId: profile.id,
      displayName: profile.name,
      avatar: profile.avatar,
      avatarColor: profile.avatarColor,
    };
    // 归属只认 bot_session_links 的 sessions[] 投影。顶层
    // canonicalSessionId 是旧数据迁移镜像，投影缺失时不能用它抢占一条普通任务。
    for (const session of profile.sessions) {
      if (session.id) map.set(session.id, owner);
    }
  }
  return map;
}
