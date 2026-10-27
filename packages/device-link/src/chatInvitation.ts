/**
 * Chat Server group invitations. The public page keeps the token in the fragment —
 * `<deviceLinkBase>/chat-invite/join#<token>[?app=cindy|cindycn|cindydev]` — and desktop
 * opens `cindy://chat-invite/<token>`. Only the token is used: the client always asks its
 * own Chat Server, so a link's host is checked for shape and never becomes a request target
 * or a reason to switch servers or regions. Rules match the page's own validation.
 */
export const CHAT_INVITATION_PATH = '/chat-invite/join';
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const CUSTOM_SCHEME_PREFIX = 'cindy://chat-invite/';
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Accept a bare token, the existing `cindy://chat-invite/<token>` link, or one public page
 * link in shared text. Anything else (query, user info, extra fragment segments, unknown
 * app hint, other schemes, several invitation links) is null.
 */
export function parseChatInvitationToken(input: string): string | null {
  if (typeof input !== 'string' || input.length > 8192) return null;
  const text = input.trim();
  if (TOKEN.test(text)) return text;
  if (text.startsWith(CUSTOM_SCHEME_PREFIX)) {
    const token = text.slice(CUSTOM_SCHEME_PREFIX.length);
    return TOKEN.test(token) ? token : null;
  }
  // Trailing sentence punctuation is not part of a link; it can never complete a token.
  // Brackets end a link (Markdown `[text](url)`) except around an IPv6 host such as `[::1]`.
  const links = text.match(/https?:\/\/(?:\[[0-9A-Fa-f:.]+\])?[^\s<>"'，。！？、（）「」“”‘’[\])]+/g)
    ?.map((link) => link.replace(/[.,;!]+$/, ''))
    .filter((link) => {
      try { return new URL(link).pathname.endsWith(CHAT_INVITATION_PATH); } catch { return false; }
    });
  if (links?.length !== 1) return null;
  try {
    const url = new URL(links[0]);
    if (url.username || url.password || url.search) return null;
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))) return null;
    const [token, hint, extra] = url.hash.slice(1).split('?');
    if (extra !== undefined || (hint !== undefined && !/^app=(cindy|cindycn|cindydev)$/.test(hint))) return null;
    return TOKEN.test(token) ? token : null;
  } catch {
    return null;
  }
}
