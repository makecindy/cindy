import {
  PLUGIN_OAUTH_CHANNEL,
  parsePluginOauthPeerIdentity,
  type InvokeResultPayload,
} from '@cindy/device-link';
import type { OauthIdentityScope } from './identityStore.js';

/** A peer that has not implemented this bridge must never trigger a weaker fallback. */
export class RemotePluginOauthUnsupportedError extends Error {
  constructor() {
    super('REMOTE_PLUGIN_OAUTH_UNSUPPORTED');
    this.name = 'RemotePluginOauthUnsupportedError';
  }
}

/** Descriptor comes only from the authorized account route; it is pinned after signature verification. */
export async function resolveOauthPeerIdentity(
  deps: {
    scope(): OauthIdentityScope | null;
    invoke(deviceId: string, channel: string, args: unknown[]): Promise<InvokeResultPayload>;
    now?: () => number;
  },
  deviceId: string,
  assertCurrent: () => void,
) {
  assertCurrent();
  const scope = deps.scope();
  if (!scope || scope.deviceId === deviceId) throw new Error('OAUTH_IDENTITY_UNAVAILABLE');
  const response = await deps.invoke(deviceId, PLUGIN_OAUTH_CHANNEL, [
    { op: 'identity', version: 3 },
  ]);
  assertCurrent();
  const current = deps.scope();
  if (
    !current ||
    current.realm !== scope.realm ||
    current.membershipId !== scope.membershipId ||
    current.deviceId !== scope.deviceId
  )
    throw new Error('OAUTH_IDENTITY_UNAVAILABLE');
  if (!response.ok) {
    if (response.error.code === 'CHANNEL_NOT_ALLOWED')
      throw new RemotePluginOauthUnsupportedError();
    throw new Error('OAUTH_IDENTITY_UNAVAILABLE');
  }
  const value = parsePluginOauthPeerIdentity(response.result);
  const now = deps.now?.() ?? Date.now();
  if (
    value.deviceId !== deviceId ||
    value.membershipId !== scope.membershipId ||
    value.realm !== scope.realm ||
    value.observedAtMs > now + 1000 ||
    now - value.observedAtMs > 60_000 ||
    value.expiresAtMs <= now ||
    value.expiresAtMs > value.observedAtMs + 60_000
  )
    throw new Error('OAUTH_IDENTITY_UNAVAILABLE');
  return value;
}
