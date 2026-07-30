/**
 * Device-link 专用的单会话历史读取入口。
 *
 * 该入口只暴露 cindy_helper 已有 history reader 的只读能力，不开放跨会话扫描。
 * 参数在被控端再次校验，避免 allowlist 只能校验 channel、不能校验 payload 的缺口。
 */
import { ipcMain } from 'electron';
import { eq } from 'drizzle-orm';
import { DL_HISTORY_MESSAGES_CHANNEL, DL_HISTORY_SESSION_TERMINAL_CHANNEL } from '@cindy/device-link';

import {
  getMessagesForHistory,
  type GetMessagesParams,
  type HistoryAgentKind,
  type HistoryCursor,
  type HistoryOrder,
  type HistoryRole,
} from '../chatHistoryReader';
import { getDbClient } from '../client/current';
import { sessions } from '../schema';
import { readLatestSessionTerminal, type SessionTerminalHint } from '../sessionTerminal';
import { requireObject, requireString, throwIpcError } from '../../utils/ipcValidate';

const VALID_AGENT_KINDS: readonly HistoryAgentKind[] = ['cc', 'codex'];
const VALID_ORDERS: readonly HistoryOrder[] = ['asc', 'desc'];
const VALID_ROLES: readonly HistoryRole[] = [
  'user',
  'assistant',
  'tool_use',
  'tool_result',
  'ask_user',
  'plan_review',
  'thinking',
];

/** Wire payload accepted by the remote history channel. */
export interface RemoteHistoryMessagesRequest {
  sessionId: string;
  workdir: string | null;
  fromMs: number | null;
  toMs: number | null;
  agentKind: HistoryAgentKind | null;
  roles: HistoryRole[] | null;
  includeRewound: boolean;
  limit: number;
  cursor: HistoryCursor | null;
  order: HistoryOrder;
  /** Session-reference callers may cap each row before it crosses the relay. Raw MCP reads use null. */
  contentCharLimit: number | null;
}

/** Injectable dependencies keep handler behavior testable without a real Electron DB. */
export interface RemoteHistoryIpcDeps {
  sessionExists(sessionId: string): Promise<boolean>;
  getMessages(params: GetMessagesParams): ReturnType<typeof getMessagesForHistory>;
}

/** Dependencies for the session-terminal probe handler. */
export interface RemoteSessionTerminalIpcDeps {
  sessionExists(sessionId: string): Promise<boolean>;
  readTerminal(sessionId: string, clearedAt: number | null): Promise<SessionTerminalHint | undefined>;
}

function nullableFiniteNumber(value: unknown, name: string): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throwIpcError('INVALID_PARAMS', `${name} must be a finite number or null`);
  }
  return value;
}

function nullableString(value: unknown, name: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') {
    throwIpcError('INVALID_PARAMS', `${name} must be a string or null`);
  }
  return value;
}

function nullableEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  name: string,
): T | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throwIpcError('INVALID_PARAMS', `${name} must be ${allowed.join(' | ')} or null`);
  }
  return value as T;
}

/** Validate an untrusted device-link payload into the history reader contract. */
export function parseRemoteHistoryMessagesRequest(value: unknown): RemoteHistoryMessagesRequest {
  const input = requireObject(value, 'request');
  const sessionId = requireString(input.sessionId, 'sessionId');
  const includeRewound = input.includeRewound;
  if (typeof includeRewound !== 'boolean') {
    throwIpcError('INVALID_PARAMS', 'includeRewound must be a boolean');
  }
  const limit = input.limit;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throwIpcError('INVALID_PARAMS', 'limit must be an integer between 1 and 1000');
  }

  let roles: HistoryRole[] | null = null;
  if (input.roles !== null) {
    if (!Array.isArray(input.roles) || input.roles.some((role) =>
      typeof role !== 'string' || !VALID_ROLES.includes(role as HistoryRole))) {
      throwIpcError('INVALID_PARAMS', 'roles contains an unsupported role');
    }
    roles = input.roles as HistoryRole[];
  }

  let cursor: HistoryCursor | null = null;
  if (input.cursor !== null) {
    const rawCursor = requireObject(input.cursor, 'cursor');
    const createdAt = nullableFiniteNumber(rawCursor.createdAt, 'cursor.createdAt');
    if (createdAt === null) {
      throwIpcError('INVALID_PARAMS', 'cursor.createdAt must be a finite number');
    }
    const rowid = rawCursor.rowid;
    if (rowid !== undefined && (typeof rowid !== 'number' || !Number.isInteger(rowid) || rowid < 1)) {
      throwIpcError('INVALID_PARAMS', 'cursor.rowid must be a positive integer when provided');
    }
    cursor = {
      createdAt,
      id: requireString(rawCursor.id, 'cursor.id'),
      ...(rowid !== undefined ? { rowid } : {}),
    };
  }

  const order = input.order;
  if (typeof order !== 'string' || !VALID_ORDERS.includes(order as HistoryOrder)) {
    throwIpcError('INVALID_PARAMS', 'order must be asc or desc');
  }
  let contentCharLimit: number | null = null;
  if (input.contentCharLimit !== undefined && input.contentCharLimit !== null) {
    if (
      typeof input.contentCharLimit !== 'number' ||
      !Number.isInteger(input.contentCharLimit) ||
      input.contentCharLimit < 1 ||
      input.contentCharLimit > 8_000
    ) {
      throwIpcError('INVALID_PARAMS', 'contentCharLimit must be an integer between 1 and 8000 or null');
    }
    contentCharLimit = input.contentCharLimit;
  }

  return {
    sessionId,
    workdir: nullableString(input.workdir, 'workdir'),
    fromMs: nullableFiniteNumber(input.fromMs, 'fromMs'),
    toMs: nullableFiniteNumber(input.toMs, 'toMs'),
    agentKind: nullableEnum(input.agentKind, VALID_AGENT_KINDS, 'agentKind'),
    roles,
    includeRewound,
    limit,
    cursor,
    order: order as HistoryOrder,
    contentCharLimit,
  };
}

function contentPreview(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && !Array.isArray(part)) {
          const block = part as Record<string, unknown>;
          return block.type === 'text' && typeof block.text === 'string' ? block.text : '';
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.text === 'string') return record.text;
    if (typeof record.content === 'string') return record.content;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value ?? '');
  }
}

function contentHasOmittedData(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((part) => {
      if (typeof part === 'string') return false;
      if (part && typeof part === 'object' && !Array.isArray(part)) {
        const block = part as Record<string, unknown>;
        return !(block.type === 'text' && typeof block.text === 'string');
      }
      return true;
    });
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.text === 'string' || typeof record.content === 'string') {
      const hasNonEmptyArray = (key: string) =>
        Array.isArray(record[key]) && record[key].length > 0;
      return (
        (Array.isArray(record.images) && record.images.length > 0) ||
        (Array.isArray(record.files) && record.files.length > 0) ||
        hasNonEmptyArray('sessionReferences') ||
        record.quotesEncoded === true ||
        hasNonEmptyArray('pastedTextRanges') ||
        hasNonEmptyArray('slashCommandRanges')
      );
    }
    return true;
  }
  return false;
}

/** Cap per-row reference text before it crosses device-link and mark lossy rows. */
export function capReferenceMessageRows<T extends { content: unknown; agentMeta?: unknown }>(
  items: readonly T[],
  limit: number | null,
  preserveStructuredRoles = false,
): T[] {
  if (limit === null) return [...items];
  return items.map((item) => {
    if (
      preserveStructuredRoles &&
      'role' in item &&
      typeof item.role === 'string' &&
      item.role !== 'user' &&
      item.role !== 'assistant'
    ) {
      return item;
    }
    const text = contentPreview(item.content);
    const textWasTruncated = text.length > limit;
    const omittedData = contentHasOmittedData(item.content);
    if (!textWasTruncated && !omittedData) {
      return typeof item.content === 'string'
        ? item
        : { ...item, content: text } as T;
    }
    const priorMeta = item.agentMeta && typeof item.agentMeta === 'object' && !Array.isArray(item.agentMeta)
      ? item.agentMeta as Record<string, unknown>
      : {};
    const content = !textWasTruncated
      ? text
      : limit === 1
        ? '…'
        : `…${text.slice(-(limit - 1))}`;
    return {
      ...item,
      content,
      agentMeta: { ...priorMeta, remoteContentTruncated: true },
    } as T;
  });
}

function capReferenceHistoryPage(
  page: Awaited<ReturnType<typeof getMessagesForHistory>>,
  limit: number | null,
  preserveStructuredRoles = false,
): Awaited<ReturnType<typeof getMessagesForHistory>> {
  if (limit === null) return page;
  return {
    ...page,
    items: capReferenceMessageRows(page.items, limit, preserveStructuredRoles),
  };
}

const defaultSessionExists = async (sessionId: string): Promise<boolean> => {
  const rows = await getDbClient().drizzle
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  return rows.length > 0;
};

const defaultDeps: RemoteHistoryIpcDeps = {
  sessionExists: defaultSessionExists,
  getMessages: getMessagesForHistory,
};

const defaultTerminalDeps: RemoteSessionTerminalIpcDeps = {
  sessionExists: defaultSessionExists,
  readTerminal: readLatestSessionTerminal,
};

/** Register the allowlisted, read-only remote history handler. */
export function registerRemoteHistoryIpc(deps: RemoteHistoryIpcDeps = defaultDeps): void {
  ipcMain.handle(DL_HISTORY_MESSAGES_CHANNEL, async (_event, value: unknown) => {
    const request = parseRemoteHistoryMessagesRequest(value);
    if (!(await deps.sessionExists(request.sessionId))) {
      throwIpcError('NOT_FOUND', 'Session does not exist');
    }
    const page = await deps.getMessages({
      sessionIds: [request.sessionId],
      workdir: request.workdir,
      fromMs: request.fromMs,
      toMs: request.toMs,
      agentKind: request.agentKind,
      roles: request.roles,
      includeRewound: request.includeRewound,
      limit: request.limit,
      cursor: request.cursor,
      order: request.order,
    });
    const preserveStructuredRoles =
      request.roles === null ||
      request.roles.some((role) => role !== 'user' && role !== 'assistant');
    return capReferenceHistoryPage(page, request.contentCharLimit, preserveStructuredRoles);
  });
}

/**
 * 会话尾部终态探针:被控端在本机库上判定,只回安全标记或 null。
 * 错误正文不出被控端,控制端拿到标记即可解释引用尾部为何不完整。
 */
export function registerRemoteSessionTerminalIpc(deps: RemoteSessionTerminalIpcDeps = defaultTerminalDeps): void {
  ipcMain.handle(DL_HISTORY_SESSION_TERMINAL_CHANNEL, async (_event, value: unknown) => {
    const input = requireObject(value, 'request');
    const sessionId = requireString(input.sessionId, 'sessionId');
    const fromMs = nullableFiniteNumber(input.fromMs ?? null, 'fromMs');
    if (!(await deps.sessionExists(sessionId))) {
      throwIpcError('NOT_FOUND', 'Session does not exist');
    }
    const terminal = await deps.readTerminal(sessionId, fromMs);
    return terminal ?? null;
  });
}
