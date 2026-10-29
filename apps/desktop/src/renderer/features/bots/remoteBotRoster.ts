import { readWorkingPhase, type WorkingPhase } from '../../../shared/workingStatus';
export interface RemoteBot {
  templateId?: string;
  id: string;
  deviceId: string;
  deviceName: string;
  name: string;
  avatar: string;
  avatarColor: string;
  description: string;
  preview: string;
  activityAt: number;
  sessionId: string | null;
  online: boolean;
  connectionKnown?: boolean;
  generation?: { phase: WorkingPhase; startedAt: number | null };
  lastReplyAt?: number;
  readAt?: number;
  followingSessionIds?: string[];
  delegatedSessionIds?: string[];
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function text(value: unknown): string {
  return typeof value === 'string'
    ? value
    : typeof record(value).fallback === 'string'
      ? (record(value).fallback as string)
      : '';
}

/** Unknown relations and malformed targets never establish task ownership. */
export function remoteBotTaskIds(links: unknown, rel: string): string[] {
  if (!Array.isArray(links)) return [];
  return [...new Set(links.flatMap((value: unknown) => {
    const link = record(value);
    const target = record(link.target);
    return link.rel === rel && target.kind === 'session'
      && typeof target.sessionId === 'string' && target.sessionId.length > 0
      ? [target.sessionId] : [];
  }))];
}

/** Existing task-card API: only the requesting teammate owns a created child. */
export function remoteBotCreatedTaskIds(value: unknown, botId: string): string[] | null {
  const response = record(value);
  if (response.ok !== true || !Array.isArray(response.delegations)) return null;
  return [...new Set(response.delegations.flatMap((value: unknown) => {
    const row = record(value);
    return row.requestingBotId === botId && typeof row.childSessionId === 'string' && row.childSessionId
      ? [row.childSessionId] : [];
  }))];
}

/** Only consume the advertised Bot collection, never infer identity from task titles. */
export function parseRemoteBots(value: unknown, deviceId: string, deviceName: string): RemoteBot[] {
  const response = record(value);
  if (response.collectionId !== 'teammates' || !Array.isArray(response.items)) {
    throw new Error('Invalid teammate collection');
  }
  return response.items.map((value: unknown) => {
    const item = record(value);
    const ref = record(item.ref);
    const display = record(item.display);
    const avatar = record(display.avatar);
    if (
      ref.collectionId !== 'teammates' ||
      ref.kind !== 'bot' ||
      typeof ref.id !== 'string' ||
      !ref.id ||
      !text(display.title)
    ) {
      throw new Error('Invalid teammate identity');
    }
    const link = Array.isArray(item.links)
      ? item.links.find((value: unknown) => {
          const link = record(value);
          return link.rel === 'conversation' && record(link.target).kind === 'session';
        })
      : undefined;
    const sessionId = record(record(link).target).sessionId;
    return {
      id: ref.id,
      deviceId,
      deviceName,
      name: text(display.title),
      avatar: text(avatar.value),
      avatarColor: text(avatar.color),
      description: text(display.subtitle),
      preview: text(display.preview),
      activityAt: typeof display.timestamp === 'number' ? display.timestamp : 0,
      sessionId: typeof sessionId === 'string' && sessionId ? sessionId : null,
      lastReplyAt: typeof display.lastReplyAt === 'number' && Number.isFinite(display.lastReplyAt) && display.lastReplyAt >= 0 ? display.lastReplyAt : undefined,
      followingSessionIds: remoteBotTaskIds(item.links, 'following'),
      online: true,
      connectionKnown: true,
      ...(typeof record(display.generation).phase === 'string' ? { generation: {
        phase: readWorkingPhase(record(display.generation).phase) ?? 'processing',
        startedAt: typeof record(display.generation).startedAt === 'number' && Number.isFinite(record(display.generation).startedAt) ? record(display.generation).startedAt as number : null,
      } } : {}),
    };
  });
}

export function remoteBotKey(bot: Pick<RemoteBot, 'deviceId' | 'id'>): string {
  return `${bot.deviceId}:${bot.id}`;
}

export function isRemoteBotUnread(bot: RemoteBot): boolean {
  return bot.lastReplyAt !== undefined && bot.readAt !== undefined && bot.lastReplyAt > bot.readAt;
}

/** Computer + Bot ID; names and same-ID Bots on other computers never alias. */
export function taskBotKey(bot: { id: string; deviceId?: string }): string {
  return JSON.stringify([bot.deviceId ?? null, bot.id]);
}
