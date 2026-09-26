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

/**
 * Resolve the public Bot route for a notification or other session-only entry.
 * The stable main task stays on the short Bot route; child and historical tasks
 * retain their own session id so opening a notification never loses context.
 */
export function botRouteForOwnedSession(
  profiles: readonly BotProfile[],
  sessionId: string,
): string | null {
  const bot = findBotProfileForSession(profiles, sessionId);
  if (!bot) return null;
  const canonicalSessionId = bot.sessions.find(
    (session) => session.role === 'canonical' || session.kind === 'chat',
  )?.id;
  return canonicalSessionId === sessionId
    ? `/bots/${encodeURIComponent(bot.id)}`
    : `/bots/${encodeURIComponent(bot.id)}/session/${encodeURIComponent(sessionId)}`;
}

export interface BotSessionEntryRouteDeps {
  readProfiles: () => readonly BotProfile[];
  readSessionSource: (sessionId: string) => Promise<string | null | undefined>;
  /** Loads the current owner's profiles; `refresh` re-reads an already loaded projection. */
  loadProfiles: (refresh: boolean) => Promise<readonly BotProfile[]>;
}

/**
 * Resolve a session-only entry such as a notification click. The in-memory
 * projection is only kept fresh while a Bots view is mounted, so a click can
 * arrive before it was ever loaded for this account, or after a new Bot session
 * was linked. Load it once, and re-read it when the row itself is a Bot session.
 */
export async function resolveBotRouteForSessionEntry(
  sessionId: string,
  deps: BotSessionEntryRouteDeps,
): Promise<string | null> {
  const known = botRouteForOwnedSession(deps.readProfiles(), sessionId);
  if (known) return known;
  const source = await deps.readSessionSource(sessionId).catch(() => null);
  const profiles = await deps.loadProfiles(source === 'bot').catch(() => []);
  return botRouteForOwnedSession(profiles, sessionId);
}

export interface SessionEntryNavigatorDeps {
  resolveBotRoute: (sessionId: string) => Promise<string | null>;
  openBotRoute: (route: string) => void;
  /** `isLatest` lets the ordinary path drop its own late async route result too. */
  openOrdinary: (sessionId: string, messageClientId: string | undefined, isLatest: () => boolean) => void;
}

/**
 * Session entries (notification clicks, task deep links) resolve asynchronously.
 * Only the latest entry may navigate, so a slow lookup for an earlier click can
 * never override a newer one.
 */
export function createSessionEntryNavigator(
  deps: SessionEntryNavigatorDeps,
): (sessionId: string, messageClientId?: string) => void {
  let sequence = 0;
  return (sessionId, messageClientId) => {
    const entry = ++sequence;
    const isLatest = () => sequence === entry;
    void deps.resolveBotRoute(sessionId).then((route) => {
      if (!isLatest()) return;
      if (route) deps.openBotRoute(route);
      else deps.openOrdinary(sessionId, messageClientId, isLatest);
    });
  };
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
