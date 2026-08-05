/**
 * cindy_helper history 的 device-link adapter。
 *
 * Wire 查询始终限定到一个远程 session；本模块负责保留公开 history 契约的
 * 过滤/分页参数，并把隧道错误收敛成 MCP 可稳定分支的业务错误码。
 */
import {
  DeviceLinkError,
  DL_HISTORY_MESSAGES_CHANNEL,
  type InvokeResultPayload,
} from '@cindy/device-link';
import type {
  ControlResult,
  GetMessagesArgs,
  HistoryMessage,
  HistoryPage,
  HistoryReadErrorCode,
} from '@cindy/mcps';

import type { RemoteHistoryMessagesRequest } from '../localDb/ipc/history.js';

/** Dependencies are injected in tests; production uses the main-process readers. */
export interface ChatHistoryReaderDeps {
  readLocal(args: GetMessagesArgs): Promise<HistoryPage<HistoryMessage>>;
  invokeRemote(deviceId: string, channel: string, args: unknown[]): Promise<InvokeResultPayload>;
}

type ChatHistoryReadResult = ControlResult<
  { page: HistoryPage<HistoryMessage> },
  HistoryReadErrorCode
>;

interface QualifiedSessionId {
  deviceId: string;
  sessionId: string;
  qualifiedId: string;
}

/** Keep remote MCP history rows bounded before they cross the device-link relay. */
export const REMOTE_HISTORY_CONTENT_CHAR_LIMIT = 8_000;

function shouldPreserveStructuredHistoryContent(
  roles: GetMessagesArgs['roles'],
  rolesDefaulted = false,
): boolean {
  return !rolesDefaulted &&
    roles !== null &&
    roles.length > 0 &&
    roles.every((role) => role !== 'user' && role !== 'assistant');
}

function parseQualifiedSessionId(value: string): QualifiedSessionId | null {
  const split = value.indexOf('::');
  if (split <= 0 || split >= value.length - 2) return null;
  return {
    deviceId: value.slice(0, split),
    sessionId: value.slice(split + 2),
    qualifiedId: value,
  };
}

function errorResult(errorCode: HistoryReadErrorCode | 'HOST_NOT_READY' | 'INTERNAL', message: string): ChatHistoryReadResult {
  return { ok: false, errorCode, message };
}

function parseEncodedIpcError(message: string): { code: string; message: string } | null {
  const match = message.match(/(?:^|:\s*(?:Error:\s*)?)\[([A-Z0-9_]+)]\s*(.*)$/);
  return match ? { code: match[1], message: match[2] || message } : null;
}

/** Convert device-link and remote IPC failures into the public history error vocabulary. */
export function classifyRemoteHistoryError(
  code: string,
  message: string,
): { errorCode: HistoryReadErrorCode | 'HOST_NOT_READY' | 'INTERNAL'; message: string } {
  if (code === 'IPC_ERROR') {
    const ipc = parseEncodedIpcError(message);
    if (ipc) return classifyRemoteHistoryError(ipc.code, ipc.message);
    if (/localDb not ready/i.test(message)) return { errorCode: 'HOST_NOT_READY', message };
    return { errorCode: 'INTERNAL', message };
  }
  switch (code) {
    case 'NOT_FOUND':
      return { errorCode: 'NOT_FOUND', message };
    case 'INVALID_PARAMS':
      return { errorCode: 'INVALID_ARGS', message };
    case 'DEVICE_OFFLINE':
      return { errorCode: 'REMOTE_DEVICE_OFFLINE', message };
    case 'LINK_NOT_OPEN':
      return { errorCode: 'REMOTE_LINK_REQUIRED', message };
    case 'NOT_CONNECTED':
    case 'DEVICE_LINK_NOT_CONNECTED':
    case 'DEVICE_LINK_STANDBY':
      return { errorCode: 'DEVICE_LINK_NOT_READY', message };
    case 'REMOTE_DISABLED':
      return { errorCode: 'REMOTE_DISABLED', message };
    case 'ACCESS_REVOKED':
      return { errorCode: 'REMOTE_ACCESS_REVOKED', message };
    case 'CHANNEL_NOT_ALLOWED':
    case 'VERSION_MISMATCH':
      return { errorCode: 'REMOTE_UNSUPPORTED', message };
    case 'INVOKE_TIMEOUT':
      return { errorCode: 'REMOTE_TIMEOUT', message };
    case 'PAYLOAD_TOO_LARGE':
      return {
        errorCode: 'REMOTE_PAYLOAD_TOO_LARGE',
        message: `${message}; retry with a smaller limit and continue from nextCursor`,
      };
    default:
      return { errorCode: 'INTERNAL', message };
  }
}

function isHistoryPage(value: unknown): value is HistoryPage<HistoryMessage> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const page = value as Record<string, unknown>;
  return Array.isArray(page.items) && typeof page.hasMore === 'boolean' &&
    (page.nextCursor === null || (
      !!page.nextCursor && typeof page.nextCursor === 'object' &&
      typeof (page.nextCursor as Record<string, unknown>).createdAt === 'number' &&
      typeof (page.nextCursor as Record<string, unknown>).id === 'string'
    ));
}

/** Read local history or route one explicitly qualified session to its source device. */
export async function readChatHistoryMessages(
  args: GetMessagesArgs,
  deps: ChatHistoryReaderDeps,
): Promise<ChatHistoryReadResult> {
  const sessionIds = args.sessionIds ?? [];
  const valuesWithSeparator = sessionIds.filter((value) => value.includes('::'));
  if (valuesWithSeparator.length === 0) {
    try {
      return { ok: true, page: await deps.readLocal(args) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return errorResult(/localDb not ready/i.test(message) ? 'HOST_NOT_READY' : 'INTERNAL', message);
    }
  }

  const qualified = valuesWithSeparator.map(parseQualifiedSessionId);
  if (
    sessionIds.length !== 1 ||
    qualified.length !== 1 ||
    qualified[0] === null
  ) {
    return errorResult(
      'REMOTE_UNSUPPORTED_QUERY',
      'remote history requires exactly one deviceId::sessionId and cannot be mixed with local or other remote sessions',
    );
  }
  const target = qualified[0];
  const request: RemoteHistoryMessagesRequest = {
    sessionId: target.sessionId,
    workdir: args.workdir,
    fromMs: args.fromMs,
    toMs: args.toMs,
    agentKind: args.agentKind,
    roles: args.roles,
    includeRewound: args.includeRewound,
    limit: args.limit,
    cursor: args.cursor,
    order: args.order,
    contentCharLimit: shouldPreserveStructuredHistoryContent(args.roles, args.rolesDefaulted)
      ? null
      : REMOTE_HISTORY_CONTENT_CHAR_LIMIT,
  };

  let response: InvokeResultPayload;
  try {
    response = await deps.invokeRemote(target.deviceId, DL_HISTORY_MESSAGES_CHANNEL, [request]);
  } catch (err) {
    if (err instanceof DeviceLinkError) {
      const classified = classifyRemoteHistoryError(err.code, err.message);
      return errorResult(classified.errorCode, classified.message);
    }
    const message = err instanceof Error ? err.message : String(err);
    const encoded = parseEncodedIpcError(message);
    const classified = encoded
      ? classifyRemoteHistoryError(encoded.code, encoded.message)
      : classifyRemoteHistoryError('INTERNAL', message);
    return errorResult(classified.errorCode, classified.message);
  }

  if (!response.ok) {
    const classified = classifyRemoteHistoryError(response.error.code, response.error.message);
    return errorResult(classified.errorCode, classified.message);
  }
  if (!isHistoryPage(response.result)) {
    return errorResult('INTERNAL', 'remote history returned a malformed page');
  }

  return {
    ok: true,
    page: {
      ...response.result,
      items: response.result.items.map((item) => ({
        ...item,
        sessionId: target.qualifiedId,
      })),
    },
  };
}
