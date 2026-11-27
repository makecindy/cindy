import type { BotGroupErrorCode, BotGroupFailure } from '../../shared/botGroupChat.js';

/** Keep diagnostic codes and HTTP status, never exception text, URLs, paths or response bodies. */
export function chatErrorDiagnostic(error: unknown): { code: string; status?: number } {
  const value = error as { code?: unknown; message?: unknown; status?: unknown; name?: unknown } | null;
  const candidate = typeof value?.code === 'string' ? value.code : value?.message;
  const code = typeof candidate === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(candidate)
    ? candidate : value?.name === 'TimeoutError' || value?.name === 'AbortError' ? 'REQUEST_TIMEOUT' : 'UNKNOWN';
  return { code, ...(typeof value?.status === 'number' && Number.isInteger(value.status) ? { status: value.status } : {}) };
}

/**
 * A room reached through a bot-group entry point that is not a group (a 1:1 companion chat,
 * a channel) answers exactly like a missing room. The internal code stays in diagnostics only.
 */
export function missingGroupCode(code: string): string {
  return code === 'NOT_A_GROUP' ? 'CONVERSATION_NOT_FOUND' : code;
}

/**
 * The shape of one message's blocks, for a log line: block type, plus a card's namespace and
 * revision. Text, captions, card data and media IDs/URLs never leave the process — a request the
 * server refused has to be diagnosable without turning the log into chat history.
 */
export function contentShapes(content: unknown): Array<{ type: string; namespace?: string; schemaRevision?: number }> | undefined {
  if (!Array.isArray(content)) return undefined;
  return content.map(block => {
    const value = block && typeof block === 'object' ? block as Record<string, unknown> : {};
    return { type: typeof value.type === 'string' ? value.type : 'unknown',
      ...(typeof value.namespace === 'string' ? { namespace: value.namespace } : {}),
      ...(typeof value.schemaRevision === 'number' && Number.isInteger(value.schemaRevision)
        ? { schemaRevision: value.schemaRevision } : {}) };
  });
}

/** Field-like keys whose value a validator can state safely; every other value is unreviewed input. */
const DETAIL_KEY_ALLOWLIST = new Set(['field', 'fields', 'path', 'paths', 'code', 'reason', 'type', 'namespace', 'index', 'expected', 'allowed']);
/** A key a log line may carry. */
const DETAIL_KEY = /^[A-Za-z_$][\w$]{0,63}$/;
/** A JSON path such as `content[1].fallback`; a bare word does not qualify. */
const DETAIL_PATH = /^[A-Za-z_$][\w$]*(?:\[\d+\])?(?:\.[A-Za-z_$][\w$]*(?:\[\d+\])?)+$/;
/** A stable error code such as `INVALID_INPUT`. */
const DETAIL_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;

/**
 * A server's `error.details`, narrowed to what a validator can safely state: field paths and error
 * codes under field-like keys, plus numbers and booleans. Everything else — including a whole
 * echoed message, a bare word or a token — becomes its length, because the server may put the
 * rejected user input in any key it likes. Depth and entry count are bounded.
 */
export function detailsDiagnostic(details: unknown): unknown {
  const narrow = (value: unknown, depth: number, key: string | null): unknown => {
    if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
    if (typeof value === 'string') {
      const named = key !== null && DETAIL_KEY_ALLOWLIST.has(key);
      return named && (DETAIL_PATH.test(value) || DETAIL_CODE.test(value)) ? value : `<text:${value.length}>`;
    }
    if (depth >= 3) return undefined;
    if (Array.isArray(value)) {
      const items = value.slice(0, 20).map(item => narrow(item, depth + 1, key)).filter(item => item !== undefined);
      return items.length ? items : undefined;
    }
    if (typeof value === 'object') {
      const entries = Object.entries(value as Record<string, unknown>).slice(0, 20).flatMap(([entryKey, item]) => {
        const narrowed = narrow(item, depth + 1, entryKey);
        return narrowed === undefined || !DETAIL_KEY.test(entryKey) ? [] : [[entryKey, narrowed] as const];
      });
      return entries.length ? Object.fromEntries(entries) : undefined;
    }
    return undefined;
  };
  return narrow(details, 0, null);
}

/** Request plumbing frames; the first other frames are the code that asked. */
const REQUEST_FRAMES = new Set(['request', 'api', 'workApi', 'foregroundApi', 'backgroundApi']);
const STACK_FRAME = /^\s*at (?:async )?(?:(?:new )?([\w$.<>]+) \()?(.+?):(\d+):\d+\)?$/;

/**
 * Who issued a refused Chat request, read from a call-site `Error` captured before the request
 * started (V8 formats the stack only when read, so capture is cheap). Callers are mostly
 * anonymous closures, so each frame is `name@file:line` with the file's base name only: a code
 * location of this build, never a directory, argument or ID. Node's own frames are skipped.
 * Two frames tell a shared reader from its caller.
 */
export function chatRequestCaller(stack: string | undefined): string | undefined {
  if (!stack) return undefined;
  const frames: string[] = [];
  for (const line of stack.split('\n').slice(1)) {
    const match = STACK_FRAME.exec(line);
    if (!match) continue;
    const name = match[1]?.split('.').pop() ?? '';
    const file = match[2]!.split(/[\\/]/).pop()!.split('?')[0]!;
    if (match[2]!.startsWith('node:') || REQUEST_FRAMES.has(name) || !/^[\w.$-]+$/.test(file)) continue;
    frames.push(`${/^[\w$<>]*$/.test(name) ? name : ''}@${file}:${match[3]}`);
    if (frames.length === 2) break;
  }
  return frames.length ? frames.join(' < ') : undefined;
}

const CHAT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROOM_ID_COLLECTIONS = new Set(['messages', 'media', 'plans', 'executions']);

/**
 * Inspect ID positions in Desktop's Chat routes, independently of the words kept in log templates.
 * For example, /executions/claim and /conversations/:roomId/import/plan-source have no execution
 * or import ID. Only fixed slot labels leave this helper, never the segment values.
 */
export function chatRouteNonIds(route: string): string[] {
  const [, root, rootId, collection, itemId, maskExecutionId] = route.split('?')[0]!.split('/');
  const nonIds: string[] = [];
  const inspect = (slot: string, value: string | undefined) => {
    if (value && !CHAT_ID.test(value)) nonIds.push(slot);
  };
  if (root === 'actors' || root === 'conversations') inspect(root, rootId);
  if (root === 'conversations') {
    if (collection && ROOM_ID_COLLECTIONS.has(collection)) inspect(collection, itemId);
    if (collection === 'mask' && itemId === 'executions') inspect('executions', maskExecutionId);
  }
  return nonIds;
}

/** Stable localized categories for desktop and remote controllers; raw errors stay private. */
export function chatGroupFailure(error: unknown): BotGroupFailure {
  const { code: raw, status } = chatErrorDiagnostic(error);
  const code = missingGroupCode(raw);
  let errorCode: BotGroupErrorCode;
  if (['PLAN_OPEN', 'PLAN_CLOSED', 'TURN_ALREADY_STARTED', 'MENTION_UNAVAILABLE', 'ALL_BOTS_MENTION_DISABLED', 'MEMBER_LIMIT', 'MEMBER_UNAVAILABLE', 'HOST_NOT_READY',
    'INVALID_ATTACHMENT', 'ATTACHMENT_UNAVAILABLE', 'ATTACHMENT_TOO_LARGE', 'MEDIA_UPLOAD_FAILED',
    'LIFECYCLE_UNAVAILABLE', 'LAST_OWNER', 'AUTH_REQUIRED', 'IMPORT_PENDING', 'REQUEST_TIMEOUT', 'REVISION_CONFLICT', 'QUOTE_UNAVAILABLE',
    'STOP_OWNERSHIP_UNKNOWN', 'NOTHING_TO_STOP'].includes(code)) errorCode = code as BotGroupErrorCode;
  else if (code === 'CONVERSATION_NOT_FOUND' || code === 'OWNER_CHANGED') errorCode = 'NOT_FOUND';
  else if (['ROLE_REQUIRED', 'ACTOR_NOT_OWNED', 'OWNER_REQUIRED'].includes(code) || status === 403) errorCode = 'PERMISSION_DENIED';
  else if (status === 401) errorCode = 'AUTH_REQUIRED';
  else if (code === 'CHAT_ENDPOINT_UNAVAILABLE' || code === 'INVALID_CHAT_ENDPOINT' || ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(code)) errorCode = 'CHAT_UNAVAILABLE';
  else if (code === 'ETIMEDOUT' || code === 'ECONNRESET') errorCode = 'REQUEST_TIMEOUT';
  else if (code.startsWith('FILE_PEER_') || code.startsWith('DEVICE_LINK_')) errorCode = 'ATTACHMENT_UNAVAILABLE';
  else if (['INVALID_MEDIA_URL', 'MEDIA_STORAGE_UNAVAILABLE', 'UPLOAD_QUOTA', 'UPLOAD_MISMATCH', 'MEDIA_NOT_FOUND', 'UPLOAD_EXPIRED'].includes(code)) errorCode = 'MEDIA_UPLOAD_FAILED';
  else if (code === 'ENOENT' || code === 'EACCES') errorCode = 'INVALID_ATTACHMENT';
  else if (code === 'CONVERSATION_DISSOLVED') errorCode = 'GROUP_DISSOLVED';
  else if (code === 'CONVERSATION_ARCHIVED') errorCode = 'GROUP_ARCHIVED';
  else if (code === 'INVALID_INPUT' || code === 'INVALID_PARAMS') errorCode = 'INVALID_PARAMS';
  else errorCode = 'SERVICE_ERROR';
  return { ok: false, errorCode, message: errorCode };
}


// A media batch reports its first failure unchanged, with its longest cooldown
// available to the migration scheduler for as long as that error is retained.
const uploadRetryDeadlines = new WeakMap<Error, number>();
export function rememberUploadRetryDeadline(error: Error, deadline: number): void {
  uploadRetryDeadlines.set(error, deadline);
}
export function chatRetryDeadline(error: unknown): number {
  if (!(error instanceof Error)) return 0;
  const deadline = ('serviceRetryAt' in error ? error.serviceRetryAt : undefined)
    ?? ('retryAt' in error ? error.retryAt : undefined);
  return Math.max(uploadRetryDeadlines.get(error) ?? 0,
    typeof deadline === 'number' && Number.isFinite(deadline) ? deadline : 0);
}
