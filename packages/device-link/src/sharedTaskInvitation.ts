/** Public invitation URLs carry the secret in the fragment, never the HTTP request. */
export const SHARED_TASK_INVITATION_PATH = '/shared-task/join';
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export function isSharedTaskInvitation(value: unknown): value is string {
  return typeof value === 'string' && TOKEN.test(value);
}

/** Only compare this value with the configured endpoint; never use it as a request target. */
export function sharedTaskInvitationServer(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) return null;
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) return null;
    return url.origin + url.pathname.replace(/\/+$/, '');
  } catch { return null; }
}

export type SharedTaskInvitationApp = 'cindy' | 'cindycn' | 'cindydev';
const APPS = new Set(['cindy', 'cindycn', 'cindydev']);

export function buildSharedTaskInvitationLink(invitation: string, server: string, app: SharedTaskInvitationApp = 'cindy'): string {
  const base = sharedTaskInvitationServer(server);
  if (!isSharedTaskInvitation(invitation) || !base || !APPS.has(app)) throw new Error('Invalid shared task invitation');
  return `${base}${SHARED_TASK_INVITATION_PATH}#${invitation}${app === 'cindy' ? '' : '?app=' + app}`;
}

export type SharedTaskInvitationResult =
  | { ok: true; invitation: string }
  | { ok: false; reason: 'invalid' | 'different-server' };

/** Accept one invitation URL in shared text, or an old bare invitation. */
export function parseSharedTaskInvitation(input: string, server: string): SharedTaskInvitationResult {
  const invalid = { ok: false, reason: 'invalid' } as const;
  if (input.length > 8192) return invalid;
  const text = input.trim();
  if (TOKEN.test(text)) return { ok: true, invitation: text };
  // Task titles may contain ordinary URLs. Count all invitation-shaped URLs (even
  // invalid or foreign-server ones) so multiple invitations remain ambiguous.
  const links = text.match(/https?:\/\/[^\s<>"'，。！？、（）「」“”‘’\[\])]+/g)?.filter(link => {
    try { return new URL(link.replace(/[.,;!?]+$/, '')).pathname.endsWith(SHARED_TASK_INVITATION_PATH); }
    catch { return false; }
  });
  if (links?.length !== 1) return invalid;
  try {
    const url = new URL(links[0].replace(/[.,;!?]+$/, ''));
    if (url.search || url.username || url.password || !url.pathname.endsWith(SHARED_TASK_INVITATION_PATH)) return invalid;
    const [invitation, hint, extra] = url.hash.slice(1).split('?');
    if (extra !== undefined || (hint !== undefined && !/^app=(cindy|cindycn|cindydev)$/.test(hint))) return invalid;
    if (!isSharedTaskInvitation(invitation)) return invalid;
    const source = sharedTaskInvitationServer(url.origin + url.pathname.slice(0, -SHARED_TASK_INVITATION_PATH.length));
    if (!source) return invalid;
    if (source !== sharedTaskInvitationServer(server)) return { ok: false, reason: 'different-server' };
    return { ok: true, invitation };
  } catch { return invalid; }
}

export interface SharedTaskInvitationIntent { invitation: string; server: string }

/** Strict custom-scheme handoff. Other deep links remain owned by their existing handlers. */
export function parseSharedTaskInvitationIntent(value: string): SharedTaskInvitationIntent | null {
  if (value.length > 4096) return null;
  try {
    const url = new URL(value);
    if (!['cindy:', 'cindycn:', 'cindydev:'].includes(url.protocol) || url.username || url.password || url.port || url.hash) return null;
    if (!(url.host === 'shared-task' && url.pathname === '/join') && !(url.host === 'shared-session' && !url.pathname)) return null;
    if ([...url.searchParams.keys()].some(key => key !== 'invitation' && key !== 'server')) return null;
    if (url.searchParams.getAll('invitation').length !== 1 || url.searchParams.getAll('server').length !== 1) return null;
    const invitation = url.searchParams.get('invitation');
    const server = sharedTaskInvitationServer(url.searchParams.get('server') ?? '');
    return isSharedTaskInvitation(invitation) && server ? { invitation, server } : null;
  } catch { return null; }
}

/** Account names are display metadata. Keep the existing admission label bound. */
export function sharedTaskAccountName(name: string | null | undefined): string {
  const text = (name ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  let end = Math.min(text.length, 32);
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1] ?? '') && /[\uDC00-\uDFFF]/.test(text[end] ?? '')) end--;
  return text.slice(0, end) || 'Cindy';
}
