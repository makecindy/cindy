import type { DeviceView } from '@cindy/device-link';
import type { ApiFetchOptions } from '@/api/client';
import { ApiError } from '@/api/client';
import { DEVICE_LINK_API_BASE_URL } from '@/config/env';
import { getMobileAuthOwner, isMobileAuthOwnerCurrent } from '@/auth/authOwnerGeneration';
import { isMobileAgentNetActive } from './agentNetRuntime';
import { ensureMobileAgentNetIdentity, type MobileAgentNetEnrollmentOptions } from './agentNetIdentity';
import { getMobileAgentNetPreferences, mobileAgentNetRequiresEncryption } from './agentNetPreferences';
import { getSelfHostedRelayRouteGeneration, normalizeSelfHostedRelayBase } from './selfHostedRelayRouting';
import { writeMobileAgentNetDirectory } from './agentNetDirectoryCache';

/** The ordinary device-management API keeps its existing result contract. V2
 * reads and mutations use certificate authentication on the selected network;
 * they never retry against an official service or through the V1 credential. */
export async function mobileAgentNetDeviceRequest<T>(path: string, opts: Omit<ApiFetchOptions, 'token'>,
  enrollment: MobileAgentNetEnrollmentOptions): Promise<{ handled: false } | { handled: true; value: T }> {
  const match = /^\/api\/device-link\/devices(?:\/([^/?#]+))?$/.exec(path);
  if (!match || normalizeSelfHostedRelayBase(opts.baseUrl) !== normalizeSelfHostedRelayBase(DEVICE_LINK_API_BASE_URL)) return { handled: false };
  if (!isMobileAgentNetActive()) {
    if (mobileAgentNetRequiresEncryption()) throw new Error('AGENT_NET_ENCRYPTED_IDENTITY_REQUIRED');
    return { handled: false };
  }
  const owner = getMobileAuthOwner(), route = getSelfHostedRelayRouteGeneration(), generation = getMobileAgentNetPreferences().generation;
  const guard = () => {
    opts.assertCurrent?.();
    if (opts.signal?.aborted || !isMobileAuthOwnerCurrent(owner) || route !== getSelfHostedRelayRouteGeneration()
      || generation !== getMobileAgentNetPreferences().generation) throw new Error('AGENT_NET_OWNER_CHANGED');
  };
  guard();
  const identity = await ensureMobileAgentNetIdentity(enrollment); guard();
  try {
    const method = opts.method ?? 'GET';
    let result: unknown;
    if (!match[1] && method === 'GET') {
      const directory = await identity.api.directory(); guard();
      await writeMobileAgentNetDirectory(identity, directory); guard();
      const devices: DeviceView[] = directory.map(view => ({ deviceId: view.certificate.deviceId, name: view.name, selfName: view.selfName ?? view.name,
        platform: view.platform ?? null, appVersion: view.appVersion ?? null,
        lastSeenAt: view.lastSeenAt ? new Date(view.lastSeenAt).toISOString() : null,
        online: view.online, busy: !!view.busy, remoteControlEnabled: view.remoteControlEnabled,
        isSelf: view.certificate.deviceId === enrollment.deviceId }));
      result = { devices };
    } else if (match[1] && ['PATCH', 'DELETE'].includes(method)) {
      const target = decodeURIComponent(match[1]);
      const response = await identity.api.request<{ name?: string }>(method, '/devices/' + encodeURIComponent(target), method === 'PATCH' ? opts.body : undefined, { signal: opts.signal });
      guard();
      result = method === 'DELETE' ? { deviceId: target, deleted: true }
        : { deviceId: target, name: response.name ?? (opts.body as { name: string }).name };
    } else throw new Error('AGENT_NET_UNSUPPORTED_DEVICE_REQUEST');
    guard(); return { handled: true, value: result as T };
  } catch (error) {
    guard();
    const status = (error as { status?: unknown }).status, code = (error as { code?: unknown }).code;
    // A certificate rejection belongs to this network, not the account login.
    if (typeof status === 'number' && typeof code === 'string') throw new ApiError(code, status, code);
    throw error;
  }
}
