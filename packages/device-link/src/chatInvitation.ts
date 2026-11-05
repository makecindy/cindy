/** Group invite tokens and opaque Share Server references are separate formats.
 * Hosts are checked for URL shape only; callers always request their own shareBaseUrl.
 */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Legacy bare tokens and native deep links remain local parsing only. */
export function parseChatInvitationToken(input: string): string | null {
  if (typeof input !== 'string' || input.length > 8192) return null;
  const text = input.trim();
  if (TOKEN.test(text)) return text;
  return /^(?:cindy|cindycn|cindydev):\/\/chat-invite\/([A-Za-z0-9_-]{43})$/.exec(text)?.[1] ?? null;
}

/** One complete HTTPS share reference, optionally embedded in human-readable text.
 * Never returns the host or a fetch URL. Plain HTTP is reserved for local previews.
 */
export function parseChatInvitationShareId(input: string): string | null {
  if (typeof input !== 'string' || input.length > 8192) return null;
  const links = input.trim().match(/https?:\/\/(?:\[[0-9A-Fa-f:.]+\])?[^\s<>"'，。！？、（）「」“”‘’[\])]+/g)
    ?.map(link => link.replace(/[.,;!]+$/, ''))
    .filter(link => { try { return new URL(link).pathname.startsWith('/chat-invite/'); } catch { return false; } });
  if (links?.length !== 1) return null;
  try {
    const url = new URL(links[0]);
    if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname)))) return null;
    return /^\/chat-invite\/([A-Za-z0-9_-]{32})$/.exec(url.pathname)?.[1] ?? null;
  } catch { return null; }
}
