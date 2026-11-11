/** The Chat Server request function owned by chatServer.ts (account/endpoint bound). */
export type CompanionApi = <T>(route: string, method?: string, data?: unknown, actorId?: string) => Promise<T>;

export interface CompanionLog {
  warn: (message: string, meta?: Record<string, unknown>) => void;
  info?: (message: string, meta?: Record<string, unknown>) => void;
}

/**
 * Details of a definitive Chat Server rejection (`{ error: { code, details } }`),
 * or null when the error is anything else. chatServer.ts keeps the code as the
 * message and exposes `status` / `details` on its response error.
 */
export function chatRejection(error: unknown, status: number, code: string): Record<string, unknown> | null {
  if (!(error instanceof Error) || error.message !== code) return null;
  if ((error as { status?: unknown }).status !== status) return null;
  const details = (error as { details?: unknown }).details;
  return details && typeof details === 'object' && !Array.isArray(details) ? details as Record<string, unknown> : {};
}

export function errorCode(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 80) : 'UNKNOWN';
}

const TRANSPORT_CODES = /^(REQUEST_TIMEOUT|CHAT_ENDPOINT_UNAVAILABLE|ECONN\w*|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|EPIPE)$/;
/** The server could not be reached (or is temporarily failing): retry later. */
export function isUnreachable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const status = (error as { status?: unknown }).status;
  if (typeof status === 'number') return status >= 500 || status === 408 || status === 429;
  const code = (error as { code?: unknown }).code;
  return TRANSPORT_CODES.test(error.message) || (typeof code === 'string' && TRANSPORT_CODES.test(code));
}

const TRANSIENT_ATTACHMENT = /^(MEDIA_DOWNLOAD_FAILED|OWNER_CHANGED|fetch failed|net::ERR_\w+)$/;
/** The object store's own answer to a signed address (every try signs a fresh one). */
const SIGNED_URL_FAILURE = /^MEDIA_(UPLOAD|DOWNLOAD)_FAILED$/;
/**
 * A file that may still come on a later try (network, a failing server or 5xx/408/429, an expired
 * signed address, a download that ended without a status, the account changing): the step fails
 * and is retried. Anything else (too large, gone, refused by the chat server) never will, and only
 * then does the file stay a name.
 */
export function isTransientAttachmentFailure(error: unknown): boolean {
  if (isUnreachable(error)) return true;
  if (!(error instanceof Error)) return false;
  const status = (error as { status?: unknown }).status;
  // An expired signature (401/403 from the object store) is signed again on the retry; the chat
  // server refusing the file, or the object being gone (404), never changes.
  if (typeof status === 'number') return SIGNED_URL_FAILURE.test(error.message) && (status === 401 || status === 403);
  return TRANSIENT_ATTACHMENT.test(error.message) || error.name === 'TimeoutError' || error.name === 'AbortError';
}
