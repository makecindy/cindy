import { parseBotPeerAddress, botPeerAddress, MAX_BOT_PEER_ADDRESS_CHARS } from '../../shared/botPeerAddress.js';
import { createHash, randomUUID } from 'node:crypto';
import { withBotProfileLocks } from './botProfileLock.js';

import { and, asc, desc, eq, inArray, isNull, ne } from 'drizzle-orm';

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
import { UI_ACTION_TRIGGER_PREFIX } from '../../shared/interruptedTurn.js';
import {
  BOT_DIRECT_MESSAGE_CLIENT_ID,
  type BotDirectMessageChangedPayload,
  type BotDirectMessageMeta,
  type BotDirectMessageThreadResult,
  type BotDirectMessageThreadView,
} from '../../shared/botDirectMessage.js';

const MAX_MESSAGE_CHARS = 16_000;
const MAX_SENDER_NAME_CHARS = 48;
const MAX_SENDER_ID_CHARS = MAX_BOT_PEER_ADDRESS_CHARS;
/** Six request/reply pairs are enough to clarify a handoff without letting two Bots chatter forever. */
const MAX_MESSAGES_PER_THREAD = 12;
const THREAD_IDLE_TIMEOUT_MS = 15 * 60_000;
const LIMIT_COOLDOWN_MS = 5 * 60_000;

function trustedHeaderLabel(value: string, maxChars: number): string {
  const withoutControlCharacters = Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f ? ' ' : character;
  }).join('');
  const normalized = withoutControlCharacters
    .replace(/["\\]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1))}…`;
}

type DispatchResult =
  | {
      ok: true;
      targetSessionId: string;
      wakeKind: 'resumed' | 'already-active' | 'created' | 'queued';
    }
  | { ok: false; errorCode: string; message: string };

type BotDirectMessageWakeKind = Extract<DispatchResult, { ok: true }>['wakeKind'] | 'unknown';

interface BotRosterEntry {
  id: string;
  name: string;
}

export type BotDirectMessageResult =
  | {
      ok: true;
      targetBotId: string;
      targetBotName: string;
      targetSessionId: string;
      wakeKind: BotDirectMessageWakeKind;
      threadId: string;
      messageCount: number;
      remainingMessages: number;
      conversationEnded: boolean;
      messageId: string;
      accepted: true;
      delivered: boolean;
      transport?: 'remote-conversation';
    }
  | {
      ok: false;
      errorCode: string;
      message: string;
      availableBots?: BotRosterEntry[];
      messageId?: string;
    };

/** Device transport is injected; it retains device-link's account and control gates. */
export interface BotMessageTransport {
  selfDeviceId(): string | null;
  verifySender(input: { controllerDeviceId: string; senderBotId: string; targetBotId: string; messageId: string; message: string }, assertCurrent: () => void): Promise<boolean>;
  resolve(targetId: string): Promise<{ id: string; name: string; bridgeSessionId?: string }>;
  list(): Promise<{ agents: Array<{ id: string; name: string; deviceId: string; deviceName: string }>; unavailableDevices: Array<{ deviceId: string; deviceName: string; errorCode: string }> }>;
  send(input: { targetId: string; senderBotId: string; senderName?: string; message: string; messageId: string; bridgeSessionId?: string }, assertCurrent: () => void): Promise<BotDirectMessageResult>;
  readReceipt?(input: { targetId: string; senderBotId: string; messageId: string }, assertCurrent: () => void): Promise<{ messageId: string; accepted: true | null }>;
  readReply?(input: { targetId: string; sessionId: string; messageId: string }, assertCurrent: () => void): Promise<{
    delivered: boolean; replies: Array<{ id: string; content: string }>; truncated: boolean;
  }>;
}

export interface BotDirectMessageServiceDeps {
  transport?: BotMessageTransport;
  dispatch: (params: {
    targetSessionId: string;
    message: string;
    persistedContent?: string;
    clientId?: string;
    onAccepted?: () => void | Promise<void>;
    onAcceptedRollback?: () => void | Promise<void>;
  }) => Promise<DispatchResult>;
  /** Reuses the canonical-session ensure path for newly-created/recovering Bots. */
  ensureCanonicalSession?: (
    botId: string,
  ) => Promise<{ ok: true; sessionId: string } | { ok: false; errorCode: string; message: string }>;
  /** True only when the durable input queue already owns this delivery. */
  hasQueuedDelivery?: (sessionId: string, clientId: string) => Promise<boolean>;
  captureOwnerScope?: () => DataOwnerBroadcastScope;
  isOwnerScopeCurrent?: (scope: DataOwnerBroadcastScope) => boolean;
  onChanged?: (payload: BotDirectMessageChangedPayload, ownerScope?: DataOwnerBroadcastScope) => void;
  now?: () => number;
  createId?: () => string;
}

async function activeRoster(): Promise<BotRosterEntry[]> {
  const db = getDbClient().drizzle;
  return db
    .select({ id: botProfiles.id, name: botProfiles.displayName })
    .from(botProfiles)
    .where(eq(botProfiles.status, 'active'))
    .orderBy(desc(botProfiles.updatedAt));
}

async function failed(
  errorCode: string,
  message: string,
  includeRoster = false,
): Promise<BotDirectMessageResult> {
  return {
    ok: false,
    errorCode,
    message,
    ...(includeRoster ? { availableBots: await activeRoster() } : {}),
  };
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

async function loadTargetProfile(botId: string) {
  const db = getDbClient().drizzle;
  const [profile] = await db
    .select({ status: botProfiles.status, name: botProfiles.displayName, hiddenAt: botProfiles.hiddenAt })
    .from(botProfiles)
    .where(eq(botProfiles.id, botId))
    .limit(1);
  return profile;
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
 * `send_to_agent`: a lightweight Bot-to-Bot DM over Cindy's real
 * canonical Session. It intentionally does not create delegation state,
 * workers, transcripts or a second runtime.
 */
export function createBotDirectMessageService(deps: BotDirectMessageServiceDeps) {
  const createId = deps.createId ?? randomUUID;
  const now = deps.now ?? Date.now;
  const pairLocks = new Map<string, Promise<void>>();

  const withPairLock = async <T>(key: string, run: () => Promise<T>): Promise<T> => {
    const previous = pairLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    pairLocks.set(key, queued);
    await previous;
    try {
      return await run();
    } finally {
      release();
      if (pairLocks.get(key) === queued) pairLocks.delete(key);
    }
  };

  const pairOf = (left: string, right: string): [string, string] =>
    left.localeCompare(right) <= 0 ? [left, right] : [right, left];

  // Bind every projection (send, recovery and reply) to the operation's original
  // owner. createMessage retains that scope across its own asynchronous DB write
  // and drops stale broadcasts rather than stamping them as the next account.
  const assertProjectionOwner = (owner: DataOwnerBroadcastScope | undefined) => {
    if (owner !== undefined && deps.isOwnerScopeCurrent && !deps.isOwnerScopeCurrent(owner)) {
      throw Object.assign(new Error('Account changed'), { code: 'OWNER_CHANGED' });
    }
  };

  const persistTimelineAnchor = async (params: {
    threadId: string;
    deliveryId: string;
    sequence: number;
    sessionId: string;
    viewerBotId: string;
    peerBotId: string;
    peerBotName: string;
    direction: BotDirectMessageMeta['direction'];
    preview: string;
    createdAt: number;
    ownerScope: DataOwnerBroadcastScope | undefined;
  }): Promise<void> => {
    assertProjectionOwner(params.ownerScope);
    await createMessage(params.sessionId, {
      clientId: BOT_DIRECT_MESSAGE_CLIENT_ID.timelineAnchor(
        params.threadId,
        params.deliveryId,
        params.sessionId,
      ),
      role: 'assistant',
      content: '',
      agentKind: null,
      createdAt: params.createdAt,
      agentMeta: {
        botDirectMessage: {
          v: 1,
          threadId: params.threadId,
          viewerBotId: params.viewerBotId,
          peerBotId: params.peerBotId,
          peerBotName: params.peerBotName,
          direction: params.direction,
          sequence: params.sequence,
          preview: params.preview.slice(0, 400),
        } satisfies BotDirectMessageMeta,
      },
    }, { broadcastOwnerScope: params.ownerScope });
    assertProjectionOwner(params.ownerScope);
  };

  const persistDeliveryAnchors = async (
    row: typeof botDirectMessages.$inferSelect,
    senderName: string,
    recipientName: string,
    ownerScope: DataOwnerBroadcastScope | undefined,
  ): Promise<void> => {
    const anchors = await Promise.allSettled([
      ...(row.senderSessionId ? [persistTimelineAnchor({
        threadId: row.threadId, deliveryId: row.id, sequence: row.sequence,
        sessionId: row.senderSessionId, viewerBotId: row.senderBotId,
        peerBotId: row.recipientBotId, peerBotName: recipientName,
        direction: 'sent', preview: row.content, createdAt: row.createdAt, ownerScope,
      })] : []),
      ...(row.recipientSessionId ? [persistTimelineAnchor({
        threadId: row.threadId, deliveryId: row.id, sequence: row.sequence,
        sessionId: row.recipientSessionId, viewerBotId: row.recipientBotId,
        peerBotId: row.senderBotId, peerBotName: senderName,
        direction: 'received', preview: row.content, createdAt: row.createdAt, ownerScope,
      })] : []),
    ]);
    // Settle both writes before rollback so a late write cannot recreate an orphan.
    const rejected = anchors.find((anchor) => anchor.status === 'rejected');
    if (rejected?.status === 'rejected') throw rejected.reason;
  };

  /** Reconcile receipts after restart without replaying uncertain model/tool work. */
  const restore = async (): Promise<void> => {
    const owner = deps.captureOwnerScope?.();
    const assertOwner = () => {
      if (owner !== undefined && deps.isOwnerScopeCurrent && !deps.isOwnerScopeCurrent(owner)) {
        throw new Error('owner changed during Bot message recovery');
      }
    };
    const db = getDbClient().drizzle;
    const pending = await db.select().from(botDirectMessages)
      .where(eq(botDirectMessages.deliveryStatus, 'pending'));
    for (const candidate of pending) {
      assertOwner();
      const pairKey = pairOf(candidate.senderBotId, candidate.recipientBotId).join('\u0000');
      await withPairLock(pairKey, async () => {
        assertOwner();
        const [row] = await db.select().from(botDirectMessages)
          .where(and(eq(botDirectMessages.id, candidate.id), eq(botDirectMessages.deliveryStatus, 'pending')))
          .limit(1);
        if (!row) return;
        // An outbound remote timeout is uncertain. Never refund its budget or replay
        // it based on the absence of a receipt in this device's local database.
        if (parseBotPeerAddress(row.recipientBotId)) return;
        const clientId = `bot-dm:${row.threadId}:${row.id}`;
        const [receipt] = row.recipientSessionId ? await db.select({ id: messages.id }).from(messages)
          .where(and(eq(messages.sessionId, row.recipientSessionId), eq(messages.clientId, clientId), isNull(messages.rewindAt)))
          .limit(1) : [];
        const queued = !receipt && row.recipientSessionId && deps.hasQueuedDelivery
          ? await deps.hasQueuedDelivery(row.recipientSessionId, clientId) : false;
        assertOwner();
        if (receipt || queued) {
          const names = await db.select({ id: botProfiles.id, name: botProfiles.displayName }).from(botProfiles)
            .where(inArray(botProfiles.id, [row.senderBotId, row.recipientBotId]));
          assertOwner();
          await persistDeliveryAnchors(row,
            names.find((item) => item.id === row.senderBotId)?.name ?? row.senderName ?? row.senderBotId,
            names.find((item) => item.id === row.recipientBotId)?.name ?? row.recipientName ?? row.recipientBotId, owner);
        } else {
          // Reservation alone is not proof of acceptance. Preserve the failed audit
          // row, remove partial projections, and return its budget to the pair.
          await db.delete(messages).where(inArray(messages.clientId,
            [row.senderSessionId, row.recipientSessionId].filter((id): id is string => !!id)
              .map((id) => BOT_DIRECT_MESSAGE_CLIENT_ID.timelineAnchor(row.threadId, row.id, id))));
        }
        const [thread] = await db.select().from(botDirectMessageThreads)
          .where(eq(botDirectMessageThreads.id, row.threadId)).limit(1);
        if (thread) {
          const live = await db.select({ id: botDirectMessages.id }).from(botDirectMessages)
            .where(and(eq(botDirectMessages.threadId, row.threadId), ne(botDirectMessages.deliveryStatus, 'failed')));
          const messageCount = live.filter((item) => receipt || queued || item.id !== row.id).length;
          assertOwner();
          await db.update(botDirectMessageThreads).set({
            messageCount,
            ...(thread.closeReason === 'message-limit' && messageCount < thread.maxMessages
              ? { status: 'active' as const, closeReason: null, blockedUntil: null, closedAt: null } : {}),
          }).where(eq(botDirectMessageThreads.id, row.threadId));
        }
        assertOwner();
        // Finish last: a crash while repairing anchors/counts leaves a pending row
        // that the next restore can reconcile again without replaying the delivery.
        await db.update(botDirectMessages).set({ deliveryStatus: receipt || queued ? 'delivered' : 'failed' })
          .where(eq(botDirectMessages.id, row.id));
        assertOwner();
        deps.onChanged?.({ threadId: row.threadId, participantBotIds: [row.senderBotId, row.recipientBotId] }, owner);
      });
    }
  };

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

  const sendMessage = async (input: {
    callerSessionId: string;
    targetBotId: string;
    message: string;
  }, remoteSender?: { id: string; name: string; messageId: string }): Promise<BotDirectMessageResult> => {
    const ownerScope = deps.captureOwnerScope?.();
    const ownerIsCurrent = (): boolean =>
      ownerScope === undefined || !deps.isOwnerScopeCurrent || deps.isOwnerScopeCurrent(ownerScope);
    const message = input.message.trim();
    if (!message || message.length > MAX_MESSAGE_CHARS) {
      return failed('INVALID_ARGS', `message 必须为 1-${MAX_MESSAGE_CHARS} 个字符`);
    }

    const caller = remoteSender ? {
      botId: remoteSender.id, botName: remoteSender.name, sessionSource: 'bot',
      sessionStatus: 'active', botStatus: 'active', role: 'canonical', linkArchivedAt: null,
    } : await loadCaller(input.callerSessionId);
    if (!ownerIsCurrent()) return failed('OWNER_CHANGED', '账号已经切换，本次伙伴消息未发送');
    if (!caller || caller.sessionSource !== 'bot') {
      return failed('NOT_A_BOT_SESSION', '当前任务不属于任何伙伴');
    }
    if (caller.sessionStatus !== 'active' || caller.botStatus !== 'active') {
      return failed('BOT_SESSION_INACTIVE', '当前 Bot 主任务已暂停、归档或删除');
    }
    if (caller.role !== 'canonical' || caller.linkArchivedAt !== null) {
      return failed('NOT_CANONICAL_BOT_SESSION', 'send_to_agent 只能从伙伴主任务发送');
    }
    if (caller.botId === input.targetBotId) {
      return failed('SELF_MESSAGE', '不能给当前伙伴自己发送消息');
    }

    const remoteTarget = parseBotPeerAddress(input.targetBotId);
    if (remoteTarget && remoteSender) return failed('INVALID_ARGS', 'Remote forwarding is not supported');
    let targetProfile: { name: string; status: string; hiddenAt?: number | null } | undefined;
    let bridgeSessionId: string | undefined;
    if (remoteTarget) {
      if (!deps.transport?.selfDeviceId()) return failed('DEVICE_LINK_NOT_CONNECTED', 'Device link is not connected');
      try {
        const target = await deps.transport.resolve(input.targetBotId);
        bridgeSessionId = target.bridgeSessionId;
        targetProfile = { name: target.name, status: 'active' };
      } catch (error) {
        return transportFailure(error);
      }
    } else targetProfile = await loadTargetProfile(input.targetBotId);
    if (!ownerIsCurrent()) return failed('OWNER_CHANGED', '账号已经切换，本次伙伴消息未发送');
    if (!targetProfile) {
      return failed('TARGET_BOT_NOT_FOUND', '找不到目标 Bot', true);
    }
    if (remoteSender && targetProfile.hiddenAt) return failed('NOT_FOUND', 'Remote teammate is unavailable');
    if (targetProfile.status !== 'active') {
      return failed('TARGET_BOT_INACTIVE', '目标 Bot 已暂停或归档', true);
    }

    // Resolve on every use so a missing/deleted canonical task can be repaired
    // before the message is persisted or queued against a Session id.
    let targetSessionId: string | null = null;
    if (!remoteTarget && deps.ensureCanonicalSession) {
      const ensured = await deps.ensureCanonicalSession(input.targetBotId);
      if (!ownerIsCurrent()) return failed('OWNER_CHANGED', '账号已经切换，本次伙伴消息未发送');
      if (ensured.ok) targetSessionId = ensured.sessionId;
      else return failed(ensured.errorCode, ensured.message, true);
    }
    if (!remoteTarget && !targetSessionId) {
      const target = await loadTargetCanonicalSession(input.targetBotId);
      targetSessionId = target?.sessionId ?? null;
    }
    if (!remoteTarget && !targetSessionId) {
      return failed('TARGET_CANONICAL_UNAVAILABLE', '目标 Bot 没有可用的主任务', true);
    }

    const [botAId, botBId] = pairOf(caller.botId, input.targetBotId);
    const pairKey = `${botAId}\u0000${botBId}`;
    const outcome = await withPairLock(pairKey, () => withBotProfileLocks([botAId, botBId], async (): Promise<BotDirectMessageResult | (() => Promise<BotDirectMessageResult>)> => {
      if (!ownerIsCurrent()) return failed('OWNER_CHANGED', '账号已经切换，本次伙伴消息未发送');
      // Admission above may precede a queued delete/pause. Re-read after obtaining
      // both lifecycle locks, before creating any shared thread or message row.
      const currentCaller = remoteSender ? caller : await loadCaller(input.callerSessionId);
      if (!currentCaller || currentCaller.botId !== caller.botId || currentCaller.sessionSource !== 'bot'
        || currentCaller.sessionStatus !== 'active' || currentCaller.botStatus !== 'active'
        || currentCaller.role !== 'canonical' || currentCaller.linkArchivedAt !== null) {
        return failed('BOT_SESSION_INACTIVE', '当前 Bot 主任务已暂停、归档或删除');
      }
      const currentTarget = remoteTarget ? targetProfile : await loadTargetProfile(input.targetBotId);
      if (!currentTarget || currentTarget.status !== 'active' || (remoteSender && currentTarget.hiddenAt)) {
        return failed('TARGET_BOT_INACTIVE', '目标 Bot 已暂停或归档', true);
      }
      if (!ownerIsCurrent()) return failed('OWNER_CHANGED', '账号已经切换，本次伙伴消息未发送');
      const db = getDbClient().drizzle;
      if (remoteSender) {
        const [existing] = await db.select().from(botDirectMessages)
          .where(eq(botDirectMessages.id, remoteSender.messageId)).limit(1);
        if (existing) {
          if (existing.senderBotId !== caller.botId || existing.recipientBotId !== input.targetBotId
            || existing.content !== message) return failed('INVALID_ARGS', 'Message identity conflict');
          // A retry may inspect the durable acceptance but cannot dispatch twice.
          if (existing.deliveryStatus !== 'delivered') return {
            ok: false, errorCode: 'DELIVERY_UNKNOWN', message: 'Delivery is unconfirmed; do not resend', messageId: existing.id,
          };
          const [thread] = await db.select().from(botDirectMessageThreads)
            .where(eq(botDirectMessageThreads.id, existing.threadId)).limit(1);
          return { ok: true, targetBotId: input.targetBotId, targetBotName: targetProfile.name,
            targetSessionId: existing.recipientSessionId ?? '', wakeKind: 'queued', threadId: existing.threadId,
            messageCount: thread?.messageCount ?? 0, remainingMessages: 0, conversationEnded: thread?.status === 'closed',
            messageId: existing.id, accepted: true, delivered: false };
        }
      }
      const sentAt = now();
      const activeThreads = await db
        .select()
        .from(botDirectMessageThreads)
        .where(
          and(
            eq(botDirectMessageThreads.botAId, botAId),
            eq(botDirectMessageThreads.botBId, botBId),
            eq(botDirectMessageThreads.status, 'active'),
          ),
        )
        .limit(1);
      let thread: typeof botDirectMessageThreads.$inferSelect | undefined = activeThreads[0];

      if (thread && thread.expiresAt <= sentAt) {
        await db
          .update(botDirectMessageThreads)
          .set({
            status: 'closed',
            closeReason: 'idle-timeout',
            closedAt: sentAt,
            updatedAt: sentAt,
          })
          .where(eq(botDirectMessageThreads.id, thread.id));
        thread = undefined;
      }

      if (!thread) {
        const [latest] = await db
          .select()
          .from(botDirectMessageThreads)
          .where(
            and(
              eq(botDirectMessageThreads.botAId, botAId),
              eq(botDirectMessageThreads.botBId, botBId),
            ),
          )
          .orderBy(desc(botDirectMessageThreads.updatedAt))
          .limit(1);
        if (
          latest?.closeReason === 'message-limit' &&
          latest.blockedUntil !== null &&
          latest.blockedUntil > sentAt
        ) {
          return failed(
            'CONVERSATION_LIMIT_REACHED',
            '这轮伙伴对话已达到往来上限，请先回到各自主任务整理结果，稍后再开启新一轮。',
          );
        }
        const threadId = createId();
        await db.insert(botDirectMessageThreads).values({
          id: threadId,
          botAId,
          botBId,
          status: 'active',
          closeReason: null,
          messageCount: 0,
          maxMessages: MAX_MESSAGES_PER_THREAD,
          expiresAt: sentAt + THREAD_IDLE_TIMEOUT_MS,
          blockedUntil: null,
          createdAt: sentAt,
          updatedAt: sentAt,
          closedAt: null,
        });
        [thread] = await db
          .select()
          .from(botDirectMessageThreads)
          .where(eq(botDirectMessageThreads.id, threadId))
          .limit(1);
      }
      if (!thread) return failed('INTERNAL', '伙伴对话未能建立');

      // A previous process may have stopped between reserving a delivery and
      // updating the thread counter. Re-derive the small bounded count so one
      // partial write can never wedge the pair forever or reopen extra budget.
      const reservations = await db
        .select({
          deliveryStatus: botDirectMessages.deliveryStatus,
          sequence: botDirectMessages.sequence,
        })
        .from(botDirectMessages)
        .where(eq(botDirectMessages.threadId, thread.id));
      const reservedCount = reservations.filter((row) => row.deliveryStatus !== 'failed').length;
      if (reservedCount !== thread.messageCount) {
        await db
          .update(botDirectMessageThreads)
          .set({ messageCount: reservedCount })
          .where(eq(botDirectMessageThreads.id, thread.id));
        thread = { ...thread, messageCount: reservedCount };
      }
      if (thread.messageCount >= thread.maxMessages - (bridgeSessionId ? 1 : 0)) {
        return failed('CONVERSATION_LIMIT_REACHED', '这轮伙伴对话已达到往来上限，请先回到各自主任务整理结果。');
      }

      const recent = await db
        .select({ senderBotId: botDirectMessages.senderBotId })
        .from(botDirectMessages)
        .where(
          and(
            eq(botDirectMessages.threadId, thread.id),
            ne(botDirectMessages.deliveryStatus, 'failed'),
          ),
        )
        .orderBy(desc(botDirectMessages.sequence))
        .limit(2);
      if (recent.length === 2 && recent.every((row) => row.senderBotId === caller.botId)) {
        return failed('WAIT_FOR_PEER', '已连续发出 2 条消息，请等待对方回应后再继续。');
      }

      const senderName = trustedHeaderLabel(caller.botName, MAX_SENDER_NAME_CHARS);
      const senderId = trustedHeaderLabel(caller.botId, MAX_SENDER_ID_CHARS);
      const envelope = [
        `[Direct message from Cindy Bot "${senderName}" (${senderId})]`,
        `Handle this in your current canonical task. If a useful answer, result, or clarification should go back, call send_to_agent with target_id="${senderId}". Do not send acknowledgement-only replies.`,
        message,
      ].join('\n\n');
      const deliveryId = remoteSender?.messageId ?? createId();
      const nextCount = thread.messageCount + 1;
      // Failed deliveries release budget but retain their audit row. Sequence
      // is a durable ordering key, so it must never reuse a failed row's value.
      const nextSequence = reservations.reduce((last, row) => Math.max(last, row.sequence), 0) + 1;
      const ended = nextCount >= thread.maxMessages;

      // Reserve budget before enqueueing. Pending rows count against the hard
      // loop limit, so a busy target cannot accumulate an unbounded hidden queue.
      await db.insert(botDirectMessages).values({
        id: deliveryId,
        threadId: thread.id,
        sequence: nextSequence,
        senderBotId: caller.botId,
        recipientBotId: input.targetBotId,
        senderSessionId: remoteSender ? null : input.callerSessionId,
        recipientSessionId: targetSessionId,
        deliveryStatus: 'pending',
        senderName: caller.botName, recipientName: targetProfile.name, bridgeSessionId: bridgeSessionId ?? null,
        content: message,
        createdAt: sentAt,
      });
      try {
        await db
          .update(botDirectMessageThreads)
          .set({
            messageCount: nextCount,
            updatedAt: sentAt,
            expiresAt: sentAt + THREAD_IDLE_TIMEOUT_MS,
            ...(ended
              ? {
                  status: 'closed' as const,
                  closeReason: 'message-limit' as const,
                  blockedUntil: sentAt + LIMIT_COOLDOWN_MS,
                  closedAt: sentAt,
                }
              : {}),
          })
          .where(eq(botDirectMessageThreads.id, thread.id));
      } catch (error) {
        await db
          .update(botDirectMessages)
          .set({ deliveryStatus: 'failed' })
          .where(eq(botDirectMessages.id, deliveryId))
          .catch(() => undefined);
        throw error;
      }

      let accepted = false;
      const rollbackReservation = async (detachedKnownRejection = false) => {
        // `db` was captured before reservation and is bound to that owner's database
        // (both the worker proxy and in-process Drizzle handle). A known rejection
        // may clean up that handle after logout, but must never reacquire the current
        // client's database. A disposed handle fails closed; no new-owner broadcast.
        if (!detachedKnownRejection && !ownerIsCurrent()) return;
        if (accepted) return;
        await db
          .update(botDirectMessages)
          .set({ deliveryStatus: 'failed' })
          .where(eq(botDirectMessages.id, deliveryId));
        // `onAccepted` writes one anchor per canonical timeline. If its second
        // write (or the final delivery-status update) fails, remove any partial
        // projection so neither Bot sees a conversation entry that never
        // became an accepted delivery.
        await db
          .delete(messages)
          .where(
            inArray(messages.clientId, [
              BOT_DIRECT_MESSAGE_CLIENT_ID.timelineAnchor(
                thread.id,
                deliveryId,
                input.callerSessionId,
              ),
              BOT_DIRECT_MESSAGE_CLIENT_ID.timelineAnchor(
                thread.id,
                deliveryId,
                targetSessionId ?? '',
              ),
            ]),
          )
          .catch(() => undefined);
        const liveReservations = await db
          .select({ id: botDirectMessages.id })
          .from(botDirectMessages)
          .where(
            and(
              eq(botDirectMessages.threadId, thread.id),
              ne(botDirectMessages.deliveryStatus, 'failed'),
            ),
          );
        const liveCount = liveReservations.length;
        // A reverse send may have reached the limit while this remote request
        // awaited its receipt outside the pair lock. Re-read under the lock so
        // rollback releases that closure without reopening a different one.
        const [currentThread] = await db.select().from(botDirectMessageThreads)
          .where(eq(botDirectMessageThreads.id, thread.id)).limit(1);
        await db
          .update(botDirectMessageThreads)
          .set({
            messageCount: liveCount,
            ...(currentThread?.closeReason === 'message-limit' && liveCount < currentThread.maxMessages
              ? {
                  status: 'active' as const,
                  closeReason: null,
                  blockedUntil: null,
                  closedAt: null,
                }
              : {}),
          })
          .where(eq(botDirectMessageThreads.id, thread.id));
      };

      const onAccepted = async () => {
        if (!ownerIsCurrent()) throw new Error('owner changed before Bot message acceptance');
        await persistDeliveryAnchors({
          id: deliveryId, threadId: thread.id, sequence: nextSequence,
          senderBotId: caller.botId, recipientBotId: input.targetBotId,
          senderSessionId: remoteSender ? null : input.callerSessionId, recipientSessionId: targetSessionId,
          senderName: caller.botName, recipientName: targetProfile.name, bridgeSessionId: bridgeSessionId ?? null,
          content: message, deliveryStatus: 'pending', createdAt: sentAt,
        }, caller.botName, targetProfile.name, ownerScope);
        await db.update(botDirectMessages).set({ deliveryStatus: 'delivered' })
          .where(eq(botDirectMessages.id, deliveryId));
        accepted = true;
        deps.onChanged?.({ threadId: thread.id, participantBotIds: [botAId, botBId] }, ownerScope);
      };
      if (remoteTarget) return async (): Promise<BotDirectMessageResult> => {
        // Preserve pending state when the response is lost: the peer may already be
        // running tools. Transport writes are never automatically replayed.
        try {
          const result = await deps.transport!.send({ targetId: input.targetBotId,
            senderBotId: caller.botId, senderName: caller.botName, message, messageId: deliveryId, bridgeSessionId }, () => {
            if (!ownerIsCurrent()) throw new Error('[OWNER_CHANGED] Account changed');
          });
          if (!result.ok && result.errorCode !== 'DELIVERY_UNKNOWN') {
            // Preserve a definite pre-send/rejection result even if the owner changed.
            // If its old handle has already closed, retain the conservative reservation
            // until the existing thread expiry; never write through a new owner's client.
            await withPairLock(pairKey, () => rollbackReservation(true)).catch(() => undefined);
            return { ...result, messageId: deliveryId };
          }
          if (!ownerIsCurrent()) return { ok: false, errorCode: 'DELIVERY_UNKNOWN', message: 'Account changed before receipt', messageId: deliveryId };
          if (!result.ok) return { ...result, messageId: deliveryId };
          await withPairLock(pairKey, onAccepted);
          return { ...result, targetBotId: input.targetBotId, targetBotName: targetProfile.name,
            targetSessionId: '', threadId: thread.id, messageId: deliveryId,
            messageCount: nextCount, remainingMessages: Math.max(0, thread.maxMessages - nextCount), conversationEnded: ended };
        } catch {
          return { ok: false, errorCode: 'DELIVERY_UNKNOWN', message: 'Remote acceptance is unconfirmed. Do not resend automatically.', messageId: deliveryId };
        }
      };
      let dispatched: DispatchResult;
      {
        try {
          dispatched = await deps.dispatch({
            targetSessionId: targetSessionId!, message: envelope,
            persistedContent: `${UI_ACTION_TRIGGER_PREFIX}${envelope}`,
            clientId: `bot-dm:${thread.id}:${deliveryId}`,
            onAccepted, onAcceptedRollback: rollbackReservation,
          });
        } catch (error) {
          await rollbackReservation().catch(() => undefined);
          return failed('DELIVERY_NOT_ACCEPTED', error instanceof Error ? error.message : String(error), true);
        }
        if (!dispatched.ok) {
          await rollbackReservation().catch(() => undefined);
          return failed(dispatched.errorCode, dispatched.message, true);
        }
      }

      return {
        ok: true,
        targetBotId: input.targetBotId,
        targetBotName: targetProfile.name,
        targetSessionId: dispatched.targetSessionId,
        wakeKind: dispatched.wakeKind,
        threadId: thread.id,
        messageCount: nextCount,
        remainingMessages: Math.max(0, thread.maxMessages - nextCount),
        conversationEnded: ended,
        messageId: deliveryId, accepted: true,
        delivered: dispatched.wakeKind !== 'queued',
      };
    }));
    return typeof outcome === 'function' ? outcome() : outcome;
  };

  const messageAgent = (input: { callerSessionId: string; targetBotId: string; message: string }) => {
    const peer = parseBotPeerAddress(input.targetBotId);
    // Addresses copied back onto their own device still resolve to the local profile.
    return sendMessage(peer && peer.deviceId === deps.transport?.selfDeviceId()
      ? { ...input, targetBotId: peer.botId } : input);
  };
  const receiveRemote = async (input: { controllerDeviceId: string; senderBotId: string; targetBotId: string; messageId: string; message: string }) => {
    if (!deps.transport) return failed('HOST_NOT_READY', 'Device messaging is not ready');
    const scope = deps.captureOwnerScope?.();
    const assertCurrent = () => {
      if (scope !== undefined && deps.isOwnerScopeCurrent && !deps.isOwnerScopeCurrent(scope)) {
        throw Object.assign(new Error('Account changed'), { code: 'OWNER_CHANGED' });
      }
    };
    const senderId = botPeerAddress(input.controllerDeviceId, input.senderBotId);
    try {
      const sender = await deps.transport.resolve(senderId);
      assertCurrent();
      if (!await deps.transport.verifySender(input, assertCurrent)) return failed('PERMISSION_DENIED', 'Sender has no matching canonical message reservation');
      assertCurrent();
      return sendMessage({ callerSessionId: '', targetBotId: input.targetBotId, message: input.message },
        { id: senderId, name: sender.name, messageId: input.messageId });
    } catch (error) { return transportFailure(error); }
  };
  // One in-flight discovery per current owner, shared by all local teammate sessions.
  // Never cache settled rosters, or let an old account's flight serve a new owner.
  let rosterFlight: { scope: DataOwnerBroadcastScope | undefined; promise: ReturnType<BotMessageTransport['list']> } | undefined;
  const listAgents = async (callerSessionId: string) => {
    const scope = deps.captureOwnerScope?.();
    const caller = await loadCaller(callerSessionId);
    if (!caller || caller.role !== 'canonical' || caller.linkArchivedAt !== null
      || caller.sessionSource !== 'bot' || caller.sessionStatus !== 'active' || caller.botStatus !== 'active') {
      return { ok: false as const, errorCode: 'NOT_A_BOT_SESSION', message: 'An active canonical teammate is required' };
    }
    const local = (await activeRoster()).filter(row => row.id !== caller.botId);
    let remote: Awaited<ReturnType<BotMessageTransport['list']>> = { agents: [], unavailableDevices: [] };
    let discoveryError: string | undefined;
    try {
      if (scope !== undefined && deps.isOwnerScopeCurrent && !deps.isOwnerScopeCurrent(scope))
        return { ok: false as const, errorCode: 'OWNER_CHANGED', message: 'Account changed' };
      if (deps.transport) {
        if (!rosterFlight || (rosterFlight.scope !== undefined && deps.isOwnerScopeCurrent
          && !deps.isOwnerScopeCurrent(rosterFlight.scope))) {
          const flight = { scope, promise: deps.transport.list() };
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
    return { ok: true as const, agents: [...local.map(row => ({ ...row, local: true })),
      ...remote.agents.map(row => ({ ...row, local: false }))], unavailableDevices: remote.unavailableDevices, ...(discoveryError ? { discoveryError } : {}) };
  };
  const verifyRemoteMessage = async (input: { controllerDeviceId: string; senderBotId: string; targetBotId: string; messageId: string; message: string }): Promise<boolean> => {
    const scope = deps.captureOwnerScope?.();
    const [row] = await getDbClient().drizzle.select().from(botDirectMessages)
      .where(eq(botDirectMessages.id, input.messageId)).limit(1);
    if (!row || row.bridgeSessionId || row.senderBotId !== input.senderBotId || row.recipientBotId !== botPeerAddress(input.controllerDeviceId, input.targetBotId)
      || row.content !== input.message.trim() || row.deliveryStatus === 'failed' || !row.senderSessionId) return false;
    const caller = await loadCaller(row.senderSessionId);
    if (scope !== undefined && deps.isOwnerScopeCurrent && !deps.isOwnerScopeCurrent(scope)) return false;
    return !!caller && caller.botId === input.senderBotId && caller.role === 'canonical' && caller.linkArchivedAt === null
      && caller.sessionSource === 'bot' && caller.sessionStatus === 'active' && caller.botStatus === 'active';
  };
  /** Read only the receipt belonging to the authenticated source device and exact pair. */
  const readRemoteReceipt = async (input: { controllerDeviceId: string; senderBotId: string; targetBotId: string; messageId: string }) => {
    const scope = deps.captureOwnerScope?.();
    const [row] = await getDbClient().drizzle.select().from(botDirectMessages)
      .where(and(eq(botDirectMessages.id, input.messageId),
        eq(botDirectMessages.senderBotId, botPeerAddress(input.controllerDeviceId, input.senderBotId)),
        eq(botDirectMessages.recipientBotId, input.targetBotId))).limit(1);
    if (scope !== undefined && deps.isOwnerScopeCurrent && !deps.isOwnerScopeCurrent(scope))
      throw Object.assign(new Error('Account changed'), { code: 'OWNER_CHANGED' });
    // Missing/pending/failed rows are not proof of non-delivery: a dispatch may still
    // be settling. A durable accepted row proves acceptance, not engine delivery.
    return { messageId: input.messageId, accepted: row?.deliveryStatus === 'delivered' ? true as const : null };
  };
  /** Read a native receipt or ordinary legacy reply without re-sending model/tool work. */
  const checkMessage = async (input: { callerSessionId: string; messageId: string }) => {
    const owner = deps.captureOwnerScope?.();
    const assertCurrent = () => {
      if (owner !== undefined && deps.isOwnerScopeCurrent && !deps.isOwnerScopeCurrent(owner)) {
        throw Object.assign(new Error('Account changed'), { code: 'OWNER_CHANGED' });
      }
    };
    try {
      const db = getDbClient().drizzle;
      const caller = await loadCaller(input.callerSessionId);
      if (
        !caller ||
        caller.role !== 'canonical' ||
        caller.linkArchivedAt !== null ||
        caller.sessionSource !== 'bot' ||
        caller.sessionStatus !== 'active' ||
        caller.botStatus !== 'active'
      )
        return failed('NOT_A_BOT_SESSION', 'An active canonical teammate is required');
      const [sent] = await db
        .select()
        .from(botDirectMessages)
        .where(eq(botDirectMessages.id, input.messageId))
        .limit(1);
      assertCurrent();
      if (!sent || sent.senderBotId !== caller.botId)
        return failed('NOT_FOUND', 'Message not found');
      if (sent.deliveryStatus === 'failed')
        return failed('MESSAGE_NOT_SENT', 'Message was rejected');
      if (!sent.bridgeSessionId) {
        if (!parseBotPeerAddress(sent.recipientBotId) || !deps.transport?.readReceipt)
          return failed('UNSUPPORTED_CAPABILITY', 'Receipt lookup is unavailable');
        const receipt = await deps.transport.readReceipt({ targetId: sent.recipientBotId,
          senderBotId: caller.botId, messageId: sent.id }, assertCurrent);
        assertCurrent();
        if (receipt.messageId !== sent.id)
          return failed('DELIVERY_UNKNOWN', 'Receipt identity mismatch');
        if (receipt.accepted === true) {
          const pairKey = pairOf(sent.senderBotId, sent.recipientBotId).join('\u0000');
          await withPairLock(pairKey, async () => {
            const currentCaller = await loadCaller(input.callerSessionId);
            assertCurrent();
            if (!currentCaller || currentCaller.botId !== caller.botId || currentCaller.role !== 'canonical'
              || currentCaller.linkArchivedAt !== null || currentCaller.sessionStatus !== 'active' || currentCaller.botStatus !== 'active')
              throw Object.assign(new Error('Caller inactive'), { code: 'OWNER_CHANGED' });
            const [row] = await db.select().from(botDirectMessages).where(eq(botDirectMessages.id, sent.id)).limit(1);
            assertCurrent();
            if (!row || row.deliveryStatus !== 'pending') return;
            await persistDeliveryAnchors(row, caller.botName, row.recipientName ?? row.recipientBotId, owner);
            assertCurrent();
            await db.update(botDirectMessages).set({ deliveryStatus: 'delivered' }).where(eq(botDirectMessages.id, row.id));
            assertCurrent();
            deps.onChanged?.({ threadId: row.threadId, participantBotIds: [row.senderBotId, row.recipientBotId] }, owner);
          });
        }
        return { ok: true as const, message_id: sent.id, target_id: sent.recipientBotId,
          source: 'native-receipt' as const, accepted: receipt.accepted, delivered: null, replied: false,
          guidance: 'This read only confirms durable acceptance, not engine delivery or a reply. Unknown receipts retain their budget until the existing thread expiry/cooldown. Do not resend or poll.' };
      }
      if (!deps.transport?.readReply)
        return failed('UNSUPPORTED_CAPABILITY', 'Reply lookup is unavailable');
      const result = await deps.transport.readReply(
        { targetId: sent.recipientBotId, sessionId: sent.bridgeSessionId, messageId: sent.id },
        assertCurrent,
      );
      assertCurrent();
      if (result.replies.length) {
        const pairKey = pairOf(sent.senderBotId, sent.recipientBotId).join('\u0000');
        await withPairLock(pairKey, async () => {
          assertCurrent();
          const currentCaller = await loadCaller(input.callerSessionId);
          if (
            !currentCaller ||
            currentCaller.botId !== caller.botId ||
            currentCaller.role !== 'canonical' ||
            currentCaller.linkArchivedAt !== null ||
            currentCaller.sessionStatus !== 'active' ||
            currentCaller.botStatus !== 'active'
          )
            throw Object.assign(new Error('Caller inactive'), { code: 'OWNER_CHANGED' });
          const replyId = `bridge-reply-${createHash('sha256').update(sent.id).digest('hex')}`;
          const [existing] = await db
            .select()
            .from(botDirectMessages)
            .where(eq(botDirectMessages.id, replyId))
            .limit(1);
          const content =
            '[Ordinary remote conversation reply, read by the sending host; not a remote send_to_agent call]\n\n' +
            result.replies.map((reply) => reply.content).join('\n\n');
          assertCurrent();
          const rows = await db.select().from(botDirectMessages).where(eq(botDirectMessages.threadId, sent.threadId));
          const count = rows.filter(item => item.deliveryStatus !== 'failed').length;
          assertCurrent();
          if (!existing && count >= MAX_MESSAGES_PER_THREAD) return;
          const row = existing ? { ...existing, content } : {
            id: replyId, threadId: sent.threadId,
            sequence: rows.reduce((last, item) => Math.max(last, item.sequence), 0) + 1,
            senderBotId: sent.recipientBotId, recipientBotId: sent.senderBotId,
            senderSessionId: null, recipientSessionId: input.callerSessionId,
            senderName: sent.recipientName, recipientName: sent.senderName,
            bridgeSessionId: sent.bridgeSessionId, content, createdAt: now(), deliveryStatus: 'delivered' as const,
          };
          if (existing) await db.update(botDirectMessages).set({ content }).where(eq(botDirectMessages.id, replyId));
          else await db.insert(botDirectMessages).values(row);
          // Retry repairs projections after an interrupted write, without re-sending or double counting.
          await persistDeliveryAnchors(row, sent.recipientName ?? sent.recipientBotId, caller.botName, owner);
          await persistDeliveryAnchors(sent, caller.botName, sent.recipientName ?? sent.recipientBotId, owner);
          const nextCount = count + (existing ? 0 : 1);
          const [thread] = await db.select().from(botDirectMessageThreads).where(eq(botDirectMessageThreads.id, sent.threadId)).limit(1);
          assertCurrent();
          await db.update(botDirectMessageThreads).set({ messageCount: nextCount,
            ...(nextCount >= MAX_MESSAGES_PER_THREAD && thread?.closeReason !== 'message-limit' ? { status: 'closed' as const, closeReason: 'message-limit' as const,
              blockedUntil: now() + LIMIT_COOLDOWN_MS, closedAt: now() } : {}),
          }).where(eq(botDirectMessageThreads.id, sent.threadId));
          assertCurrent();
          await db.update(botDirectMessages).set({ deliveryStatus: 'delivered' }).where(eq(botDirectMessages.id, sent.id));
          assertCurrent();
          deps.onChanged?.(
            { threadId: sent.threadId, participantBotIds: [sent.senderBotId, sent.recipientBotId] },
            owner,
          );
        });
      }
      return {
        ok: true as const,
        message_id: sent.id,
        target_id: sent.recipientBotId,
        source: 'remote-conversation' as const,
        delivered: result.delivered ? true : null,
        replied: result.replies.length > 0,
        replies: result.replies,
        truncated: result.truncated,
        guidance:
          'These are persisted ordinary reply text blocks from the remote conversation, not a remote send_to_agent call or proof that the turn has completed. A null delivered value means this read has no delivery evidence; it does not negate an earlier receipt.',
      };
    } catch (error) {
      return transportFailure(error);
    }
  };
  return { messageAgent, receiveRemote, verifyRemoteMessage, readRemoteReceipt, listAgents, checkMessage, getThread, restore };
}

export type BotDirectMessageService = ReturnType<typeof createBotDirectMessageService>;

/** Only stable transport codes cross the model boundary; never credentials or raw responses. */
function transportFailure(error: unknown): BotDirectMessageResult {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  const known = ['TARGET_CONVERSATION_CHANGED', 'SESSION_RUNNING', 'DEVICE_OFFLINE', 'REMOTE_DISABLED', 'PERMISSION_DENIED', 'DEVICE_UNRESPONSIVE',
    'ACCESS_REVOKED', 'CHANNEL_NOT_ALLOWED', 'NOT_CONNECTED', 'LINK_NOT_OPEN',
    'DEVICE_LINK_NOT_CONNECTED', 'NOT_FOUND', 'TARGET_BOT_INACTIVE', 'UNSUPPORTED_CAPABILITY', 'OWNER_CHANGED'];
  const errorCode = known.includes(code) ? code : 'REMOTE_UNAVAILABLE';
  return { ok: false, errorCode, message: `Teammate unavailable: ${errorCode}` };
}
