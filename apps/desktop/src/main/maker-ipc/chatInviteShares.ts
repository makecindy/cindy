import { app, net } from 'electron';
import * as authManager from '../authManager.js';
import { getBuildClientEndpoint } from '../clientEndpointsService.js';
import { CURRENT_CINDY_REGION } from '../../shared/brandRegion.js';

const shareId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{32}$/.test(value);
const inviteToken = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);

/** Only the installed edition's configured origin is a request target. */
export function chatInviteShareBase(): string {
  try {
    const url = new URL(getBuildClientEndpoint('shareBaseUrl'));
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && !app.isPackaged && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error();
    return url.origin;
  } catch { throw new Error('CHAT_ENDPOINT_UNAVAILABLE'); }
}

/** Capture the account once, including across refresh/retry; no input or response logging. */
function requestFor(authenticated: boolean) {
  const base = chatInviteShareBase();
  const session = authManager.getAuthState();
  const realm = authManager.getActiveAuthRealm();
  const current = () => {
    const now = authManager.getAuthState();
    return now.ownerGeneration === session.ownerGeneration && now.user?.id === session.user?.id && now.mode === session.mode && authManager.getActiveAuthRealm() === realm;
  };
  return async (path: string, body?: Record<string, unknown>) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!current()) throw new Error('OWNER_CHANGED');
      const accessToken = authenticated ? authManager.getAccessToken() : null;
      if (authenticated && !accessToken) throw new Error('AUTH_REQUIRED');
      let response: Response;
      let value: Record<string, unknown>;
      try {
        response = await net.fetch(`${base}${path}`, { method: 'POST', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(20000),
          headers: { 'Content-Type': 'application/json', ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) },
          body: body ? JSON.stringify({ ...body, ...(authenticated ? { authRealm: realm } : {}) }) : undefined });
        const reader = response.body?.getReader();
        const chunks: Uint8Array[] = []; let size = 0;
        if (!reader) throw new Error();
        try {
          while (true) {
            const next = await reader.read(); if (next.done) break;
            size += next.value.length; if (size > 8192) throw new Error(); chunks.push(next.value);
          }
        } finally { await reader.cancel(); }
        value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch { throw new Error(current() ? 'REQUEST_FAILED' : 'OWNER_CHANGED'); }
      if (!current()) throw new Error('OWNER_CHANGED');
      if (response.status === 401 && authenticated && attempt === 0 && (value?.error as { code?: string })?.code === 'TOKEN_EXPIRED') {
        if (await authManager.refresh() && current()) continue;
      }
      if (response.status !== 200) throw new Error(response.status === 404 ? 'INVITATION_NOT_FOUND' : response.status === 401 ? 'AUTH_REQUIRED' : 'REQUEST_FAILED');
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('CHAT_RESPONSE_INVALID');
      return value;
    }
    throw new Error('AUTH_REQUIRED');
  };
}

export async function createChatInviteShare(groupId: string, token: string, actorId: string): Promise<string> {
  const base = chatInviteShareBase();
  const region = CURRENT_CINDY_REGION === 'global' ? 'global' : 'cn';
  const result = await requestFor(true)('/api/shares', { kind: 'chat-invite', reference: groupId, token, actorId, region,
    lang: region === 'cn' ? 'zh-CN' : 'en', includeAttribution: true });
  if (result.schemaVersion !== 1 || result.kind !== 'chat-invite' || result.includeAttribution !== true || !shareId(result.shareId) ||
    result.url !== `${base}/chat-invite/${result.shareId}`) throw new Error('CHAT_RESPONSE_INVALID');
  return result.url as string;
}

export async function resolveChatInviteShare(id: string): Promise<string> {
  if (!shareId(id)) throw new Error('INVALID_INPUT');
  const value = await requestFor(false)(`/api/chat-invites/${id}/token`);
  if (!inviteToken(value.token)) throw new Error('CHAT_RESPONSE_INVALID');
  return value.token;
}

/** Chat revocation has already succeeded. Retry the projection once without undoing it. */
export async function notifyChatInviteRevoked(id: string): Promise<void> {
  if (!shareId(id)) return;
  try {
    const request = requestFor(true);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const value = await request(`/api/chat-invites/${id}/revoked`, {});
        if (value.revoked === true) return;
      } catch { /* A failed notification does not undo the authoritative revocation. */ }
    }
  } catch { /* An unavailable share endpoint does not undo revocation either. */ }
}
