import { randomUUID } from 'node:crypto';

import { and, asc, desc, eq, inArray, isNull, ne } from 'drizzle-orm';

import { getDbClient } from '../localDb/client/current.js';
import { createMessage } from '../localDb/ipc/messages.js';
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
const MAX_SENDER_ID_CHARS = 80;
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

type BotDirectMessageWakeKind = Extract<DispatchResult, { ok: true }>['wakeKind'];

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
    }
  | {
      ok: false;
      errorCode: string;
      message: string;
      availableBots?: BotRosterEntry[];
    };

export interface BotDirectMessageServiceDeps {
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
  captureOwnerScope?: () => unknown;
  isOwnerScopeCurrent?: (scope: unknown) => boolean;
  onChanged?: (payload: BotDirectMessageChangedPayload, ownerScope?: unknown) => void;
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
    .select({ status: botProfiles.status, name: botProfiles.displayName })
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
  }): Promise<void> => {
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
    });
  };

  const persistDeliveryAnchors = async (
    row: typeof botDirectMessages.$inferSelect,
    senderName: string,
    recipientName: string,
  ): Promise<void> => {
    const anchors = await Promise.allSettled([
      ...(row.senderSessionId ? [persistTimelineAnchor({
        threadId: row.threadId, deliveryId: row.id, sequence: row.sequence,
        sessionId: row.senderSessionId, viewerBotId: row.senderBotId,
        peerBotId: row.recipientBotId, peerBotName: recipientName,
        direction: 'sent', preview: row.content, createdAt: row.createdAt,
      })] : []),
      ...(row.recipientSessionId ? [persistTimelineAnchor({
        threadId: row.threadId, deliveryId: row.id, sequence: row.sequence,
        sessionId: row.recipientSessionId, viewerBotId: row.recipientBotId,
        peerBotId: row.senderBotId, peerBotName: senderName,
        direction: 'received', preview: row.content, createdAt: row.createdAt,
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
            names.find((item) => item.id === row.senderBotId)?.name ?? row.senderBotId,
            names.find((item) => item.id === row.recipientBotId)?.name ?? row.recipientBotId);
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
      profiles.find((profile) => profile.id === botId)?.name ?? botId;
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

  const messageAgent = async (input: {
    callerSessionId: string;
    targetBotId: string;
    message: string;
  }): Promise<BotDirectMessageResult> => {
    const ownerScope = deps.captureOwnerScope?.();
    const ownerIsCurrent = (): boolean =>
      ownerScope === undefined || !deps.isOwnerScopeCurrent || deps.isOwnerScopeCurrent(ownerScope);
    const message = input.message.trim();
    if (!message || message.length > MAX_MESSAGE_CHARS) {
      return failed('INVALID_ARGS', `message 必须为 1-${MAX_MESSAGE_CHARS} 个字符`);
    }

    const caller = await loadCaller(input.callerSessionId);
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

    const targetProfile = await loadTargetProfile(input.targetBotId);
    if (!ownerIsCurrent()) return failed('OWNER_CHANGED', '账号已经切换，本次伙伴消息未发送');
    if (!targetProfile) {
      return failed('TARGET_BOT_NOT_FOUND', '找不到目标 Bot', true);
    }
    if (targetProfile.status !== 'active') {
      return failed('TARGET_BOT_INACTIVE', '目标 Bot 已暂停或归档', true);
    }

    // Resolve on every use so a missing/deleted canonical task can be repaired
    // before the message is persisted or queued against a Session id.
    let targetSessionId: string | null = null;
    if (deps.ensureCanonicalSession) {
      const ensured = await deps.ensureCanonicalSession(input.targetBotId);
      if (!ownerIsCurrent()) return failed('OWNER_CHANGED', '账号已经切换，本次伙伴消息未发送');
      if (ensured.ok) targetSessionId = ensured.sessionId;
      else return failed(ensured.errorCode, ensured.message, true);
    }
    if (!targetSessionId) {
      const target = await loadTargetCanonicalSession(input.targetBotId);
      targetSessionId = target?.sessionId ?? null;
    }
    if (!targetSessionId) {
      return failed('TARGET_CANONICAL_UNAVAILABLE', '目标 Bot 没有可用的主任务', true);
    }

    const [botAId, botBId] = pairOf(caller.botId, input.targetBotId);
    const pairKey = `${botAId}\u0000${botBId}`;
    return withPairLock(pairKey, async () => {
      if (!ownerIsCurrent()) return failed('OWNER_CHANGED', '账号已经切换，本次伙伴消息未发送');
      const db = getDbClient().drizzle;
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
      if (thread.messageCount >= thread.maxMessages) {
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
      const deliveryId = createId();
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
        senderSessionId: input.callerSessionId,
        recipientSessionId: targetSessionId,
        deliveryStatus: 'pending',
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
      const rollbackReservation = async () => {
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
                targetSessionId,
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
        await db
          .update(botDirectMessageThreads)
          .set({
            messageCount: liveCount,
            ...(ended && liveCount < thread.maxMessages
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

      let dispatched: DispatchResult;
      try {
        dispatched = await deps.dispatch({
          targetSessionId,
          message: envelope,
          // The canonical timeline gets a dedicated structured trace below. Keep
          // the model-visible input durable while hiding the raw synthetic user row.
          persistedContent: `${UI_ACTION_TRIGGER_PREFIX}${envelope}`,
          clientId: `bot-dm:${thread.id}:${deliveryId}`,
          onAccepted: async () => {
            if (!ownerIsCurrent()) throw new Error('owner changed before Bot message acceptance');
            await persistDeliveryAnchors({
              id: deliveryId, threadId: thread.id, sequence: nextSequence,
              senderBotId: caller.botId, recipientBotId: input.targetBotId,
              senderSessionId: input.callerSessionId, recipientSessionId: targetSessionId,
              content: message, deliveryStatus: 'pending', createdAt: sentAt,
            }, caller.botName, targetProfile.name);
            await db
              .update(botDirectMessages)
              .set({ deliveryStatus: 'delivered' })
              .where(eq(botDirectMessages.id, deliveryId));
            accepted = true;
            deps.onChanged?.(
              { threadId: thread.id, participantBotIds: [botAId, botBId] },
              ownerScope,
            );
          },
          onAcceptedRollback: rollbackReservation,
        });
      } catch (error) {
        await rollbackReservation().catch(() => undefined);
        return failed(
          'DELIVERY_NOT_ACCEPTED',
          error instanceof Error ? error.message : String(error),
          true,
        );
      }
      if (!dispatched.ok) {
        await rollbackReservation().catch(() => undefined);
        return failed(dispatched.errorCode, dispatched.message, true);
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
      };
    });
  };

  return { messageAgent, getThread, restore };
}

export type BotDirectMessageService = ReturnType<typeof createBotDirectMessageService>;
