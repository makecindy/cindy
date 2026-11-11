import { isCompanionShadowed } from '../companion-cloud/homes.js';
import { withBotProfileLocks } from './botProfileLock.js';
import { authorizeGroupTool, GroupToolAuthorizationError } from './botGroupToolAuthorization.js';
import { t } from '../i18n.desktop.js';

import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';

import { getDbClient } from '../localDb/client/current.js';
import { createMessage } from '../localDb/ipc/messages.js';
import type { DataOwnerBroadcastScope } from '../device-link/broadcast-tap.js';
import {
  botDirectMessages,
  botDirectMessageThreads,
  botProfiles,
  botSessionLinks,
  messages,
  sessions,
} from '../localDb/schema.js';
import type {
  BotDirectMessageThreadResult,
  BotDirectMessageThreadView,
} from '../../shared/botDirectMessage.js';

const MAX_MESSAGE_CHARS = 16_000;

/** Teammates on the account's other computers, read through device-link's account and control gates. */
export interface TeammateDirectory {
  list(): Promise<{
    agents: Array<{ id: string; name: string; deviceId: string; deviceName: string; sessionId?: string }>;
    unavailableDevices: Array<{ deviceId: string; deviceName: string; errorCode: string }>;
  }>;
}

export interface BotDirectMessageServiceDeps {
  directory?: TeammateDirectory;
  /** Reuses the canonical-session ensure path for newly-created/recovering Bots. */
  ensureCanonicalSession?: (
    botId: string,
    beforeRecovery?: () => Promise<void>,
  ) => Promise<{ ok: true; sessionId: string } | { ok: false; errorCode: string; message: string }>;
  captureOwnerScope?: () => DataOwnerBroadcastScope;
  isOwnerScopeCurrent?: (scope: DataOwnerBroadcastScope) => boolean;
  now?: () => number;
}

/** Local teammates with their main chat, the address send_to_session takes. */
async function activeRoster(): Promise<Array<{ id: string; name: string; sessionId?: string }>> {
  const db = getDbClient().drizzle;
  const [roster, mains] = await Promise.all([
    db.select({ id: botProfiles.id, name: botProfiles.displayName })
      .from(botProfiles)
      .where(eq(botProfiles.status, 'active'))
      .orderBy(desc(botProfiles.updatedAt)),
    db.select({ botId: botSessionLinks.botId, sessionId: botSessionLinks.sessionId })
      .from(botSessionLinks)
      .innerJoin(sessions, eq(sessions.id, botSessionLinks.sessionId))
      .where(and(eq(botSessionLinks.role, 'canonical'), isNull(botSessionLinks.archivedAt),
        eq(sessions.source, 'bot'), eq(sessions.status, 'active'))),
  ]);
  const mainOf = new Map(mains.map(row => [row.botId, row.sessionId]));
  // Demoted copies run on another computer, where list_agents finds them remotely.
  return roster.filter(row => !isCompanionShadowed(row.id)).map(row => {
    const sessionId = mainOf.get(row.id);
    return sessionId ? { ...row, sessionId } : row;
  });
}

async function loadCaller(sessionId: string) {
  const db = getDbClient().drizzle;
  const [caller] = await db
    .select({
      botId: botSessionLinks.botId,
      role: botSessionLinks.role,
      linkArchivedAt: botSessionLinks.archivedAt,
      sessionSource: sessions.source,
      sessionStatus: sessions.status,
      botStatus: botProfiles.status,
      botName: botProfiles.displayName,
    })
    .from(botSessionLinks)
    .innerJoin(sessions, eq(sessions.id, botSessionLinks.sessionId))
    .innerJoin(botProfiles, eq(botProfiles.id, botSessionLinks.botId))
    .where(eq(botSessionLinks.sessionId, sessionId))
    .limit(1);
  return caller;
}

async function loadTargetCanonicalSession(botId: string) {
  const db = getDbClient().drizzle;
  const [target] = await db
    .select({ sessionId: botSessionLinks.sessionId })
    .from(botSessionLinks)
    .innerJoin(sessions, eq(sessions.id, botSessionLinks.sessionId))
    .where(
      and(
        eq(botSessionLinks.botId, botId),
        eq(botSessionLinks.role, 'canonical'),
        isNull(botSessionLinks.archivedAt),
        eq(sessions.source, 'bot'),
        eq(sessions.status, 'active'),
      ),
    )
    .limit(1);
  return target;
}

/**
 * Teammate discovery, a group lane's private message to its owner, and the read-only
 * history of V1 Bot-to-Bot threads. Teammates now talk through send_to_session.
 */
export function createBotDirectMessageService(deps: BotDirectMessageServiceDeps) {
  const now = deps.now ?? Date.now;

  const getThread = async (
    threadId: string,
    viewerBotId: string,
  ): Promise<BotDirectMessageThreadResult> => {
    const db = getDbClient().drizzle;
    const [thread] = await db
      .select()
      .from(botDirectMessageThreads)
      .where(eq(botDirectMessageThreads.id, threadId))
      .limit(1);
    if (!thread || (thread.botAId !== viewerBotId && thread.botBId !== viewerBotId)) {
      return { ok: false, errorCode: 'NOT_FOUND', message: '找不到这条伙伴对话' };
    }
    const [profiles, rows] = await Promise.all([
      db.select({ id: botProfiles.id, name: botProfiles.displayName }).from(botProfiles),
      db
        .select()
        .from(botDirectMessages)
        .where(eq(botDirectMessages.threadId, threadId))
        .orderBy(asc(botDirectMessages.sequence)),
    ]);
    const nameOf = (botId: string): string =>
      profiles.find((profile) => profile.id === botId)?.name
      ?? rows.find((row) => row.senderBotId === botId)?.senderName
      ?? rows.find((row) => row.recipientBotId === botId)?.recipientName ?? botId;
    const expired = thread.status === 'active' && thread.expiresAt <= now();
    const visibleRows = rows.filter((row) => row.deliveryStatus === 'delivered');
    const view: BotDirectMessageThreadView = {
      id: thread.id,
      botAId: thread.botAId,
      botAName: nameOf(thread.botAId),
      botBId: thread.botBId,
      botBName: nameOf(thread.botBId),
      status: expired ? 'closed' : thread.status,
      closeReason: expired ? 'idle-timeout' : thread.closeReason,
      messageCount: visibleRows.length,
      maxMessages: thread.maxMessages,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      closedAt: expired ? thread.expiresAt : thread.closedAt,
      messages: visibleRows.map((row) => ({
        id: row.id,
        sequence: row.sequence,
        senderBotId: row.senderBotId,
        senderBotName: nameOf(row.senderBotId),
        recipientBotId: row.recipientBotId,
        recipientBotName: nameOf(row.recipientBotId),
        content: row.content,
        createdAt: row.createdAt,
      })),
    };
    return { ok: true, thread: view };
  };

  // One in-flight discovery per current owner, shared by all local teammate sessions.
  // Never cache settled rosters, or let an old account's flight serve a new owner.
  let rosterFlight: { scope: DataOwnerBroadcastScope | undefined; promise: ReturnType<TeammateDirectory['list']> } | undefined;
  const listAgents = async (callerSessionId: string) => {
    const scope = deps.captureOwnerScope?.();
    const caller = await loadCaller(callerSessionId);
    if (!caller || caller.linkArchivedAt !== null
      || caller.sessionSource !== 'bot' || caller.sessionStatus !== 'active' || caller.botStatus !== 'active') {
      return { ok: false as const, errorCode: 'NOT_A_BOT_SESSION', message: 'An active teammate task is required' };
    }
    const local = (await activeRoster()).filter(row => row.id !== caller.botId)
      .map(({ sessionId, ...row }) => ({ ...row, local: true, ...(sessionId ? { session_id: sessionId } : {}) }));
    let remote: Awaited<ReturnType<TeammateDirectory['list']>> = { agents: [], unavailableDevices: [] };
    let discoveryError: string | undefined;
    try {
      if (scope !== undefined && deps.isOwnerScopeCurrent && !deps.isOwnerScopeCurrent(scope))
        return { ok: false as const, errorCode: 'OWNER_CHANGED', message: 'Account changed' };
      if (deps.directory) {
        if (!rosterFlight || (rosterFlight.scope !== undefined && deps.isOwnerScopeCurrent
          && !deps.isOwnerScopeCurrent(rosterFlight.scope))) {
          const flight = { scope, promise: deps.directory.list() };
          rosterFlight = flight;
          void flight.promise.finally(() => {
            if (rosterFlight === flight) rosterFlight = undefined;
          }).catch(() => undefined);
        }
        remote = await rosterFlight.promise;
      }
    }
    catch { discoveryError = 'REMOTE_DIRECTORY_UNAVAILABLE'; }
    if (scope !== undefined && deps.isOwnerScopeCurrent && !deps.isOwnerScopeCurrent(scope)) {
      return { ok: false as const, errorCode: 'OWNER_CHANGED', message: 'Account changed' };
    }
    // A remote main chat is addressed as deviceId::sessionId, the same form send_to_session takes.
    return { ok: true as const, agents: [...local, ...remote.agents.map(({ sessionId, ...row }) => ({ ...row, local: false,
      ...(sessionId ? { session_id: `${row.deviceId}::${sessionId}` } : {}) }))],
    unavailableDevices: remote.unavailableDevices, ...(discoveryError ? { discoveryError } : {}) };
  };
  const sendToUser = async (input: { callerSessionId: string; message: string; idempotencyKey: string }) => {
    try {
      const scope = deps.captureOwnerScope?.();
      const caller = await loadCaller(input.callerSessionId);
      if (!caller || caller.role !== 'group' || caller.linkArchivedAt !== null
        || caller.sessionSource !== 'bot' || caller.sessionStatus !== 'active' || caller.botStatus !== 'active')
        return { ok: false as const, errorCode: 'GROUP_AUTHORIZATION_REQUIRED', message: t('groupTools.authorizationRequired') };
      const authority = await authorizeGroupTool(input.callerSessionId, caller.botId, 'owner-action');
      if (!authority.sourceGroup) throw new GroupToolAuthorizationError();
      const message = input.message.trim();
      if (!message || message.length > MAX_MESSAGE_CHARS || !/^[\w-]{8,100}$/.test(input.idempotencyKey))
        return { ok: false as const, errorCode: 'INVALID_ARGS', message: t('groupTools.invalidMessage') };
      if (scope !== undefined && deps.isOwnerScopeCurrent && !deps.isOwnerScopeCurrent(scope))
        return { ok: false as const, errorCode: 'OWNER_CHANGED', message: t('groupTools.ownerChanged') };
      // Use the same recovery as peer messages before taking the delivery lock.
      // Recovery may await profile/Session preparation, so it cannot authorize delivery.
      if (deps.ensureCanonicalSession) {
        await authority.refresh();
        const ensured = await deps.ensureCanonicalSession(caller.botId, authority.refresh).finally(() => authority.refresh());
        if (scope !== undefined && deps.isOwnerScopeCurrent && !deps.isOwnerScopeCurrent(scope))
          return { ok: false as const, errorCode: 'OWNER_CHANGED', message: t('groupTools.ownerChanged') };
        if (!ensured.ok) return { ...ensured, message: t('groupTools.privateUnavailable') };
      }
      return await withBotProfileLocks([caller.botId], async () => {
        const current = await loadCaller(input.callerSessionId);
        const target = await loadTargetCanonicalSession(caller.botId);
        const clientId = `bot-group-private:${input.callerSessionId}:${input.idempotencyKey}`;
        // Recovery replaces the canonical Session but preserves its historical
        // link. A lane's retry key still identifies the original delivery.
        const [existing] = target ? await getDbClient().drizzle.select({ id: messages.id, content: messages.content, sessionId: messages.sessionId })
          .from(messages)
          .innerJoin(botSessionLinks, eq(botSessionLinks.sessionId, messages.sessionId))
          .innerJoin(sessions, eq(sessions.id, messages.sessionId))
          .where(and(eq(botSessionLinks.botId, caller.botId), inArray(botSessionLinks.role, ['canonical', 'history']),
            eq(sessions.source, 'bot'), eq(messages.clientId, clientId))).limit(1) : [];
        await authority.refresh();
        if (scope !== undefined && deps.isOwnerScopeCurrent && !deps.isOwnerScopeCurrent(scope))
          return { ok: false as const, errorCode: 'OWNER_CHANGED', message: t('groupTools.ownerChanged') };
        if (!target || !current || current.botId !== caller.botId || current.role !== 'group'
          || current.linkArchivedAt !== null || current.botStatus !== 'active' || current.sessionStatus !== 'active')
          return { ok: false as const, errorCode: 'TARGET_CANONICAL_UNAVAILABLE', message: t('groupTools.privateUnavailable') };
        if (existing) return existing.content === message
          ? { ok: true as const, messageId: existing.id, targetSessionId: existing.sessionId, delivered: true }
          : { ok: false as const, errorCode: 'IDEMPOTENCY_CONFLICT', message: t('groupTools.idempotencyConflict') };
        // An assistant message for the owner, never synthetic user input to the Bot.
        // Host-derived target prevents another account or a namesake from receiving it.
        const saved = await createMessage(target.sessionId, {
          clientId, role: 'assistant', content: message, agentKind: null,
          agentMeta: { sourceGroup: authority.sourceGroup, origin: { kind: 'session', senderSessionId: input.callerSessionId,
            senderBotId: caller.botId, senderBotName: caller.botName } },
        }, { broadcastOwnerScope: scope, beforePublish: async () => {
          await authority.refresh();
          if (scope !== undefined && deps.isOwnerScopeCurrent && !deps.isOwnerScopeCurrent(scope))
            throw new GroupToolAuthorizationError();
        } });
        return { ok: true as const, messageId: saved.id, targetSessionId: target.sessionId, delivered: true };
      });
    } catch (error) {
      return { ok: false as const, errorCode: error instanceof GroupToolAuthorizationError ? error.code : 'PRIVATE_MESSAGE_UNAVAILABLE',
        message: error instanceof GroupToolAuthorizationError ? error.message : t('groupTools.privateUnconfirmed') };
    }
  };
  return {
    sendToUser,
    listAgents: async (sessionId: string) => {
      try { return await listAgents(sessionId); } catch (error) {
        if (error instanceof GroupToolAuthorizationError) return { ok: false as const, errorCode: error.code, message: error.message };
        throw error;
      }
    },
    getThread,
  };
}

export type BotDirectMessageService = ReturnType<typeof createBotDirectMessageService>;
