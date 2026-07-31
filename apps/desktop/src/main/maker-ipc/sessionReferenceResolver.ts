/**
 * 会话引用解析器。
 *
 * renderer 只提交定位信息；main 从本地 SQLite 或已授权的在线 device-link
 * 设备读取权威历史。整次用户请求共享 20 条 / 约 8k token 的硬预算。
 */
import { and, asc, desc, eq, gt, inArray, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import { DL_HISTORY_MESSAGES_CHANNEL } from '@cindy/device-link';
import { getSelfDeviceId, remoteInvoke as invokeRemote } from '../device-link/index.js';
import { getDbClient } from '../localDb/client/current.js';
import { messages, sessions } from '../localDb/schema.js';
import { readLatestSessionTerminal } from '../localDb/sessionTerminal.js';
import { messageToCamel } from '../localDb/mapper.js';
import { isSyntheticTriggerText } from '../../shared/interruptedTurn.js';
import {
  serializeSessionReferencePayload,
  type AgentInputSessionRef,
  type AgentInputSessionReferenceContext,
  type AgentInputSessionReferenceMessage,
  type AgentInputSessionReferenceTerminal,
} from '../../shared/agentInputQueue.js';

export const MAX_SESSION_REFERENCES = 8;
export const MAX_REFERENCE_MESSAGES = 20;
export const MAX_REFERENCE_TOKENS = 8_000;
const FINAL_REFERENCE_PAYLOAD_TOKENS = MAX_REFERENCE_TOKENS - 128;
const MAX_REFERENCE_ID_LENGTH = 256;
const MAX_REFERENCE_TITLE_LENGTH = 128;

const ALLOWED_ROLES = ['user', 'assistant'] as const;
const messageRowid = sql<number>`"messages"."rowid"`;

export class SessionReferenceError extends Error {
  constructor(
    readonly code:
      | 'SESSION_REFERENCE_INVALID'
      | 'SESSION_REFERENCE_NOT_FOUND'
      | 'SESSION_REFERENCE_OFFLINE'
      | 'SESSION_REFERENCE_ACCESS_DENIED'
      | 'SESSION_REFERENCE_UNSUPPORTED',
    message: string,
  ) {
    super(`[${code}] ${message}`);
    this.name = 'SessionReferenceError';
  }
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

/** 保守 token 估算：CJK/非 ASCII 按 1 token，ASCII 按约 4 字符 1 token。 */
export function estimateReferenceTokens(text: string): number {
  let wide = 0;
  let ascii = 0;
  for (const ch of text) {
    if (ch.charCodeAt(0) <= 0x7f) ascii += 1;
    else wide += 1;
  }
  return wide + Math.ceil(ascii / 4);
}

function sliceTailToTokenBudget(text: string, budget: number): string {
  if (budget <= 0) return '';
  if (estimateReferenceTokens(text) <= budget) return text;
  if (budget === 1) return '…';
  const payloadBudget = budget - 1;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (estimateReferenceTokens(text.slice(text.length - mid)) <= payloadBudget) low = mid;
    else high = mid - 1;
  }
  return `…${text.slice(text.length - low)}`;
}

function fitMessagesToTokenBudget(
  raw: AgentInputSessionReferenceMessage[],
  tokenBudget: number,
  anchorIndex?: number,
): { messages: AgentInputSessionReferenceMessage[]; usedTokens: number; truncated: boolean } {
  if (anchorIndex !== undefined && raw[anchorIndex]) {
    const anchor = raw[anchorIndex];
    const anchorTokens = estimateReferenceTokens(anchor.content);
    if (anchorTokens >= tokenBudget) {
      const content = sliceTailToTokenBudget(anchor.content, tokenBudget);
      return {
        messages: content ? [{ ...anchor, content }] : [],
        usedTokens: tokenBudget,
        truncated: true,
      };
    }

    let remaining = tokenBudget - anchorTokens;
    const kept = new Map<number, AgentInputSessionReferenceMessage>([[anchorIndex, anchor]]);
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
        const tokens = estimateReferenceTokens(message.content);
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
      messages: [...kept.entries()].sort(([a], [b]) => a - b).map(([, message]) => message),
      usedTokens: tokenBudget - remaining,
      truncated: partialTruncation || kept.size < raw.length,
    };
  }

  const kept: AgentInputSessionReferenceMessage[] = [];
  let remaining = tokenBudget;
  let truncated = false;
  for (let index = raw.length - 1; index >= 0; index--) {
    const message = raw[index];
    if (!message) continue;
    const tokens = estimateReferenceTokens(message.content);
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

/** Enforce the budget on the exact JSON that will be injected, including escaping and metadata. */
function fitSerializedPayloadBudget(
  input: readonly AgentInputSessionReferenceContext[],
): AgentInputSessionReferenceContext[] {
  const contexts = input.map((context) => ({
    ...context,
    messages: context.messages.map((message) => ({ ...message })),
  }));
  let tokens = estimateReferenceTokens(serializeSessionReferencePayload(contexts));
  while (tokens > FINAL_REFERENCE_PAYLOAD_TOKENS) {
    let targetContext: AgentInputSessionReferenceContext | undefined;
    let targetMessage: AgentInputSessionReferenceMessage | undefined;
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
        throw new SessionReferenceError(
          'SESSION_REFERENCE_INVALID',
          '会话引用元数据超过整次请求预算',
        );
      }
    }
    tokens = estimateReferenceTokens(serializeSessionReferencePayload(contexts));
  }
  return contexts;
}

function toReferenceMessage(row: Record<string, unknown>): AgentInputSessionReferenceMessage | null {
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
    ...(Number.isFinite(createdAt) ? { createdAt } : {}),
  };
}

async function readLocalRows(
  ref: AgentInputSessionRef,
  limit: number,
  clearedAt: number | null,
): Promise<{ rows: Record<string, unknown>[]; sourceTruncated: boolean }> {
  const db = getDbClient().drizzle;
  type LocalMessageRow = {
    message: Parameters<typeof messageToCamel>[0];
    rowid: number;
  };
  const visible: SQL<unknown>[] = [
    eq(messages.sessionId, ref.sessionId),
    isNull(messages.rewindAt),
    inArray(messages.role, [...ALLOWED_ROLES]),
  ];
  if (clearedAt !== null) visible.push(gt(messages.createdAt, clearedAt));

  const fetchWindow = async (
    where: Array<SQL<unknown> | undefined>,
    orderBy: SQL<unknown>[],
    desired: number,
  ): Promise<{ rows: LocalMessageRow[]; sourceTruncated: boolean }> => {
    const rows: LocalMessageRow[] = [];
    const batchSize = Math.max(1, desired + 1);
    let offset = 0;
    let sourceTruncated = false;
    while (true) {
      const page = await db
        .select({ message: messages, rowid: messageRowid })
        .from(messages)
        .where(and(...where.filter((part): part is SQL<unknown> => part !== undefined)))
        .orderBy(...orderBy)
        .limit(batchSize)
        .offset(offset);
      rows.push(...(page as LocalMessageRow[]));
      const visibleCount = rows.reduce((count, row) => (
        count + (toReferenceMessage(messageToCamel(row.message) as unknown as Record<string, unknown>) ? 1 : 0)
      ), 0);
      if (visibleCount >= desired || page.length < batchSize) {
        sourceTruncated = page.length === batchSize;
        break;
      }
      offset += page.length;
    }
    return { rows, sourceTruncated };
  };

  if (!ref.messageClientId) {
    const loaded = await fetchWindow(
      visible,
      [desc(messages.createdAt), desc(messageRowid)],
      limit,
    );
    const mapped = loaded.rows
      .map(({ message }) => messageToCamel(message) as unknown as Record<string, unknown>)
      .filter((row) => toReferenceMessage(row) !== null);
    return {
      rows: mapped.slice(0, limit).reverse(),
      sourceTruncated: loaded.sourceTruncated || mapped.length > limit,
    };
  }

  const [anchor] = await db
    .select({ message: messages, rowid: messageRowid })
    .from(messages)
    .where(and(...visible, eq(messages.clientId, ref.messageClientId)))
    .limit(1);
  if (!anchor) {
    throw new SessionReferenceError('SESSION_REFERENCE_NOT_FOUND', `找不到消息锚点 ${ref.messageClientId}`);
  }
  const beforeLimit = Math.floor((limit - 1) / 2);
  const afterLimit = limit - beforeLimit - 1;
  const before = await fetchWindow(
    [
      ...visible,
      or(
        lt(messages.createdAt, anchor.message.createdAt),
        and(eq(messages.createdAt, anchor.message.createdAt), lt(messageRowid, anchor.rowid)),
      ),
    ],
    [desc(messages.createdAt), desc(messageRowid)],
    beforeLimit,
  );
  const after = await fetchWindow(
    [
      ...visible,
      or(
        gt(messages.createdAt, anchor.message.createdAt),
        and(eq(messages.createdAt, anchor.message.createdAt), gt(messageRowid, anchor.rowid)),
      ),
    ],
    [asc(messages.createdAt), asc(messageRowid)],
    afterLimit,
  );
  const beforeRows = before.rows
    .map(({ message }) => messageToCamel(message) as unknown as Record<string, unknown>)
    .filter((row) => toReferenceMessage(row) !== null);
  const afterRows = after.rows
    .map(({ message }) => messageToCamel(message) as unknown as Record<string, unknown>)
    .filter((row) => toReferenceMessage(row) !== null);
  return {
    rows: [
      ...beforeRows.slice(0, beforeLimit).reverse(),
      messageToCamel(anchor.message) as unknown as Record<string, unknown>,
      ...afterRows.slice(0, afterLimit),
    ],
    sourceTruncated: before.sourceTruncated || after.sourceTruncated ||
      beforeRows.length > beforeLimit || afterRows.length > afterLimit,
  };
}

async function resolveLocal(
  ref: AgentInputSessionRef,
  messageLimit: number,
  tokenBudget: number,
): Promise<{ context: AgentInputSessionReferenceContext; usedTokens: number }> {
  const db = getDbClient().drizzle;
  const [session] = await db
    .select({
      id: sessions.id,
      title: sessions.title,
      clearedAt: sessions.clearedAt,
    })
    .from(sessions)
    .where(eq(sessions.id, ref.sessionId))
    .limit(1);
  if (!session) throw new SessionReferenceError('SESSION_REFERENCE_NOT_FOUND', `找不到本机会话 ${ref.sessionId}`);
  const loaded = await readLocalRows(ref, messageLimit, session.clearedAt ?? null);
  // A recent local snapshot may legitimately end at a partial assistant
  // message when the turn failed.  Preserve only a safe status marker; never
  // inject the persisted error body into the quoted context.
  let terminal: AgentInputSessionReferenceTerminal | undefined;
  if (!ref.messageClientId) {
    try {
      terminal = await readLatestSessionTerminal(ref.sessionId, session.clearedAt ?? null);
    } catch {
      // Terminal status is diagnostic metadata; a transient read failure must
      // not make an otherwise valid session reference fail closed.
      terminal = undefined;
    }
  }
  const mappedWithAnchor = loaded.rows
    .map((row) => ({ message: toReferenceMessage(row), isAnchor: row.clientId === ref.messageClientId }))
    .filter((entry): entry is { message: AgentInputSessionReferenceMessage; isAnchor: boolean } => entry.message !== null);
  const mapped = mappedWithAnchor.map((entry) => entry.message);
  if (mapped.length === 0) {
    throw new SessionReferenceError('SESSION_REFERENCE_NOT_FOUND', `会话 ${ref.sessionId} 没有可引用的可见消息`);
  }
  const anchorIndex = ref.messageClientId
    ? mappedWithAnchor.findIndex((entry) => entry.isAnchor)
    : undefined;
  if (ref.messageClientId && anchorIndex === -1) {
    throw new SessionReferenceError('SESSION_REFERENCE_NOT_FOUND', `找不到消息锚点 ${ref.messageClientId}`);
  }
  const fitted = fitMessagesToTokenBudget(mapped, tokenBudget, anchorIndex);
  return {
    context: {
      sessionId: ref.sessionId,
      ...(session.title?.trim() ? { title: session.title.trim().slice(0, MAX_REFERENCE_TITLE_LENGTH) } : {}),
      source: 'local',
      ...(ref.messageClientId ? { messageClientId: ref.messageClientId } : {}),
      messages: fitted.messages,
      range: ref.messageClientId ? 'around-anchor' : 'recent',
      messageCount: fitted.messages.length,
      truncated: loaded.sourceTruncated || fitted.truncated,
      ...(terminal ? { terminal } : {}),
    },
    usedTokens: fitted.usedTokens,
  };
}

function remoteFailure(ref: AgentInputSessionRef, response: Awaited<ReturnType<typeof invokeRemote>>): never {
  const code = response.ok === false ? response.error.code : 'UNKNOWN';
  const message = response.ok === false ? response.error.message : '未知错误';
  if (code === 'ACCESS_REVOKED' || code === 'REMOTE_DISABLED') {
    throw new SessionReferenceError('SESSION_REFERENCE_ACCESS_DENIED', `来源设备拒绝访问：${message}`);
  }
  if (code === 'CHANNEL_NOT_ALLOWED') {
    throw new SessionReferenceError('SESSION_REFERENCE_UNSUPPORTED', `来源设备版本不支持会话引用：${message}`);
  }
  if (
    code === 'DEVICE_OFFLINE' ||
    code === 'LINK_NOT_OPEN' ||
    code === 'INVOKE_TIMEOUT' ||
    code === 'NOT_CONNECTED' ||
    code === 'BACKPRESSURE'
  ) {
    throw new SessionReferenceError('SESSION_REFERENCE_OFFLINE', `来源设备 ${ref.deviceId} 当前不可用：${message}`);
  }
  if (code === 'PAYLOAD_TOO_LARGE') {
    throw new SessionReferenceError(
      'SESSION_REFERENCE_UNSUPPORTED',
      `会话 ${ref.sessionId} 的远程历史响应过大，无法安全引用：${message}`,
    );
  }
  throw new SessionReferenceError('SESSION_REFERENCE_NOT_FOUND', `无法读取会话 ${ref.sessionId}：${message}`);
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
  terminal: AgentInputSessionReferenceTerminal | undefined;
}

/** Rebuild the optional terminal marker from validated fields only (trust boundary). */
function parseRemoteTerminal(value: unknown): AgentInputSessionReferenceTerminal | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.status !== 'error') return undefined;
  return {
    status: 'error',
    ...(typeof record.createdAt === 'number' && Number.isFinite(record.createdAt)
      ? { createdAt: record.createdAt }
      : {}),
  };
}

function parseRemoteHistoryPage(ref: AgentInputSessionRef, value: unknown): RemoteHistoryPage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SessionReferenceError('SESSION_REFERENCE_NOT_FOUND', `来源设备返回了无效的会话历史`);
  }
  const page = value as Record<string, unknown>;
  if (!Array.isArray(page.items) || typeof page.hasMore !== 'boolean') {
    throw new SessionReferenceError('SESSION_REFERENCE_NOT_FOUND', `来源设备返回了无效的会话历史`);
  }
  return {
    items: page.items.filter((row): row is Record<string, unknown> =>
      !!row && typeof row === 'object' && !Array.isArray(row) && row.sessionId === ref.sessionId),
    hasMore: page.hasMore,
    terminal: parseRemoteTerminal(page.terminal),
    nextCursor: page.nextCursor === null || page.nextCursor === undefined
      ? null
      : (() => {
        if (
          typeof page.nextCursor !== 'object' ||
          Array.isArray(page.nextCursor)
        ) {
          throw new SessionReferenceError(
            'SESSION_REFERENCE_NOT_FOUND',
            `鏉ユ簮璁惧杩斿洖浜嗘棤鏁堢殑浼氳瘇鍘嗗彶`,
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
          throw new SessionReferenceError(
            'SESSION_REFERENCE_NOT_FOUND',
            `鏉ユ簮璁惧杩斿洖浜嗘棤鏁堢殑浼氳瘇鍘嗗彶`,
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
  ref: AgentInputSessionRef,
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
  ref: AgentInputSessionRef,
  limit: number,
  order: 'asc' | 'desc',
  fromMs: number | null,
  cursor: RemoteHistoryCursor | null = null,
): Promise<{
  items: Record<string, unknown>[];
  sourceTruncated: boolean;
  terminal: AgentInputSessionReferenceTerminal | undefined;
}> {
  const items: Record<string, unknown>[] = [];
  let sourceTruncated = false;
  // 被控端把 terminal 与页面在同一 handler 调用内算好,只有第一页的标记
  // 与本次快照同源;后续翻页捎带的标记忽略。
  let terminal: AgentInputSessionReferenceTerminal | undefined;
  let firstPage = true;
  const seenCursors = new Set<string>();
  while (true) {
    const response = await invokeRemote(ref.deviceId!, DL_HISTORY_MESSAGES_CHANNEL, [
      remoteHistoryRequest(ref, Math.max(1, limit), order, fromMs, cursor),
    ]);
    if (response.ok !== true) remoteFailure(ref, response);
    const page = parseRemoteHistoryPage(ref, response.result);
    if (firstPage) {
      terminal = page.terminal;
      firstPage = false;
    }
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
    terminal,
  };
}

async function resolveRemote(
  ref: AgentInputSessionRef,
  messageLimit: number,
  tokenBudget: number,
): Promise<{ context: AgentInputSessionReferenceContext; usedTokens: number }> {
  if (!ref.deviceId) {
    throw new SessionReferenceError('SESSION_REFERENCE_NOT_FOUND', `会话 ${ref.sessionId} 没有在线来源设备`);
  }
  let sessionResponse: Awaited<ReturnType<typeof invokeRemote>>;
  try {
    sessionResponse = await invokeRemote(ref.deviceId, 'local-db:sessions:get', [ref.sessionId]);
  } catch (error) {
    throw new SessionReferenceError(
      'SESSION_REFERENCE_OFFLINE',
      `来源设备 ${ref.deviceId} 离线或连接不可用：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (sessionResponse.ok !== true) remoteFailure(ref, sessionResponse);
  if (!sessionResponse.result || typeof sessionResponse.result !== 'object') {
    throw new SessionReferenceError('SESSION_REFERENCE_NOT_FOUND', `来源设备上不存在会话 ${ref.sessionId}`);
  }
  const remoteSession = sessionResponse.result as Record<string, unknown>;
  const remoteClearedAt = timestampToMs(remoteSession.clearedAt);
  const clearedAt = remoteClearedAt === undefined ? null : remoteClearedAt + 1;
  let mapped: AgentInputSessionReferenceMessage[];
  let anchorIndex: number | undefined;
  let sourceTruncated = false;
  // 终态标记由被控端与首个历史页在同一 handler 调用内算好(见
  // readRemoteHistory),与消息快照天然同源;锚点路径不带终态(与本地一致)。
  let terminal: AgentInputSessionReferenceTerminal | undefined;
  try {
    if (!ref.messageClientId) {
      const page = await readRemoteHistory(ref, messageLimit, 'desc', clearedAt);
      terminal = page.terminal;
      const visibleRows = page.items
        .map(toReferenceMessage)
        .filter((row): row is AgentInputSessionReferenceMessage => row !== null)
        .reverse();
      mapped = visibleRows.slice(-messageLimit);
      sourceTruncated = page.sourceTruncated || visibleRows.length > messageLimit;
    } else {
      const anchorResponse = await invokeRemote(ref.deviceId, 'local-db:messages:around-client-id', [
        ref.sessionId,
        ref.messageClientId,
        { radius: 0, contentCharLimit: 8_000 },
      ]);
      if (anchorResponse.ok !== true) remoteFailure(ref, anchorResponse);
      const anchorRows = Array.isArray(anchorResponse.result)
        ? anchorResponse.result.filter((row): row is Record<string, unknown> =>
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
        throw new SessionReferenceError('SESSION_REFERENCE_NOT_FOUND', `找不到消息锚点 ${ref.messageClientId}`);
      }
      const beforeLimit = Math.floor((messageLimit - 1) / 2);
      const afterLimit = messageLimit - beforeLimit - 1;
      const readSide = async (
        limit: number,
        order: 'asc' | 'desc',
      ): Promise<Pick<RemoteHistoryPage, 'items' | 'hasMore'>> => {
        const page = await readRemoteHistory(ref, limit, order, clearedAt, {
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
        .filter((row): row is AgentInputSessionReferenceMessage => row !== null)
        .reverse();
      const afterMessages = after.items
        .map(toReferenceMessage)
        .filter((row): row is AgentInputSessionReferenceMessage => row !== null);
      const fittedBeforeMessages = beforeLimit > 0 ? beforeMessages.slice(-beforeLimit) : [];
      const fittedAfterMessages = afterMessages.slice(0, afterLimit);
      mapped = [...fittedBeforeMessages, anchorMessage, ...fittedAfterMessages];
      anchorIndex = fittedBeforeMessages.length;
      sourceTruncated = before.hasMore || after.hasMore ||
        beforeMessages.length > beforeLimit || afterMessages.length > afterLimit ||
        remoteRowsWereTrimmed(anchorRows);
    }
  } catch (error) {
    if (error instanceof SessionReferenceError) throw error;
    throw new SessionReferenceError(
      'SESSION_REFERENCE_OFFLINE',
      `来源设备 ${ref.deviceId} 离线或连接不可用：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (mapped.length === 0) {
    throw new SessionReferenceError('SESSION_REFERENCE_NOT_FOUND', `会话 ${ref.sessionId} 没有可引用的可见消息`);
  }
  const fitted = fitMessagesToTokenBudget(mapped, tokenBudget, anchorIndex);
  return {
    context: {
      sessionId: ref.sessionId,
      ...(typeof remoteSession.title === 'string' && remoteSession.title.trim()
        ? { title: remoteSession.title.trim().slice(0, MAX_REFERENCE_TITLE_LENGTH) }
        : {}),
      source: 'device-link',
      deviceId: ref.deviceId,
      ...(ref.messageClientId ? { messageClientId: ref.messageClientId } : {}),
      messages: fitted.messages,
      range: ref.messageClientId ? 'around-anchor' : 'recent',
      messageCount: fitted.messages.length,
      truncated: sourceTruncated || fitted.truncated,
      ...(terminal ? { terminal } : {}),
    },
    usedTokens: fitted.usedTokens,
  };
}

/** 解析全部引用；超出数量或共享预算时明确报错/标记，不静默丢引用。 */
export async function resolveSessionReferences(
  refs: readonly AgentInputSessionRef[] | undefined,
): Promise<AgentInputSessionReferenceContext[]> {
  if (!refs || refs.length === 0) return [];
  if (refs.length > MAX_SESSION_REFERENCES) {
    throw new SessionReferenceError(
      'SESSION_REFERENCE_INVALID',
      `单条消息最多引用 ${MAX_SESSION_REFERENCES} 个会话，当前为 ${refs.length} 个`,
    );
  }
  const contexts: AgentInputSessionReferenceContext[] = [];
  let remainingMessages = MAX_REFERENCE_MESSAGES;
  let remainingTokens = MAX_REFERENCE_TOKENS;
  for (let index = 0; index < refs.length; index++) {
    const ref = refs[index];
    if (!ref?.sessionId.trim()) {
      throw new SessionReferenceError('SESSION_REFERENCE_INVALID', '会话引用缺少 sessionId');
    }
    if (
      ref.sessionId.length > MAX_REFERENCE_ID_LENGTH ||
      (ref.deviceId?.length ?? 0) > MAX_REFERENCE_ID_LENGTH ||
      (ref.messageClientId?.length ?? 0) > MAX_REFERENCE_ID_LENGTH
    ) {
      throw new SessionReferenceError('SESSION_REFERENCE_INVALID', '会话引用标识过长');
    }
    const refsLeft = refs.length - index;
    const messageLimit = Math.max(1, Math.floor(remainingMessages / refsLeft));
    const tokenBudget = Math.max(1, Math.floor(remainingTokens / refsLeft));
    // 深链是可复制的字符串:控制端生成的 `?device=` 链接可能被带回归属设备
    // 本机粘贴发送,此时 deviceId 指向本机自己——按本地会话解析,不能对自己
    // 发起 device-link 隧道(本机不是自己的控制端,必然失败)。
    const remoteDeviceId = ref.deviceId && ref.deviceId !== getSelfDeviceId()
      ? ref.deviceId
      : undefined;
    const resolved = remoteDeviceId
      ? await resolveRemote({ ...ref, deviceId: remoteDeviceId }, messageLimit, tokenBudget)
      : await resolveLocal(ref, messageLimit, tokenBudget);
    contexts.push(resolved.context);
    remainingMessages -= resolved.context.messageCount;
    remainingTokens -= resolved.usedTokens;
  }
  return fitSerializedPayloadBudget(contexts);
}
