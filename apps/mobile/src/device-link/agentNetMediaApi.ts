import type { ApiFetchOptions } from '@/api/client';
import { DEVICE_LINK_API_BASE_URL } from '@/config/env';
import type { MobileAgentNetEnrollmentOptions } from './agentNetIdentity';
import { normalizeSelfHostedRelayBase } from './selfHostedRelayRouting';
import { openMobileAgentNetMedia, deleteMobileAgentNetMedia } from './agentNetMedia';
import { isAgentNetMediaReference } from '@cindy/agent-net-protocol';
export async function mobileAgentNetMediaRequest<T>(path: string, opts: Omit<ApiFetchOptions, 'token'>,
  enrollment?: MobileAgentNetEnrollmentOptions): Promise<{ handled: false } | { handled: true; value: T }> {
  const key = (opts.body as { key?: unknown } | undefined)?.key;
  if (typeof key !== 'string' || !isAgentNetMediaReference(key)) return { handled: false };
  opts.assertCurrent?.();
  if (normalizeSelfHostedRelayBase(opts.baseUrl) !== normalizeSelfHostedRelayBase(DEVICE_LINK_API_BASE_URL)) throw new Error('AGENT_NET_MEDIA_SCOPE_MISMATCH');
  if (path === '/api/device-link/media/presign-get' && opts.method === 'POST') {
    const value = await openMobileAgentNetMedia(key, { enrollment, signal: opts.signal, assertCurrent: opts.assertCurrent });
    opts.assertCurrent?.(); return { handled: true, value: value as T };
  }
  if (path === '/api/device-link/media' && opts.method === 'DELETE') {
    await deleteMobileAgentNetMedia(key, enrollment); opts.assertCurrent?.();
    return { handled: true, value: { deleted: true } as T };
  }
  throw new Error('AGENT_NET_UNSUPPORTED_MEDIA_REQUEST');
}
