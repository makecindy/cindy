import type { BotGroupErrorCode, BotGroupFailure } from '../../shared/botGroupChat.js';

/** Keep diagnostic codes and HTTP status, never exception text, URLs, paths or response bodies. */
export function chatErrorDiagnostic(error: unknown): { code: string; status?: number } {
  const value = error as { code?: unknown; message?: unknown; status?: unknown; name?: unknown } | null;
  const candidate = typeof value?.code === 'string' ? value.code : value?.message;
  const code = typeof candidate === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(candidate)
    ? candidate : value?.name === 'TimeoutError' || value?.name === 'AbortError' ? 'REQUEST_TIMEOUT' : 'UNKNOWN';
  return { code, ...(typeof value?.status === 'number' && Number.isInteger(value.status) ? { status: value.status } : {}) };
}

/** Stable localized categories for desktop and remote controllers; raw errors stay private. */
export function chatGroupFailure(error: unknown): BotGroupFailure {
  const { code, status } = chatErrorDiagnostic(error);
  let errorCode: BotGroupErrorCode;
  if (['PLAN_OPEN', 'PLAN_CLOSED', 'MENTION_UNAVAILABLE', 'MEMBER_LIMIT', 'MEMBER_UNAVAILABLE', 'HOST_NOT_READY',
    'INVALID_ATTACHMENT', 'ATTACHMENT_UNAVAILABLE', 'ATTACHMENT_TOO_LARGE', 'MEDIA_UPLOAD_FAILED',
    'AUTH_REQUIRED', 'IMPORT_PENDING', 'REQUEST_TIMEOUT'].includes(code)) errorCode = code as BotGroupErrorCode;
  else if (code === 'CONVERSATION_NOT_FOUND' || code === 'OWNER_CHANGED') errorCode = 'NOT_FOUND';
  else if (['ROLE_REQUIRED', 'ACTOR_NOT_OWNED', 'OWNER_REQUIRED'].includes(code) || status === 403) errorCode = 'PERMISSION_DENIED';
  else if (status === 401) errorCode = 'AUTH_REQUIRED';
  else if (code === 'CHAT_ENDPOINT_UNAVAILABLE' || code === 'INVALID_CHAT_ENDPOINT' || ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(code)) errorCode = 'CHAT_UNAVAILABLE';
  else if (code === 'ETIMEDOUT' || code === 'ECONNRESET') errorCode = 'REQUEST_TIMEOUT';
  else if (code.startsWith('FILE_PEER_') || code.startsWith('DEVICE_LINK_')) errorCode = 'ATTACHMENT_UNAVAILABLE';
  else if (['INVALID_MEDIA_URL', 'MEDIA_STORAGE_UNAVAILABLE', 'UPLOAD_QUOTA', 'UPLOAD_MISMATCH', 'MEDIA_NOT_FOUND', 'UPLOAD_EXPIRED'].includes(code)) errorCode = 'MEDIA_UPLOAD_FAILED';
  else if (code === 'ENOENT' || code === 'EACCES') errorCode = 'INVALID_ATTACHMENT';
  else if (code === 'CONVERSATION_ARCHIVED') errorCode = 'GROUP_ARCHIVED';
  else if (code === 'INVALID_INPUT' || code === 'INVALID_PARAMS') errorCode = 'INVALID_PARAMS';
  else errorCode = 'SERVICE_ERROR';
  return { ok: false, errorCode, message: errorCode };
}
