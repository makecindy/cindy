import { and, eq, inArray } from 'drizzle-orm';
import type { FeishuBotHostSession } from '@cindy/mcps';

import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../appSessionState.js';
import { getCurrentDbClientSnapshot, type CurrentDbClientSnapshot } from '../localDb/client/current.js';
import { botProfiles, botSessionLinks, sessions } from '../localDb/schema.js';
import type { FeishuToolTransport } from '../im/shared/channelToolScope.js';

type Caller = FeishuBotHostSession | undefined;
type ResolvedTransport = { im: FeishuToolTransport; assertCurrent: () => void; sourceLabel?: string };

/** Resolve each notification against the current account and live connection.
 * No negative cache: a session can acquire its canonical link after creation.
 */
export function createFeishuTransportResolver(deps: {
  readTurnScope: (session: Caller) => { im: FeishuToolTransport; chatKind?: string; requesterIsOwner?: boolean } | null;
  getCompanionTransport: (botId: string, ownerOpenId?: string) => FeishuToolTransport | null;
  getSharedTransport?: (ownerOpenId?: string) => FeishuToolTransport | null;
  isSharedTransport?: (im: FeishuToolTransport) => boolean;
  personalIm: FeishuToolTransport;
}) {
  return async (session: Caller, ownerOpenId?: string): Promise<ResolvedTransport> => {
    const ownerScope = activeOwnerScopeKey();
    let snapshot: CurrentDbClientSnapshot | null = null;
    // Teardown marks the boundary pending before replacing the DB or stopping IM.
    // Callers must also check after awaiting this resolver, immediately before use.
    const assertCurrent = () => {
      if (isAppSessionBoundaryPending() || activeOwnerScopeKey() !== ownerScope ||
          (snapshot && getCurrentDbClientSnapshot() !== snapshot)) {
        throw new Error('Feishu account changed');
      }
    };
    assertCurrent();
    const scope = deps.readTurnScope(session);
    // Group/guest API scopes stay untouched. Owner DM tool sends on a shared
    // connection also need the host-derived identity of their canonical task.
    if (scope && !(scope.chatKind === 'direct' && scope.requesterIsOwner
      && deps.isSharedTransport?.(scope.im))) return { im: scope.im, assertCurrent };
    const sharedTransport = (sourceLabel: string): ResolvedTransport | null => {
      const im = deps.getSharedTransport?.(ownerOpenId);
      if (!im) {
        if (scope) throw new Error('Feishu shared connection changed');
        return null;
      }
      if (scope && im !== scope.im) throw new Error('Feishu shared connection changed');
      const appId = im.getBotAppId();
      const recipient = im.getOwnerOpenId();
      const assertSharedCurrent = () => {
        assertCurrent();
        if (deps.getSharedTransport?.(recipient ?? undefined) !== im || im.getBotAppId() !== appId
          || im.getOwnerOpenId() !== recipient || !recipient || (ownerOpenId && recipient !== ownerOpenId)) {
          throw new Error('Feishu shared connection changed');
        }
      };
      assertSharedCurrent();
      return { im, assertCurrent: assertSharedCurrent, sourceLabel };
    };
    const personalTransport = (): ResolvedTransport => {
      const shared = sharedTransport('Cindy');
      if (shared) return shared;
      const assertPersonalCurrent = () => {
        assertCurrent();
        // Canonical membership may disappear between owner lookup and send.
        // Never use personal credentials for another app's resolved open_id.
        // Explicit host-recorded reply targets retain their existing behavior.
        if (ownerOpenId && ownerOpenId !== deps.personalIm.getOwnerOpenId() &&
            ownerOpenId !== session?.vendorOptions?.feishuChatId) {
          throw new Error('Feishu recipient changed');
        }
      };
      assertPersonalCurrent();
      return { im: deps.personalIm, assertCurrent: assertPersonalCurrent };
    };
    if (!session?.sessionId) return personalTransport();

    snapshot = getCurrentDbClientSnapshot();
    if (!snapshot) throw new Error('DbClient not ready');
    const row = await snapshot.client.drizzle
      .select({ botId: botSessionLinks.botId, profileStatus: botProfiles.status, displayName: botProfiles.displayName })
      .from(botSessionLinks)
      .innerJoin(sessions, eq(sessions.id, botSessionLinks.sessionId))
      .leftJoin(botProfiles, eq(botProfiles.id, botSessionLinks.botId))
      .where(and(
        eq(botSessionLinks.sessionId, session.sessionId),
        eq(sessions.source, 'bot'),
        // The owner's Bot Chat: the main Chat or one of its private-chat topics.
        inArray(botSessionLinks.role, ['canonical', 'thread', 'routine']),
      ))
      .limit(1)
      .get();
    assertCurrent();
    if (!row?.botId) return personalTransport();
    // Keep canonical identity even if its profile is missing/inactive, so pause
    // cannot turn into a personal-bot fallback while a tool call is still alive.
    if (row.profileStatus !== 'active') throw new Error('Companion is not active');
    const shared = sharedTransport(`${row.displayName ?? row.botId} · ${row.botId}`);
    if (shared) return shared;
    const im = deps.getCompanionTransport(row.botId, ownerOpenId);
    if (!im) throw new Error('Companion Feishu connection unavailable');
    return { im, assertCurrent };
  };
}
