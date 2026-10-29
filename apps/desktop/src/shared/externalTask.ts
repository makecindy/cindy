import { matchDeepLinkPrefix } from './deepLinkSchemes';

/** Short, inline text handoff. No paths, execution options, callbacks or capabilities. */
export interface ExternalTaskRequest {
  id: string;
  expires: number;
  question: string;
  context?: string;
  source?: string;
}

export type ExternalTaskPayload =
  { type: 'external-task'; request: ExternalTaskRequest } | { type: 'external-task-error' };

// A conservative application bound, not a claim about every OS/browser's URL limit.
export const EXTERNAL_TASK_MAX_URL = 4096;
export const EXTERNAL_TASK_TTL_MS = 10 * 60_000;

export function isExternalTaskRequest(value: unknown): value is ExternalTaskRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const p = value as Record<string, unknown>;
  return (
    Object.keys(p).every((key) =>
      ['id', 'expires', 'question', 'context', 'source'].includes(key),
    ) &&
    typeof p.id === 'string' &&
    /^[A-Za-z0-9_-]{1,80}$/.test(p.id) &&
    typeof p.expires === 'number' &&
    Number.isSafeInteger(p.expires) &&
    p.expires > 0 &&
    typeof p.question === 'string' &&
    !!p.question.trim() &&
    p.question.length <= EXTERNAL_TASK_MAX_URL &&
    (p.context === undefined ||
      (typeof p.context === 'string' && p.context.length <= EXTERNAL_TASK_MAX_URL)) &&
    (p.source === undefined ||
      (typeof p.source === 'string' &&
        p.source.length <= 80 &&
        !/[\p{Cc}\p{Cf}]/u.test(p.source))) &&
    ![p.question, p.context].some(
      (text) => typeof text === 'string' && /(?![\t\n\r])\p{Cc}/u.test(text),
    )
  );
}

/** Recognize the route before parsing, so malformed external input still gets a notice. */
export function isExternalTaskLink(url: string): boolean {
  const prefix = matchDeepLinkPrefix(url);
  return prefix !== null && /^new-task(?:[/?#]|$)/.test(url.slice(prefix.length));
}

/** Invalid handoffs produce a content-free notice instead of silently doing nothing. */
export function parseExternalTaskLink(url: string, now = Date.now()): ExternalTaskPayload {
  const invalid: ExternalTaskPayload = { type: 'external-task-error' };
  if (url.length > EXTERNAL_TASK_MAX_URL || /[^\x21-\x7e]/.test(url)) return invalid;
  const prefix = matchDeepLinkPrefix(url);
  const match = prefix === null ? null : /^new-task\?([^#]+)$/.exec(url.slice(prefix.length));
  if (!match) return invalid;
  const fields = new Map<string, string>();
  try {
    // URLSearchParams tolerates malformed escapes. Decode strictly before interpreting anything.
    for (const pair of match[1].split('&')) {
      const at = pair.indexOf('=');
      if (at < 1) return invalid;
      const key = decodeURIComponent(pair.slice(0, at).replace(/\+/g, ' '));
      const value = decodeURIComponent(pair.slice(at + 1).replace(/\+/g, ' '));
      if (!['v', 'id', 'expires', 'question', 'context', 'source'].includes(key) || fields.has(key))
        return invalid;
      fields.set(key, value);
    }
  } catch {
    return invalid;
  }
  if (fields.get('v') !== '1' || !/^\d{1,16}$/.test(fields.get('expires') ?? '')) return invalid;
  const request = {
    id: fields.get('id'),
    expires: Number(fields.get('expires')),
    question: fields.get('question'),
    ...(fields.has('context') ? { context: fields.get('context') } : {}),
    ...(fields.has('source') ? { source: fields.get('source') } : {}),
  };
  return isExternalTaskRequest(request) && request.expires > now
    ? {
        type: 'external-task',
        request: { ...request, expires: Math.min(request.expires, now + EXTERNAL_TASK_TTL_MS) },
      }
    : invalid;
}
