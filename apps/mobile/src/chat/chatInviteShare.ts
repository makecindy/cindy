import { getActiveMobileSessionRealm, getMobileEndpointForRealm } from '@/config/env';
import type { ApiFetchOptions } from '@/api/client';

export interface ChatInviteShares {
  create(groupId: string, token: string, actorId: string): Promise<string>;
  resolve(id: string): Promise<string>;
  revoked(id: string): Promise<void>;
}

function shareBase(value: () => string): string {
  try {
    const base = new URL(value());
    if (base.username || base.password || base.search || base.hash || base.pathname !== '/' ||
      (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)))) throw new Error();
    return base.origin;
  } catch { throw new Error('CHAT_ENDPOINT_UNAVAILABLE'); }
}

/** Reuse mobile auth refresh; the captured account/realm fences every request. */
export function createChatInviteShares(deps: {
  baseUrl(): string;
  region: 'cn' | 'global';
  realm: 'cn' | 'global';
  current(): boolean;
  apiFetch<T>(path: string, options: Omit<ApiFetchOptions, 'token'>): Promise<T>;
}): ChatInviteShares {
  const check = () => { if (!deps.current()) throw new Error('OWNER_CHANGED'); };
  const request = async (path: string, body: Record<string, unknown> = {}) => {
    check();
    const base = shareBase(deps.baseUrl);
    const value = await deps.apiFetch<Record<string, unknown>>(path, {
      baseUrl: base, method: 'POST', body: { ...body, authRealm: deps.realm },
      cache: 'no-store', redirect: 'error', timeoutMs: 20_000, assertCurrent: check,
    });
    check();
    return { base, value };
  };
  return {
    async create(groupId, token, actorId) {
      const { base, value } = await request('/api/shares', {
        kind: 'chat-invite', reference: groupId, token, actorId, region: deps.region,
        lang: deps.region === 'cn' ? 'zh-CN' : 'en', includeAttribution: true,
      });
      if (!value || value.schemaVersion !== 1 || value.kind !== 'chat-invite' || value.includeAttribution !== true ||
        typeof value.shareId !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(value.shareId) ||
        value.url !== `${base}/chat-invite/${value.shareId}`) throw new Error('CHAT_RESPONSE_INVALID');
      return value.url as string;
    },
    async resolve(id) {
      check();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20_000);
      try {
        const token = await resolveChatInviteShare(id, controller.signal, shareBase(deps.baseUrl));
        check();
        return token;
      } finally { clearTimeout(timer); }
    },
    async revoked(id) {
      // The Chat Server revocation is authoritative; a failed public-page update
      // must not turn a successfully revoked invitation into an apparent failure.
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const { value } = await request(`/api/chat-invites/${id}/revoked`);
          if (value?.revoked === true) return;
        } catch { /* A later read still checks the authoritative invite. */ }
        if (!deps.current()) return;
      }
    },
  };
}

/** The incoming host is never a request target. Use the caller's original abort window. */
export async function resolveChatInviteShare(id: string, signal: AbortSignal,
  baseUrl?: string): Promise<string> {
  if (!/^[A-Za-z0-9_-]{32}$/.test(id)) throw new Error('INVALID_INVITATION_LINK');
  const base = shareBase(() => baseUrl ?? getMobileEndpointForRealm(getActiveMobileSessionRealm(), 'shareBaseUrl'));
  const response = await fetch(`${base}/api/chat-invites/${id}/token`, {
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
