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
import type { RemoteBot } from './remoteBotRoster';
import { isBotGroupLaneSession } from './botGroupLane';
import { BOT_DM_THREAD_PARAM } from './botDmThreadRoute';

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
 * Where a session-only entry (notification / Agent Island click, task deep
 * link) lands for a Bot-owned Session, and whether that target can dispose the
 * clicked Agent Island card itself.
 *
 * Targets that render no disposal control for this Session's error dispose the
 * clicked card instead: a hidden group lane lives inside its group chat (`consumesAlert`,
 * once the route commits); a read-only history transcript re-checks ownership
 * after it commits and may redirect away, so its gate disposes it once shown
 * (`gateConsumesAlert`). Unread errors are immune to passive visibility acks,
 * so without this the island card could never be cleared. Main only honours it
 * for the card that was actually clicked, and only while that card is unchanged
 * (see AgentIslandService.consumeIslandEntryAlert). A live chat keeps its own
 * ErrorBanner as the only disposal path.
 */
export interface BotSessionEntryTarget {
  route: string;
  /** The entry navigator disposes the clicked card once this route has committed. */
  consumesAlert: boolean;
  /** The route's own ownership gate disposes it instead, given the click id as route state. */
  gateConsumesAlert?: boolean;
}

/**
 * Resolve the public Bot route for a notification or other session-only entry.
 * The stable main task stays on the short Bot route; history keeps its own
 * read-only route, a group lane returns to its group and a private-chat topic
 * opens beside its private chat.
 * Background tasks keep their ordinary `/cc-agent/:sessionId` route with its
 * message anchors and error controls; other live chats use the Bot session route.
 */
export function botRouteForOwnedSession(
  profiles: readonly BotProfile[],
  sessionId: string,
): BotSessionEntryTarget | null {
  const bot = findBotProfileForSession(profiles, sessionId);
  if (!bot) return null;
  const botRoute = `/bots/${encodeURIComponent(bot.id)}`;
  const projection = bot.sessions.find((session) => session.id === sessionId);
  if (isBotGroupLaneSession(projection)) {
    return {
      route: projection?.groupId ? `/bots/groups/${encodeURIComponent(projection.groupId)}` : botRoute,
      consumesAlert: true,
    };
  }
  if ((projection?.kind === 'thread' || projection?.role === 'thread') && projection.threadRoot) {
    // A private-chat topic has no page of its own: open the private chat with the topic beside it.
    return {
      route: `${botRoute}/session/${encodeURIComponent(projection.threadRoot.rootSessionId)}?${BOT_DM_THREAD_PARAM}=${encodeURIComponent(sessionId)}`,
      consumesAlert: false,
    };
  }
  if (projection?.kind === 'history' || projection?.role === 'history'
    || projection?.kind === 'channel' || projection?.role === 'channel') {
    // Its ownership gate re-checks after the route commits and may redirect away, so the
    // gate itself disposes the card once it shows the transcript.
    return { route: `${botRoute}/history/${encodeURIComponent(sessionId)}`, consumesAlert: false, gateConsumesAlert: true };
  }
  const canonicalSessionId = bot.sessions.find(
    (session) => session.role === 'canonical' || session.kind === 'chat',
  )?.id;
  if (canonicalSessionId === sessionId) return { route: botRoute, consumesAlert: false };
  if (projection?.kind === 'worker' || projection?.role === 'delegation') {
    return { route: `/cc-agent/${encodeURIComponent(sessionId)}`, consumesAlert: false };
  }
  return { route: `${botRoute}/session/${encodeURIComponent(sessionId)}`, consumesAlert: false };
}

/**
 * A companion whose main computer is another device: its chat opens on that device's
 * companion page. Only its main chat is projected here, so that is all an entry can name.
 */
export function remoteBotRouteForSession(
  remoteBots: readonly Pick<RemoteBot, 'id' | 'deviceId' | 'sessionId'>[],
  sessionId: string,
): BotSessionEntryTarget | null {
  const bot = remoteBots.find((candidate) => candidate.sessionId === sessionId);
  if (!bot) return null;
  return {
    route: `/bots/remote/${encodeURIComponent(bot.deviceId)}/${encodeURIComponent(bot.id)}`,
    consumesAlert: false,
  };
}

type LoadedBotProfilesReader = () => readonly BotProfile[] | null;
let loadedBotProfilesReader: LoadedBotProfilesReader | null = null;

/**
 * botStore registers a reader for its loaded projection when its module loads, so
 * route helpers in `lib/` (notification clicks, sidebar) read it synchronously without
 * importing the store graph — and without a dynamic import on a click, which made the
 * shared-task dialog tests time out on slow CI runners.
 */
export function registerLoadedBotProfilesReader(reader: LoadedBotProfilesReader | null): void {
  loadedBotProfilesReader = reader;
}

/** The loaded Bot profiles, or null while the store is not loaded for this account. */
export function readLoadedBotProfiles(): readonly BotProfile[] | null {
  return loadedBotProfilesReader?.() ?? null;
}

export interface BotSessionEntryRouteDeps {
  readProfiles: () => readonly BotProfile[];
  /** Loads the current owner's profiles; `refresh` re-reads an already loaded projection. */
  loadProfiles: (refresh: boolean) => Promise<readonly BotProfile[]>;
}

/**
 * Resolve a session-only entry such as a notification click. The in-memory
 * projection is only kept fresh while a Bots view is mounted, so a click can
 * arrive before it was ever loaded for this account, or after a new Bot session
 * was linked. The session row cannot tell: delegated tasks keep
 * `source: 'desktop'` and their owner lives only in `bot_session_links`. So a
 * session the projection does not know always re-reads it once.
 */
export async function resolveBotRouteForSessionEntry(
  sessionId: string,
  deps: BotSessionEntryRouteDeps,
): Promise<BotSessionEntryTarget | null> {
  const current = deps.readProfiles();
  if (findBotProfileForSession(current, sessionId)) return botRouteForOwnedSession(current, sessionId);
  const profiles = await deps.loadProfiles(true).catch(() => []);
  return botRouteForOwnedSession(profiles, sessionId);
}

export interface SessionEntryNavigatorDeps {
  /** The target from the projection already in memory; null when it does not know the Session. */
  readKnownBotRoute: (sessionId: string) => BotSessionEntryTarget | null;
  /** Re-reads the projection for a Session it did not know (see resolveBotRouteForSessionEntry). */
  resolveBotRoute: (sessionId: string) => Promise<BotSessionEntryTarget | null>;
  /** `islandEntryId` is handed to a route whose gate disposes the card (gateConsumesAlert). */
  openBotRoute: (route: string, islandEntryId?: string) => void;
  /** Asks main to dispose the card of this island click (see BotSessionEntryTarget). */
  consumeAlert: (sessionId: string, islandEntryId: string) => void;
  /** `isLatest` lets the ordinary path drop its own late async route result too. */
  openOrdinary: (sessionId: string, messageClientId: string | undefined, isLatest: () => boolean) => void;
}

export interface SessionEntryNavigator {
  (sessionId: string, messageClientId?: string, islandEntryId?: string): void;
  /** Report every location the router has committed (`pathname + search`). */
  locationCommitted: (path: string) => void;
}

/**
 * Session entries (notification clicks, task deep links) open at once from the
 * Bot projection already in memory. A Session it does not know opens on its
 * ordinary task page right away while the projection is re-read in the
 * background; a re-read that finds a Bot page moves this entry there, unless the
 * user has meanwhile gone anywhere other than that ordinary page. Waiting for
 * the re-read first made every ordinary task click wait on the whole Bot list.
 * Only the latest entry may navigate, so a slow lookup for an earlier click can
 * never override a newer one.
 *
 * An Agent Island click (`islandEntryId`) into a target without a disposal
 * control asks main to dispose that card only once the router has committed the
 * target location: immediately when it is already the committed location,
 * otherwise on the next committed location if it is the target. A newer entry,
 * the user moving on before the target is known, or a commit to any other
 * location (redirect, another navigation) drops it, so the card stays and a
 * later click can still dispose it.
 */
export function createSessionEntryNavigator(
  deps: SessionEntryNavigatorDeps,
): SessionEntryNavigator {
  let sequence = 0;
  let committedPath: string | null = null;
  // Every location committed since the latest entry opened; a correction is valid only while
  // all of them are the entry's own landing (ordinary page or the Bot target), so leaving and
  // coming back never counts as "stayed".
  let committedSinceOpen = new Set<string>();
  let pending: { entry: number; sessionId: string; islandEntryId: string; route: string } | null = null;
  const openBotTarget = (entry: number, sessionId: string, target: BotSessionEntryTarget, disposalId: string | undefined) => {
    if (target.consumesAlert && disposalId) {
      if (committedPath === target.route) {
        deps.consumeAlert(sessionId, disposalId);
      } else {
        pending = { entry, sessionId, islandEntryId: disposalId, route: target.route };
      }
    }
    try {
      deps.openBotRoute(target.route, target.gateConsumesAlert ? disposalId : undefined);
    } catch (error) {
      if (pending?.entry === entry) pending = null;
      throw error;
    }
  };
  const open = (sessionId: string, messageClientId?: string, islandEntryId?: string) => {
    const entry = ++sequence;
    pending = null;
    committedSinceOpen = new Set();
    const isLatest = () => sequence === entry;
    const known = deps.readKnownBotRoute(sessionId);
    // Background tasks keep their ordinary page with message anchors and visible-session reporting.
    if (known && !known.route.startsWith('/cc-agent/')) {
      openBotTarget(entry, sessionId, known, islandEntryId);
      return;
    }
    let movedToBotPage = false;
    deps.openOrdinary(sessionId, messageClientId, () => isLatest() && !movedToBotPage);
    if (known) return;
    const ordinaryRoute = `/cc-agent/${encodeURIComponent(sessionId)}`;
    void deps.resolveBotRoute(sessionId).then((target) => {
      if (!isLatest() || !target || target.route.startsWith('/cc-agent/')) return;
      // Correct only this entry's own landing: the ordinary page, or the Bot page the ordinary
      // path already resolved to. Any other committed location means the user moved on.
      for (const path of committedSinceOpen) {
        if (path !== ordinaryRoute && path !== target.route) return;
      }
      movedToBotPage = true;
      openBotTarget(entry, sessionId, target, islandEntryId);
    });
  };
  return Object.assign(open, {
    locationCommitted: (path: string) => {
      committedPath = path;
      committedSinceOpen.add(path);
      const waiting = pending;
      if (!waiting) return;
      pending = null;
      if (waiting.entry === sequence && waiting.route === path) {
        deps.consumeAlert(waiting.sessionId, waiting.islandEntryId);
      }
    },
  });
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
