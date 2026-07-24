import {
  DL_HISTORY_MESSAGES_CHANNEL,
  DL_SESSION_REFERENCE_CAPABILITY_CHANNEL,
} from '@cindy/device-link';
import { i18n } from '@/i18n';
import type { RemoteInvoke } from '@/device-link/mobileMakerTransport';
import {
  createSessionLinkPattern,
  parseSessionDeepLinkUrl,
  trimSessionLinkMatch,
} from '@/session/sessionLinks';
import { isSyntheticTriggerText } from '@cindy/maker-shared/synthetic-trigger';

export const MAX_MOBILE_SESSION_REFERENCES = 8;
export const MAX_MOBILE_REFERENCE_MESSAGES = 20;
export const MAX_MOBILE_REFERENCE_TOKENS = 8_000;

const FINAL_REFERENCE_PAYLOAD_TOKENS = MAX_MOBILE_REFERENCE_TOKENS - 128;
const MAX_REFERENCE_ID_LENGTH = 256;
const MAX_REFERENCE_TITLE_LENGTH = 128;
const ALLOWED_ROLES = ['user', 'assistant'] as const;

export interface MobileSessionReference {
  sessionId: string;
  messageClientId?: string;
  deviceId?: string;
}

export interface MobileSessionReferenceMessage {
  role: 'user' | 'assistant';
  content: string;
  createdAt?: number;
}

export interface MobileSessionReferenceContext {
  sessionId: string;
  title?: string;
  source: 'device-link';
  deviceId: string;
  messageClientId?: string;
  messages: MobileSessionReferenceMessage[];
  range: 'recent' | 'around-anchor';
  messageCount: number;
  truncated: boolean;
}

/** 展示安全的落库摘要；不含任何被引用消息正文。 */
export interface MobilePersistedSessionReferenceMetadata {
  sessionId: string;
  messageClientId?: string;
  range: 'recent' | 'around-anchor';
  messageCount: number;
  truncated: boolean;
}

interface MobileQueuedReferenceCarrier {
  text: string;
  sessionRefs?: MobileSessionReference[];
  trustedSessionReferenceContexts?: MobileSessionReferenceContext[];
  sessionReferencesRequireTrustedSnapshot?: boolean;
}

export type MobileSessionReferenceErrorCode =
  | 'SESSION_REFERENCE_INVALID'
  | 'SESSION_REFERENCE_NOT_FOUND'
  | 'SESSION_REFERENCE_OFFLINE'
  | 'SESSION_REFERENCE_ACCESS_DENIED'
  | 'SESSION_REFERENCE_UNSUPPORTED';

/** Stable, UI-independent error surfaced by mobile session-reference resolution. */
export class MobileSessionReferenceError extends Error {
  constructor(
    readonly code: MobileSessionReferenceErrorCode,
    message: string,
  ) {
    super(`[${code}] ${message}`);
    this.name = 'MobileSessionReferenceError';
  }
}

/** Fail closed when persisted metadata is malformed or exceeds the shared limits. */
export function parseMobilePersistedSessionReferenceMetadata(
  value: unknown,
): MobilePersistedSessionReferenceMetadata[] {
  if (!Array.isArray(value) || value.length > MAX_MOBILE_SESSION_REFERENCES) return [];
  const result: MobilePersistedSessionReferenceMetadata[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
    const item = raw as Record<string, unknown>;
    if (
      typeof item.sessionId !== 'string' || !item.sessionId ||
      (item.messageClientId !== undefined &&
        (typeof item.messageClientId !== 'string' || !item.messageClientId)) ||
      (item.range !== 'recent' && item.range !== 'around-anchor') ||
      typeof item.messageCount !== 'number' ||
      !Number.isInteger(item.messageCount) ||
      item.messageCount < 0 ||
      item.messageCount > MAX_MOBILE_REFERENCE_MESSAGES ||
      typeof item.truncated !== 'boolean'
    ) return [];
    result.push({
      sessionId: item.sessionId,
      ...(typeof item.messageClientId === 'string' ? { messageClientId: item.messageClientId } : {}),
      range: item.range,
      messageCount: item.messageCount,
      truncated: item.truncated,
    });
  }
  return result;
}

export function mobileSessionReferenceMetadataKey(
  sessionId: string,
  messageClientId?: string | null,
): string {
  return `${sessionId}\u0000${messageClientId ?? ''}`;
}

/** 格式化展示安全的范围摘要（文案经 i18n 本地化）。 */
export function formatMobileSessionReferenceMetadata(
  metadata: MobilePersistedSessionReferenceMetadata,
): string {
  return [
    metadata.range === 'around-anchor'
      ? i18n.t('session.row.referenceAroundAnchor')
      : i18n.t('session.row.referenceRecent'),
    i18n.t('session.row.referenceCount', { num: metadata.messageCount }),
    ...(metadata.truncated ? [i18n.t('session.row.referenceTruncated')] : []),
  ].join(' · ');
}

/** Extract visible session links and bind each one to the mobile store's source device. */
export function extractMobileSessionReferences(
  text: string,
  deviceIdForSession: (sessionId: string) => string | undefined,
  previous?: readonly MobileSessionReference[],
): MobileSessionReference[] {
  const refs: MobileSessionReference[] = [];
  const seen = new Set<string>();
  const previousDeviceIds = new Map<string, string>();
  const previousDeviceIdsBySession = new Map<string, string>();
  for (const ref of previous ?? []) {
    if (!ref.deviceId) continue;
    previousDeviceIds.set(
      mobileSessionReferenceMetadataKey(ref.sessionId, ref.messageClientId),
      ref.deviceId,
    );
    if (!previousDeviceIdsBySession.has(ref.sessionId)) {
      previousDeviceIdsBySession.set(ref.sessionId, ref.deviceId);
    }
  }
  const pattern = createSessionLinkPattern();
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const target = parseSessionDeepLinkUrl(trimSessionLinkMatch(match[0]));
    if (!target) continue;
    const key = mobileSessionReferenceMetadataKey(target.sessionId, target.messageClientId);
    if (seen.has(key)) continue;
    seen.add(key);
    const deviceId = deviceIdForSession(target.sessionId)
      ?? previousDeviceIds.get(key)
      ?? previousDeviceIdsBySession.get(target.sessionId);
    refs.push({
      sessionId: target.sessionId,
      ...(target.messageClientId ? { messageClientId: target.messageClientId } : {}),
      ...(deviceId ? { deviceId } : {}),
    });
  }
  return refs;
}

/** Conservative token estimate shared semantically with the desktop resolver. */
export function estimateMobileReferenceTokens(text: string): number {
  let wide = 0;
  let ascii = 0;
  for (const character of text) {
    if (character.charCodeAt(0) <= 0x7f) ascii += 1;
    else wide += 1;
  }
  return wide + Math.ceil(ascii / 4);
}

/** Stable serialization used by the final exact-payload budget check. */
export function serializeMobileSessionReferencePayload(
  contexts: readonly MobileSessionReferenceContext[],
): string {
  return JSON.stringify({
    version: 1,
    kind: 'quoted_session_references',
    references: contexts,
  });
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (!part || typeof part !== 'object') return '';
        const record = part as Record<string, unknown>;
        return typeof record.text === 'string'
          ? record.text
          : typeof record.content === 'string'
            ? record.content
            : '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (content && typeof content === 'object') {
    const record = content as Record<string, unknown>;
    if (typeof record.text === 'string') return record.text;
    if (typeof record.content === 'string') return record.content;
  }
  return '';
}

function timestampToMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function toReferenceMessage(row: Record<string, unknown>): MobileSessionReferenceMessage | null {
  if (!ALLOWED_ROLES.includes(String(row.role) as typeof ALLOWED_ROLES[number])) return null;
  const content = contentToText(row.content);
  if (!content.trim()) return null;
  if (
    row.role === 'user' &&
    ((row.agentMeta && typeof row.agentMeta === 'object' && !Array.isArray(row.agentMeta) &&
      (row.agentMeta as Record<string, unknown>).autoResume === true) ||
      isSyntheticTriggerText(content))
  ) {
    return null;
  }
  const createdAt = timestampToMs(row.createdAt);
  return {
    role: String(row.role) as 'user' | 'assistant',
    content,
    ...(createdAt !== undefined ? { createdAt } : {}),
  };
}

function sliceTailToTokenBudget(text: string, budget: number): string {
  if (budget <= 0) return '';
  if (estimateMobileReferenceTokens(text) <= budget) return text;
  if (budget === 1) return '…';
  const payloadBudget = budget - 1;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (estimateMobileReferenceTokens(text.slice(text.length - middle)) <= payloadBudget) low = middle;
    else high = middle - 1;
  }
  return `…${text.slice(text.length - low)}`;
}

function fitMessagesToTokenBudget(
  raw: MobileSessionReferenceMessage[],
  tokenBudget: number,
  anchorIndex?: number,
): { messages: MobileSessionReferenceMessage[]; usedTokens: number; truncated: boolean } {
  if (anchorIndex !== undefined && raw[anchorIndex]) {
    const anchor = raw[anchorIndex];
    const anchorTokens = estimateMobileReferenceTokens(anchor.content);
    if (anchorTokens >= tokenBudget) {
      const content = sliceTailToTokenBudget(anchor.content, tokenBudget);
      return {
        messages: content ? [{ ...anchor, content }] : [],
        usedTokens: tokenBudget,
        truncated: true,
      };
    }

    let remaining = tokenBudget - anchorTokens;
    const kept = new Map<number, MobileSessionReferenceMessage>([[anchorIndex, anchor]]);
    let budgetExhausted = false;
    let partialTruncation = false;
    for (let distance = 1; kept.size < raw.length && !budgetExhausted; distance += 1) {
      if (remaining === 0) break;
      const candidates = [anchorIndex - distance, anchorIndex + distance];
      let found = false;
      for (const index of candidates) {
        const message = raw[index];
        if (!message) continue;
        found = true;
        const tokens = estimateMobileReferenceTokens(message.content);
        if (tokens <= remaining) {
          kept.set(index, message);
          remaining -= tokens;
        } else if (remaining > 0) {
          const content = sliceTailToTokenBudget(message.content, remaining);
          if (content) kept.set(index, { ...message, content });
          partialTruncation = true;
          remaining = 0;
          budgetExhausted = true;
          break;
        }
      }
      if (!found) break;
    }
    return {
      messages: [...kept.entries()].sort(([left], [right]) => left - right).map(([, message]) => message),
      usedTokens: tokenBudget - remaining,
      truncated: partialTruncation || kept.size < raw.length,
    };
  }

  const kept: MobileSessionReferenceMessage[] = [];
  let remaining = tokenBudget;
  let truncated = false;
  for (let index = raw.length - 1; index >= 0; index -= 1) {
    const message = raw[index];
    if (!message) continue;
    const tokens = estimateMobileReferenceTokens(message.content);
    if (tokens <= remaining) {
      kept.unshift(message);
      remaining -= tokens;
      continue;
    }
    if (remaining > 0) {
      const content = sliceTailToTokenBudget(message.content, remaining);
      if (content) kept.unshift({ ...message, content });
      remaining = 0;
    }
    truncated = true;
    break;
  }
  return { messages: kept, usedTokens: tokenBudget - remaining, truncated };
}

function fitSerializedPayloadBudget(
  input: readonly MobileSessionReferenceContext[],
): MobileSessionReferenceContext[] {
  const contexts = input.map((context) => ({
    ...context,
    messages: context.messages.map((message) => ({ ...message })),
  }));
  let tokens = estimateMobileReferenceTokens(serializeMobileSessionReferencePayload(contexts));
  while (tokens > FINAL_REFERENCE_PAYLOAD_TOKENS) {
    let targetContext: MobileSessionReferenceContext | undefined;
    let targetMessage: MobileSessionReferenceMessage | undefined;
    for (const context of contexts) {
      for (const message of context.messages) {
        if (!targetMessage || message.content.length > targetMessage.content.length) {
          targetContext = context;
          targetMessage = message;
        }
      }
    }
    if (targetMessage && targetMessage.content.length > 1) {
      const excess = tokens - FINAL_REFERENCE_PAYLOAD_TOKENS;
      const drop = Math.min(targetMessage.content.length - 1, Math.max(1, excess));
      targetMessage.content = `…${targetMessage.content.slice(drop + 1)}`;
      if (targetContext) targetContext.truncated = true;
    } else {
      const titled = contexts.find((context) => context.title);
      if (titled) delete titled.title;
      else {
        throw new MobileSessionReferenceError(
          'SESSION_REFERENCE_INVALID',
          'Session reference metadata exceeds the request budget',
        );
      }
    }
    tokens = estimateMobileReferenceTokens(serializeMobileSessionReferencePayload(contexts));
  }
  return contexts;
}

interface RemoteHistoryCursor {
  createdAt: number;
  id: string;
  rowid?: number;
}

interface RemoteHistoryPage {
  items: Record<string, unknown>[];
  hasMore: boolean;
  nextCursor: RemoteHistoryCursor | null;
}

function parseRemoteHistoryPage(ref: MobileSessionReference, value: unknown): RemoteHistoryPage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new MobileSessionReferenceError(
      'SESSION_REFERENCE_NOT_FOUND',
      'The source device returned invalid session history',
    );
  }
  const page = value as Record<string, unknown>;
  if (!Array.isArray(page.items) || typeof page.hasMore !== 'boolean') {
    throw new MobileSessionReferenceError(
      'SESSION_REFERENCE_NOT_FOUND',
      'The source device returned invalid session history',
    );
  }
  return {
    items: page.items.filter((row): row is Record<string, unknown> =>
      !!row && typeof row === 'object' && !Array.isArray(row) && row.sessionId === ref.sessionId),
    hasMore: page.hasMore,
    nextCursor: page.nextCursor === null || page.nextCursor === undefined
      ? null
      : (() => {
        if (
          typeof page.nextCursor !== 'object' ||
          Array.isArray(page.nextCursor)
        ) {
          throw new MobileSessionReferenceError(
            'SESSION_REFERENCE_NOT_FOUND',
            'The source device returned invalid session history',
          );
        }
        const cursor = page.nextCursor as Record<string, unknown>;
        if (
          typeof cursor.createdAt !== 'number' ||
          !Number.isFinite(cursor.createdAt) ||
          typeof cursor.id !== 'string' ||
          (cursor.rowid !== undefined &&
            (typeof cursor.rowid !== 'number' || !Number.isInteger(cursor.rowid) || cursor.rowid < 1))
        ) {
          throw new MobileSessionReferenceError(
            'SESSION_REFERENCE_NOT_FOUND',
            'The source device returned invalid session history',
          );
        }
        return {
          createdAt: cursor.createdAt,
          id: cursor.id,
          ...(cursor.rowid !== undefined ? { rowid: cursor.rowid } : {}),
        };
      })(),
  };
}

function remoteHistoryRequest(
  ref: MobileSessionReference,
  limit: number,
  order: 'asc' | 'desc',
  fromMs: number | null,
  cursor: RemoteHistoryCursor | null = null,
): Record<string, unknown> {
  return {
    sessionId: ref.sessionId,
    workdir: null,
    fromMs,
    toMs: null,
    agentKind: null,
    roles: [...ALLOWED_ROLES],
    includeRewound: false,
    limit,
    cursor,
    order,
    contentCharLimit: 8_000,
  };
}

function remoteRowsWereTrimmed(rows: readonly Record<string, unknown>[]): boolean {
  return rows.some((row) => {
    const agentMeta = row.agentMeta;
    return !!agentMeta && typeof agentMeta === 'object' && !Array.isArray(agentMeta) && (
      (agentMeta as Record<string, unknown>).remoteRowsTrimmed === true ||
      (agentMeta as Record<string, unknown>).remoteContentTruncated === true
    );
  });
}

async function readRemoteHistory(
  invoke: RemoteInvoke,
  ref: MobileSessionReference,
  limit: number,
  order: 'asc' | 'desc',
  fromMs: number | null,
  cursor: RemoteHistoryCursor | null = null,
): Promise<{ items: Record<string, unknown>[]; sourceTruncated: boolean }> {
  const items: Record<string, unknown>[] = [];
  let sourceTruncated = false;
  const seenCursors = new Set<string>();
  while (true) {
    const rawPage = await invokeSource<unknown>(invoke, ref, DL_HISTORY_MESSAGES_CHANNEL, [
      remoteHistoryRequest(ref, Math.max(1, limit), order, fromMs, cursor),
    ]);
    const page = parseRemoteHistoryPage(ref, rawPage);
    items.push(...page.items);
    sourceTruncated ||= remoteRowsWereTrimmed(page.items);
    const visibleCount = items.reduce((count, row) => count + (toReferenceMessage(row) ? 1 : 0), 0);
    if (!page.hasMore || visibleCount >= limit || !page.nextCursor) {
      sourceTruncated ||= page.hasMore;
      break;
    }
    const cursorKey = JSON.stringify(page.nextCursor);
    if (seenCursors.has(cursorKey)) {
      sourceTruncated = true;
      break;
    }
    seenCursors.add(cursorKey);
    cursor = page.nextCursor;
  }
  return {
    items,
    sourceTruncated: sourceTruncated || (limit === 0 && items.length > 0),
  };
}

function sourceFailure(ref: MobileSessionReference, error: unknown): MobileSessionReferenceError {
  if (error instanceof MobileSessionReferenceError) return error;
  const code = error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : 'UNKNOWN';
  const message = error instanceof Error ? error.message : String(error);
  if (code === 'ACCESS_REVOKED' || code === 'REMOTE_DISABLED') {
    return new MobileSessionReferenceError(
      'SESSION_REFERENCE_ACCESS_DENIED',
      `The source device denied access: ${message}`,
    );
  }
  if (code === 'CHANNEL_NOT_ALLOWED') {
    return new MobileSessionReferenceError(
      'SESSION_REFERENCE_UNSUPPORTED',
      `The source device version does not support session references: ${message}`,
    );
  }
  if (
    code === 'DEVICE_OFFLINE' ||
    code === 'LINK_NOT_OPEN' ||
    code === 'INVOKE_TIMEOUT' ||
    code === 'NOT_CONNECTED'
  ) {
    return new MobileSessionReferenceError(
      'SESSION_REFERENCE_OFFLINE',
      `The source device ${ref.deviceId ?? ''} is unavailable: ${message}`,
    );
  }
  if (code === 'PAYLOAD_TOO_LARGE') {
    return new MobileSessionReferenceError(
      'SESSION_REFERENCE_UNSUPPORTED',
      `Session ${ref.sessionId} returned too much history to reference safely: ${message}`,
    );
  }
  return new MobileSessionReferenceError(
    'SESSION_REFERENCE_NOT_FOUND',
    `Could not read session ${ref.sessionId}: ${message}`,
  );
}

async function invokeSource<T>(
  invoke: RemoteInvoke,
  ref: MobileSessionReference,
  channel: string,
  args: unknown[],
): Promise<T> {
  try {
    return await invoke<T>(ref.deviceId!, channel, args);
  } catch (error) {
    throw sourceFailure(ref, error);
  }
}

async function resolveRemoteReference(
  invoke: RemoteInvoke,
  ref: MobileSessionReference,
  messageLimit: number,
  tokenBudget: number,
): Promise<{ context: MobileSessionReferenceContext; usedTokens: number }> {
  if (!ref.deviceId) {
    throw new MobileSessionReferenceError(
      'SESSION_REFERENCE_NOT_FOUND',
      `Session ${ref.sessionId} has no known source device`,
    );
  }

  const remoteSession = await invokeSource<unknown>(
    invoke,
    ref,
    'local-db:sessions:get',
    [ref.sessionId],
  );
  if (!remoteSession || typeof remoteSession !== 'object' || Array.isArray(remoteSession)) {
    throw new MobileSessionReferenceError(
      'SESSION_REFERENCE_NOT_FOUND',
      `Session ${ref.sessionId} does not exist on the source device`,
    );
  }
  const session = remoteSession as Record<string, unknown>;
  const remoteClearedAt = timestampToMs(session.clearedAt);
  const clearedAt = remoteClearedAt === undefined ? null : remoteClearedAt + 1;

  let mapped: MobileSessionReferenceMessage[];
  let anchorIndex: number | undefined;
  let sourceTruncated = false;
  if (!ref.messageClientId) {
    const page = await readRemoteHistory(invoke, ref, messageLimit, 'desc', clearedAt);
    const visibleRows = page.items
      .map(toReferenceMessage)
      .filter((row): row is MobileSessionReferenceMessage => row !== null)
      .reverse();
    mapped = visibleRows.slice(-messageLimit);
    sourceTruncated = page.sourceTruncated || visibleRows.length > messageLimit;
  } else {
    const rawAnchorRows = await invokeSource<unknown>(
      invoke,
      ref,
      'local-db:messages:around-client-id',
      [ref.sessionId, ref.messageClientId, { radius: 0, contentCharLimit: 8_000 }],
    );
    const anchorRows = Array.isArray(rawAnchorRows)
      ? rawAnchorRows.filter((row): row is Record<string, unknown> =>
          !!row && typeof row === 'object' && !Array.isArray(row) && row.sessionId === ref.sessionId)
      : [];
    const anchorRow = anchorRows.find((row) => row.clientId === ref.messageClientId);
    const anchorMessage = anchorRow ? toReferenceMessage(anchorRow) : null;
    const anchorId = anchorRow?.id;
    const anchorRowid = typeof anchorRow?.rowid === 'number' && Number.isInteger(anchorRow.rowid) && anchorRow.rowid > 0
      ? anchorRow.rowid
      : undefined;
    const anchorCreatedAt = timestampToMs(anchorRow?.createdAt);
    if (!anchorMessage || typeof anchorId !== 'string' || anchorCreatedAt === undefined) {
      throw new MobileSessionReferenceError(
        'SESSION_REFERENCE_NOT_FOUND',
        `Message anchor ${ref.messageClientId} was not found`,
      );
    }

    const beforeLimit = Math.floor((messageLimit - 1) / 2);
    const afterLimit = messageLimit - beforeLimit - 1;
    const readSide = async (
      limit: number,
      order: 'asc' | 'desc',
    ): Promise<Pick<RemoteHistoryPage, 'items' | 'hasMore'>> => {
      const page = await readRemoteHistory(invoke, ref, limit, order, clearedAt, {
        createdAt: anchorCreatedAt,
        id: anchorId,
        ...(anchorRowid !== undefined ? { rowid: anchorRowid } : {}),
      });
      return limit === 0
        ? { items: [], hasMore: page.sourceTruncated }
        : { items: page.items, hasMore: page.sourceTruncated };
    };
    const [before, after] = await Promise.all([
      readSide(beforeLimit, 'desc'),
      readSide(afterLimit, 'asc'),
    ]);
    const beforeMessages = before.items
      .map(toReferenceMessage)
      .filter((row): row is MobileSessionReferenceMessage => row !== null)
      .reverse();
    const afterMessages = after.items
      .map(toReferenceMessage)
      .filter((row): row is MobileSessionReferenceMessage => row !== null);
    const fittedBeforeMessages = beforeLimit > 0 ? beforeMessages.slice(-beforeLimit) : [];
    const fittedAfterMessages = afterMessages.slice(0, afterLimit);
    mapped = [...fittedBeforeMessages, anchorMessage, ...fittedAfterMessages];
    anchorIndex = fittedBeforeMessages.length;
    sourceTruncated = before.hasMore || after.hasMore ||
      beforeMessages.length > beforeLimit || afterMessages.length > afterLimit ||
      remoteRowsWereTrimmed(anchorRows);
  }

  if (mapped.length === 0) {
    throw new MobileSessionReferenceError(
      'SESSION_REFERENCE_NOT_FOUND',
      `Session ${ref.sessionId} has no visible messages to reference`,
    );
  }
  const fitted = fitMessagesToTokenBudget(mapped, tokenBudget, anchorIndex);
  return {
    context: {
      sessionId: ref.sessionId,
      ...(typeof session.title === 'string' && session.title.trim()
        ? { title: session.title.trim().slice(0, MAX_REFERENCE_TITLE_LENGTH) }
        : {}),
      source: 'device-link',
      deviceId: ref.deviceId,
      ...(ref.messageClientId ? { messageClientId: ref.messageClientId } : {}),
      messages: fitted.messages,
      range: ref.messageClientId ? 'around-anchor' : 'recent',
      messageCount: fitted.messages.length,
      truncated: sourceTruncated || fitted.truncated,
    },
    usedTokens: fitted.usedTokens,
  };
}

/** Resolve all mobile references from their authoritative desktop devices. */
export async function resolveMobileSessionReferences(
  refs: readonly MobileSessionReference[] | undefined,
  invoke: RemoteInvoke,
): Promise<MobileSessionReferenceContext[]> {
  if (!refs || refs.length === 0) return [];
  if (refs.length > MAX_MOBILE_SESSION_REFERENCES) {
    throw new MobileSessionReferenceError(
      'SESSION_REFERENCE_INVALID',
      `A message can reference at most ${MAX_MOBILE_SESSION_REFERENCES} sessions`,
    );
  }

  const contexts: MobileSessionReferenceContext[] = [];
  let remainingMessages = MAX_MOBILE_REFERENCE_MESSAGES;
  let remainingTokens = MAX_MOBILE_REFERENCE_TOKENS;
  for (let index = 0; index < refs.length; index += 1) {
    const ref = refs[index];
    if (!ref?.sessionId.trim()) {
      throw new MobileSessionReferenceError(
        'SESSION_REFERENCE_INVALID',
        'Session reference is missing sessionId',
      );
    }
    if (
      ref.sessionId.length > MAX_REFERENCE_ID_LENGTH ||
      (ref.deviceId?.length ?? 0) > MAX_REFERENCE_ID_LENGTH ||
      (ref.messageClientId?.length ?? 0) > MAX_REFERENCE_ID_LENGTH
    ) {
      throw new MobileSessionReferenceError(
        'SESSION_REFERENCE_INVALID',
        'Session reference identifier is too long',
      );
    }

    const referencesLeft = refs.length - index;
    const messageLimit = Math.max(1, Math.floor(remainingMessages / referencesLeft));
    const tokenBudget = Math.max(1, Math.floor(remainingTokens / referencesLeft));
    const resolved = await resolveRemoteReference(invoke, ref, messageLimit, tokenBudget);
    contexts.push(resolved.context);
    remainingMessages -= resolved.context.messageCount;
    remainingTokens -= resolved.usedTokens;
  }
  return fitSerializedPayloadBudget(contexts);
}

/**
 * Rebuild the reference fields for a queued payload from its current text.
 * This deliberately removes stale snapshots first, so editing a link away cannot retain
 * previously trusted history and steering a display-safe projection always re-reads source data.
 */
export async function prepareMobileQueuedSessionReferences<T extends MobileQueuedReferenceCarrier>(
  item: T,
  invoke: RemoteInvoke,
  deviceIdForSession: (sessionId: string) => string | undefined,
  targetDeviceId: string,
): Promise<T> {
  const refs = extractMobileSessionReferences(item.text, deviceIdForSession, item.sessionRefs);
  const prepared = { ...item };
  delete prepared.sessionRefs;
  delete prepared.trustedSessionReferenceContexts;
  delete prepared.sessionReferencesRequireTrustedSnapshot;
  if (refs.length === 0) return prepared;
  try {
    const capability = await invoke<unknown>(
      targetDeviceId,
      DL_SESSION_REFERENCE_CAPABILITY_CHANNEL,
      [],
    );
    const capabilityVersion =
      capability && typeof capability === 'object' && !Array.isArray(capability)
        ? (capability as { version?: unknown }).version
        : undefined;
    if (
      !capability ||
      typeof capability !== 'object' ||
      Array.isArray(capability) ||
      (capability as { supported?: unknown }).supported !== true ||
      typeof capabilityVersion !== 'number' ||
      !Number.isFinite(capabilityVersion) ||
      capabilityVersion < 1
    ) {
      throw new MobileSessionReferenceError(
        'SESSION_REFERENCE_UNSUPPORTED',
        'The target device version does not support session references',
      );
    }
  } catch (error) {
    if (error instanceof MobileSessionReferenceError) throw error;
    const code = error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : 'UNKNOWN';
    if (code === 'CHANNEL_NOT_ALLOWED' || code === 'DEVICE_LINK_CHANNEL_NOT_ALLOWED') {
      throw new MobileSessionReferenceError(
        'SESSION_REFERENCE_UNSUPPORTED',
        'The target device version does not support session references',
      );
    }
    if (code === 'ACCESS_REVOKED' || code === 'REMOTE_DISABLED') {
      throw new MobileSessionReferenceError(
        'SESSION_REFERENCE_ACCESS_DENIED',
        'The target device denied access to session references',
      );
    }
    throw new MobileSessionReferenceError(
      'SESSION_REFERENCE_OFFLINE',
      `The target device is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  prepared.sessionRefs = refs;
  prepared.trustedSessionReferenceContexts = await resolveMobileSessionReferences(refs, invoke);
  return prepared;
}

/** Reuse the target's trusted snapshot only when the source cannot currently be read. */
export function canFallbackToStoredMobileSessionReferenceSnapshot(error: unknown): boolean {
  return error instanceof MobileSessionReferenceError && (
    error.code === 'SESSION_REFERENCE_OFFLINE' ||
    error.code === 'SESSION_REFERENCE_ACCESS_DENIED'
  );
}

/** Prepare a queued steer, retaining the projection only when the target can restore its snapshot. */
export async function prepareMobileQueuedSessionReferencesForSteer<T extends MobileQueuedReferenceCarrier>(
  item: T,
  invoke: RemoteInvoke,
  deviceIdForSession: (sessionId: string) => string | undefined,
  targetDeviceId: string,
): Promise<T> {
  try {
    return await prepareMobileQueuedSessionReferences(
      item,
      invoke,
      deviceIdForSession,
      targetDeviceId,
    );
  } catch (error) {
    if (!canFallbackToStoredMobileSessionReferenceSnapshot(error)) throw error;
    return item;
  }
}
