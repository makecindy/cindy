import {
  PROVIDER_SHARE_RELAY_CAPABILITY,
  ROUTED_KINDS,
  parseProviderShareScope,
  sharedTaskDeviceId,
  type Envelope,
  type ProviderShareEndpoint,
} from '@cindy/device-link-protocol';
import { DeviceLinkError } from './protocol.js';
import { parseProviderSharePeer, providerShareGuestPeer, providerShareHostPeer } from './providerSharePeer.js';
import { decodeSharedTaskEnvelope, encodeSharedTaskEnvelope } from './sharedTaskEnvelope.js';

function peerKey(share: string, endpoint: ProviderShareEndpoint, device: unknown): string {
  const id = sharedTaskDeviceId(device);
  return endpoint.role === 'host' ? providerShareHostPeer(share, id) : providerShareGuestPeer(share, endpoint.memberId, id);
}

/** Returns null when the frame is not addressed to a provider-share peer. */
export function encodeProviderShareEnvelope(env: Envelope, supportsScope: boolean): Envelope | null {
  const peer = parseProviderSharePeer(env.dst);
  if (!peer) return null;
  if (!supportsScope) throw new DeviceLinkError('VERSION_MISMATCH', 'provider share routing requires ' + PROVIDER_SHARE_RELAY_CAPABILITY);
  if (!ROUTED_KINDS.has(env.kind)) throw new DeviceLinkError('BAD_REQUEST', 'invalid provider share frame kind');
  const { src: _src, sharedTask: _task, providerShare: _scope, ...frame } = env;
  return { ...frame, dst: peer.deviceId, providerShare: {
    shareId: peer.shareId,
    target: peer.role === 'host' ? { role: 'host' } : { role: 'guest', memberId: peer.memberId },
  } };
}

/** Only relay-authored scope can become a local scoped key. Invalid scope never falls back. */
export function decodeProviderShareEnvelope(env: Envelope, supportsScope: boolean): Envelope | null {
  try {
    if (!supportsScope || env.sharedTask !== undefined || (!ROUTED_KINDS.has(env.kind) && env.kind !== 'relay-error')) return null;
    const scope = parseProviderShareScope(env.providerShare, env.kind !== 'relay-error');
    if (!scope) return null;
    if (env.kind === 'relay-error') {
      const payload = env.payload as Record<string, unknown> | undefined;
      if (!payload || typeof payload !== 'object') return null;
      return { ...env, payload: { ...payload, dst: peerKey(scope.shareId, scope.target, payload.dst) } };
    }
    return { ...env,
      src: peerKey(scope.shareId, scope.source!, env.src),
      dst: peerKey(scope.shareId, scope.target, env.dst),
    };
  } catch { return null; }
}

export interface ScopeSupport { sharedTask: boolean; providerShare: boolean }

/** Encode only at the socket boundary, after local reliable-link bookkeeping. */
export function encodeScopedEnvelope(env: Envelope, support: ScopeSupport): Envelope {
  const provider = encodeProviderShareEnvelope(env, support.providerShare);
  if (provider) return provider;
  if (env.providerShare !== undefined) throw new DeviceLinkError('BAD_REQUEST', 'provider share scope requires a scoped local peer');
  return encodeSharedTaskEnvelope(env, support.sharedTask);
}

/** Decode relay frames into local peer keys; a frame may carry at most one scope. */
export function decodeScopedEnvelope(env: Envelope, support: ScopeSupport): Envelope | null {
  if (env.providerShare !== undefined) return decodeProviderShareEnvelope(env, support.providerShare);
  return decodeSharedTaskEnvelope(env, support.sharedTask);
}
