import type { DeviceView } from '@cindy/device-link';
import type { ApiFetchOptions } from '@/api/client';
import { ApiError } from '@/api/client';
import { DEVICE_LINK_API_BASE_URL } from '@/config/env';
import { getMobileAuthOwner, isMobileAuthOwnerCurrent } from '@/auth/authOwnerGeneration';
import { isMobileAgentNetActive } from './agentNetRuntime';
import { ensureMobileAgentNetIdentity, type MobileAgentNetEnrollmentOptions } from './agentNetIdentity';
import { getMobileAgentNetPreferences, mobileAgentNetRequiresEncryption } from './agentNetPreferences';
import { getActiveSelfHostedRelay, getSelfHostedRelayRouteGeneration, isAgentNetOnlyRoute, normalizeSelfHostedRelayBase } from './selfHostedRelayRouting';
import { writeMobileAgentNetDirectory } from './agentNetDirectoryCache';

/** Preserve the ordinary device API and mixed-version directory. V2 devices
 * use certificate authentication on the selected network; V1-only devices keep
 * their original authenticated management route unless encryption is required. */
export async function mobileAgentNetDeviceRequest<T>(path: string, opts: Omit<ApiFetchOptions, 'token'>,
  enrollment: MobileAgentNetEnrollmentOptions, readLegacy: () => Promise<T>): Promise<{ handled: false } | { handled: true; value: T }> {
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
      const readEncrypted = async () => {
        const directory = await identity.api.directory(); guard();
        await writeMobileAgentNetDirectory(identity, directory); guard();
        const devices: DeviceView[] = directory.map(view => ({ deviceId: view.certificate.deviceId, name: view.name, selfName: view.selfName ?? view.name,
          platform: view.platform ?? null, appVersion: view.appVersion ?? null,
          lastSeenAt: view.lastSeenAt ? new Date(view.lastSeenAt).toISOString() : null,
          online: view.online, busy: !!view.busy, remoteControlEnabled: view.remoteControlEnabled,
          isSelf: view.certificate.deviceId === enrollment.deviceId }));
        return { devices };
      };
      if (mobileAgentNetRequiresEncryption()) result = await readEncrypted();
      else {
        const [legacy, encrypted] = await Promise.allSettled([readLegacy(), readEncrypted()]); guard();
        // Only a transient directory outage can use the other live result;
        // invalid membership, certificates and owner changes stay terminal.
        for (const response of [legacy, encrypted]) {
          if (response.status === 'rejected' && !directoryUnavailable(response.reason)) throw response.reason;
        }
        if (encrypted.status === 'rejected') {
          if (legacy.status === 'rejected') throw encrypted.reason;
          result = legacy.value;
        } else if (legacy.status === 'rejected') result = encrypted.value;
        else {
          const previous = legacy.value as { devices: DeviceView[] };
          const devices = new Map(previous.devices.map(device => [device.deviceId, device]));
          for (const device of encrypted.value.devices) {
            const old = devices.get(device.deviceId);
            if (!device.online && old?.online) continue;
            devices.set(device.deviceId, { ...old, ...device, deviceInfo: old?.deviceInfo ?? device.deviceInfo });
          }
          result = { ...previous, devices: [...devices.values()] };
        }
      }
    } else if (match[1] && ['PATCH', 'DELETE'].includes(method)) {
      const target = decodeURIComponent(match[1]);
      const relay = getActiveSelfHostedRelay(), synchronizeLegacy = !!relay && !isAgentNetOnlyRoute(relay);
      if (!mobileAgentNetRequiresEncryption() || synchronizeLegacy) {
        const directory = await identity.api.directory(); guard();
        if (!directory.some(view => view.certificate.deviceId === target)) {
          if (!synchronizeLegacy) return { handled: false };
          const value = await readLegacy(); guard();
          return { handled: true, value };
        }
      }
      const response = await identity.api.request<{ name?: string }>(method, '/devices/' + encodeURIComponent(target), method === 'PATCH' ? opts.body : undefined, { signal: opts.signal });
      guard();
      if (synchronizeLegacy) {
        // The private relay has independent V1/V2 membership stores. This is a
        // management write, matching Desktop even when business traffic is V2-only.
        try { await readLegacy(); }
        catch (error) {
          const legacy = error as { status?: unknown; code?: unknown };
          if (legacy.status !== 404 || legacy.code !== 'NOT_FOUND') throw error;
        }
        guard();
      }
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

function directoryUnavailable(error: unknown): boolean {
  const value = error as { status?: unknown; code?: unknown } | null;
  if (typeof value?.code === 'string' && /INVALID|DENIED|REVOKED|UNAUTHORIZED|FORBIDDEN|SCOPE_CHANGED|OWNER_CHANGED/.test(value.code)) return false;
  return value?.status === 0 || value?.status === 429
    || typeof value?.status === 'number' && value.status >= 500 && value.status < 600;
}
