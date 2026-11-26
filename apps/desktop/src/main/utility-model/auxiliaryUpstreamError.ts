import { redactSensitiveText } from '@cindy/maker-shared/error-redaction';
import type { UtilityTextAttempt } from '../../shared/utilityTextResult.js';

/** Never put provider text on a diagnostic object serialized to ordinary callers. */
const details = new WeakMap<object, { upstreamMessage?: string; httpStatus?: number }>();
export function attachUpstreamMessage(object: object, message: string | undefined, status?: number): void {
  if (message || status) details.set(object, { ...(message ? { upstreamMessage: message } : {}), ...(status ? { httpStatus: status } : {}) });
}
export function copyUpstreamDetail(from: object, to: object): void {
  const detail = details.get(from);
  if (detail) details.set(to, detail);
}
export function trustedHttpError(attempt?: UtilityTextAttempt) {
  return { ...(attempt?.reason === 'http_error' ? { httpStatus: attempt.httpStatus } : {}), ...(attempt && details.get(attempt)) };
}

function messageFromEnvelope(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() ? value : undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const body = value as Record<string, unknown>;
  const response = body.response && typeof body.response === 'object'
    ? (body.response as Record<string, unknown>).error : undefined;
  const error = typeof body.error === 'string' && /^[a-z\d]+(?:[_-][a-z\d]+)+$/i.test(body.error) ? undefined : body.error;
  for (const child of [body.message, error, body.detail, response]) {
    const message = messageFromEnvelope(child);
    if (message) return message;
  }
}

/** SSE joins consecutive data fields with a newline before decoding the event. */
export function errorFrames(raw: string): { data: string; event: string }[] {
  const normalized = raw.replace(/\r\n?/g, '\n');
  if (!/^data:/m.test(normalized)) return [{ data: raw, event: '' }];
  return normalized.split('\n\n').map(block => {
    const lines = block.split('\n');
    const event = lines.find(line => line.startsWith('event:'))?.slice(6).trim() ?? '';
    const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
    return { data, event };
  });
}

// Ordinary diagnostic vocabulary can also occur in a title or instructions.
const commonWords = new Set('this that with from about after before your only cannot please error failed request model provider message connection test title output text response'.split(' '));

/** Parse a bounded error envelope. Mixed debug dumps are intentionally omitted. */
export function extractUpstreamMessage(raw: string, complete: boolean, contentType: string, secrets: string[], requestText: (string | undefined)[]): string | undefined {
  const mime = contentType.split(';', 1)[0].trim().toLowerCase();
  if (!raw.trim() || (mime && !['text/plain', 'text/event-stream', 'application/json'].includes(mime) && !mime.endsWith('+json'))) return;
  let message: string | undefined;
  try {
    message = messageFromEnvelope(JSON.parse(raw));
  } catch {
    if (mime === 'text/event-stream' || /^(?:event:|data:|:)/m.test(raw)) {
      for (const { data, event: name } of errorFrames(raw)) {
        try {
          const event = JSON.parse(data);
          if (name === 'error' || name === 'response.failed' || event.error || event.type === 'error' || event.type === 'response.failed') {
            message = messageFromEnvelope(event);
            if (message) break;
          }
        } catch { /* Ignore incomplete frames. */ }
      }
    } else if (!/json|xml/i.test(contentType) && !/^\s*[[{"<]/.test(raw) && complete) {
      message = raw;
    }
  }
  if (!message?.trim()) return;
  const detail = message;
  const fragments = detail.match(/[^\r\n]{24}/g) ?? [];
  // Short echoed values commonly appear quoted, after a colon, or alone on a line.
  const excerpts = detail.split(/[\r\n"'`“”‘’:：]/u).map(value => value.trim()).filter(value => value.length >= 4);
  const words = detail.match(/[\p{L}\p{N}_-]+/gu) ?? [];
  const phrases = words.slice(1).map((word, index) => words[index] + ' ' + word).filter(pair => pair.length >= 8);
  // Named identifiers in an unquoted error sentence can also echo private input.
  const names = words.filter(word => (word.length >= 4 || /\d/.test(word)) && !commonWords.has(word.toLowerCase()));
  const quotes = Array.from(detail.matchAll(/["'“‘`]([^"'”’`\r\n]+)["'”’`]/gu), match => match[1].trim()).filter(Boolean);
  const overlaps = [...quotes, ...excerpts, ...fragments, ...phrases, ...names];
  if (requestText.some(text => text && (detail.includes(text) || overlaps.some(part => text.includes(part))))) return;
  if (/(?:^|[\s("'=])(?:file:\/\/|[a-z]:[\\/]|\\\\[^\s]+\\|\/(?:home|Users|usr|opt|etc|var|tmp|srv|app|private)\/)|Traceback \(most recent call last\)|^\s*at .+?:\d+:\d+/im.test(detail)) return;
  // Suppress markup, structured dumps, HTTP headers and echoed prompts even inside a message.
  if (/-----BEGIN [^-]*PRIVATE KEY-----|<\/?[a-z][^>]*>|<!doctype|[{[]\s*"[^"]+"\s*:/i.test(message)) return;
  if (/(?:^|\n)\s*(?:[\w-]+-[\w-]+|authorization|cookie|host|headers|request(?: body| headers)?|prompt)\s*[:=]|(?:^|\n)\s*(?:GET|POST|PUT|PATCH|DELETE)\s+\//im.test(message) ||
      /\p{Cc}/u.test(message.replace(/[\r\n\t]/g, ''))) return;
  for (const secret of secrets) {
    if (secret) message = message.replaceAll(secret, '[REDACTED]');
  }
  const safe = redactSensitiveText(message).replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/g, '[REDACTED]');
  return safe.length > 1024 ? safe.slice(0, 1024) + '…' : safe;
}
