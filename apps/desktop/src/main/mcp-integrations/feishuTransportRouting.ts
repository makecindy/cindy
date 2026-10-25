import { and, eq, inArray } from 'drizzle-orm';
import type { FeishuBotHostSession } from '@cindy/mcps';

import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../appSessionState.js';
import { getCurrentDbClientSnapshot, type CurrentDbClientSnapshot } from '../localDb/client/current.js';
import { botProfiles, botSessionLinks, sessions } from '../localDb/schema.js';
import type { FeishuToolTransport } from '../im/shared/channelToolScope.js';

type Caller = FeishuBotHostSession | undefined;
type ResolvedTransport = { im: FeishuToolTransport; assertCurrent: () => void };

/** Resolve each notification against the current account and live connection.
 * No negative cache: a session can acquire its canonical link after creation.
 */
export function createFeishuTransportResolver(deps: {
  readTurnScope: (session: Caller) => { im: FeishuToolTransport } | null;
  getCompanionTransport: (botId: string, ownerOpenId?: string) => FeishuToolTransport | null;
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
    if (scope) return { im: scope.im, assertCurrent };
    const personalTransport = (): ResolvedTransport => {
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
      .select({ botId: botSessionLinks.botId, profileStatus: botProfiles.status })
      .from(botSessionLinks)
      .innerJoin(sessions, eq(sessions.id, botSessionLinks.sessionId))
      .leftJoin(botProfiles, eq(botProfiles.id, botSessionLinks.botId))
      .where(and(
        eq(botSessionLinks.sessionId, session.sessionId),
        eq(sessions.source, 'bot'),
        // The owner's Bot Chat: the main Chat or one of its private-chat topics.
        inArray(botSessionLinks.role, ['canonical', 'thread']),
      ))
      .limit(1)
      .get();
    assertCurrent();
    if (!row?.botId) return personalTransport();
    // Keep canonical identity even if its profile is missing/inactive, so pause
    // cannot turn into a personal-bot fallback while a tool call is still alive.
    if (row.profileStatus !== 'active') throw new Error('Companion is not active');
    const im = deps.getCompanionTransport(row.botId, ownerOpenId);
    if (!im) throw new Error('Companion Feishu connection unavailable');
    return { im, assertCurrent };
  };
}
