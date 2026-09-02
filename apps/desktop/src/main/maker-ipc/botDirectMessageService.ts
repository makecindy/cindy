import { randomUUID } from 'node:crypto';

import { and, desc, eq, isNull } from 'drizzle-orm';

import { getDbClient } from '../localDb/client/current.js';
import { botProfiles, botSessionLinks, sessions } from '../localDb/schema.js';

const MAX_MESSAGE_CHARS = 16_000;
const MAX_SENDER_NAME_CHARS = 48;
const MAX_SENDER_ID_CHARS = 80;

function trustedHeaderLabel(value: string, maxChars: number): string {
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
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
  }) => Promise<DispatchResult>;
  /** Reuses delegation's canonical-session ensure path for newly-created/recovering Bots. */
  ensureCanonicalSession?: (botId: string) => Promise<
    | { ok: true; sessionId: string }
    | { ok: false; errorCode: string; message: string }
  >;
  createId?: () => string;
}

async function activeRoster(): Promise<BotRosterEntry[]> {
  const db = getDbClient().drizzle;
  return db
    .select({ id: botProfiles.id, name: botProfiles.displayName })
    .from(botProfiles)
    .innerJoin(
      botSessionLinks,
      and(
        eq(botSessionLinks.botId, botProfiles.id),
        eq(botSessionLinks.role, 'canonical'),
        isNull(botSessionLinks.archivedAt),
      ),
    )
    .innerJoin(sessions, eq(sessions.id, botSessionLinks.sessionId))
    .where(
      and(
        eq(botProfiles.status, 'active'),
        eq(sessions.source, 'bot'),
        eq(sessions.status, 'active'),
      ),
    )
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
 * Hermes-style `message_agent`: a lightweight Bot-to-Bot DM over Cindy's real
 * canonical Session. It intentionally does not create delegation state,
 * workers, transcripts or a second runtime.
 */
export function createBotDirectMessageService(deps: BotDirectMessageServiceDeps) {
  const createId = deps.createId ?? randomUUID;

  const messageAgent = async (input: {
    callerSessionId: string;
    targetBotId: string;
    message: string;
  }): Promise<BotDirectMessageResult> => {
    const message = input.message.trim();
    if (!message || message.length > MAX_MESSAGE_CHARS) {
      return failed('INVALID_ARGS', `message 必须为 1-${MAX_MESSAGE_CHARS} 个字符`);
    }

    const caller = await loadCaller(input.callerSessionId);
    if (!caller || caller.sessionSource !== 'bot') {
      return failed('NOT_A_BOT_SESSION', '当前任务不属于 Cindy Bot');
    }
    if (caller.sessionStatus !== 'active' || caller.botStatus !== 'active') {
      return failed('BOT_SESSION_INACTIVE', '当前 Bot 主任务已暂停、归档或删除');
    }
    if (caller.role !== 'canonical' || caller.linkArchivedAt !== null) {
      return failed('NOT_CANONICAL_BOT_SESSION', 'message_agent 只能从 Bot 主任务发送');
    }
    if (caller.botId === input.targetBotId) {
      return failed('SELF_MESSAGE', '不能给当前 Bot 自己发送 message_agent 消息');
    }

    const targetProfile = await loadTargetProfile(input.targetBotId);
    if (!targetProfile) {
      return failed('TARGET_BOT_NOT_FOUND', '找不到目标 Bot', true);
    }
    if (targetProfile.status !== 'active') {
      return failed('TARGET_BOT_INACTIVE', '目标 Bot 已暂停或归档', true);
    }

    // Resolve on every use, not only when missing: daily rollover is a host
    // lifecycle concern and must happen before the message is persisted or
    // queued against a physical Session id.
    let targetSessionId: string | null = null;
    if (deps.ensureCanonicalSession) {
      const ensured = await deps.ensureCanonicalSession(input.targetBotId);
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

    const senderName = trustedHeaderLabel(caller.botName, MAX_SENDER_NAME_CHARS);
    const senderId = trustedHeaderLabel(caller.botId, MAX_SENDER_ID_CHARS);
    const envelope = [
      `[Direct message from Cindy Bot "${senderName}" (${senderId})]`,
      message,
    ].join('\n\n');
    const dispatched = await deps.dispatch({
      targetSessionId,
      message: envelope,
      persistedContent: envelope,
      clientId: `bot-dm:${caller.botId}:${createId()}`,
    });
    if (!dispatched.ok) {
      return failed(dispatched.errorCode, dispatched.message, true);
    }
    return {
      ok: true,
      targetBotId: input.targetBotId,
      targetBotName: targetProfile.name,
      targetSessionId: dispatched.targetSessionId,
      wakeKind: dispatched.wakeKind,
    };
  };

  return { messageAgent };
}

export type BotDirectMessageService = ReturnType<typeof createBotDirectMessageService>;
