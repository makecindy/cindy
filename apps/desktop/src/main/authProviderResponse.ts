import type { AuthFetch } from '@cindy/auth-client';
import { redact } from './log-upload/redact';

/** Untrusted proxy pages can echo credentials in HTML, URLs or plain text. */
function safeExcerpt(value: string, limit: number): string {
  // Bound synchronous diagnostic work, not just its output. Omit oversized
  // values whole: slicing before redaction could expose a partial credential.
  if (value.length > 16 * 1024) return '[omitted: exceeds diagnostic limit]';
  return redact(value
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+/gi, '[url]')
    .replace(/\b(?:Bearer|Basic|Digest|Negotiate|NTLM)\s+[^\s<>]+/gi, '[credential]')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, '[removed]')
    .replace(/<!--[^]*?(?:-->|$)/g, '[removed]')
    .replace(/<([a-z][a-z0-9]*)\b[^>]*>/gi, '<$1>'))
    .replace(/[A-Za-z0-9_+/=-]{24,}/g, '[redacted]')
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, limit);
}

/** Only the public, credential-free providers GET is eligible for body diagnostics.
 * Keep the same fetch, timeout and response semantics; never issue a second request.
 */
export function withProviderResponseDiagnostics(
  fetch: AuthFetch,
  report: (diagnostic: { status: number; server: string; via: string; bodyPrefix: string }) => void,
): AuthFetch {
  return async (input, init) => {
    const response = await fetch(input, init);
    if (new URL(input).pathname !== '/api/auth/providers' || response.ok ||
        (init?.method && init.method !== 'GET') || init?.body || !response.text ||
        Object.keys(init?.headers ?? {}).some((key) => /^(authorization|proxy-authorization|cookie)$/i.test(key))) {
      return response;
    }
    return {
      ok: response.ok,
      status: response.status,
      headers: response.headers,
      async json() {
        // Read exactly once, within CindyAuthClient's existing body-read deadline.
        const body = await response.text!();
        try {
          return JSON.parse(body) as unknown;
        } catch {
          try {
            report({
              status: response.status,
              server: safeExcerpt(response.headers?.get('server') ?? '', 120) || 'unknown',
              via: safeExcerpt(response.headers?.get('via') ?? '', 120) || 'unknown',
              bodyPrefix: safeExcerpt(body, 512) || '(empty)',
            });
          } catch { /* Diagnostics must not replace the HTTP failure. */ }
          // JSON.parse errors can contain raw body excerpts; never propagate those.
          throw new SyntaxError('Invalid JSON response');
        }
      },
    };
  };
}
