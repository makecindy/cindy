import { getActiveMobileSessionRealm, getMobileEndpointForRealm } from '@/config/env';

/** The incoming host is never a request target. Use the caller's original abort window. */
export async function resolveChatInviteShare(id: string, signal: AbortSignal): Promise<string> {
  if (!/^[A-Za-z0-9_-]{32}$/.test(id)) throw new Error('INVALID_INVITATION_LINK');
  let base: URL;
  try {
    base = new URL(getMobileEndpointForRealm(getActiveMobileSessionRealm(), 'shareBaseUrl'));
    if (base.username || base.password || base.search || base.hash || base.pathname !== '/' ||
      (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)))) throw new Error();
  } catch { throw new Error('CHAT_ENDPOINT_UNAVAILABLE'); }
  const response = await fetch(`${base.origin}/api/chat-invites/${id}/token`, {
    method: 'POST', redirect: 'error', cache: 'no-store', signal,
  });
  if (response.status === 404) throw new Error('INVITATION_NOT_FOUND');
  if (response.status !== 200) throw new Error('CHAT_ENDPOINT_UNAVAILABLE');
  const text = await response.text();
  if (text.length > 8192) throw new Error('INVALID_CHAT_RESPONSE');
  const value = JSON.parse(text);
  if (!value || typeof value.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.token)) throw new Error('INVALID_CHAT_RESPONSE');
  return value.token;
}
