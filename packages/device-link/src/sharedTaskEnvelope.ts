import { ROUTED_KINDS, SHARED_TASK_RELAY_CAPABILITY, parseSharedTaskScope, sharedTaskDeviceId, type Envelope, type SharedTaskEndpoint } from '@cindy/device-link-protocol';
import { DeviceLinkError } from './protocol.js';
import { parseSharedTaskPeer, sharedTaskGuestPeer, sharedTaskHostPeer } from './sharedTaskPeer.js';

function peerKey(task: string, endpoint: SharedTaskEndpoint, device: unknown): string {
  const id = sharedTaskDeviceId(device);
  return endpoint.role === 'host' ? sharedTaskHostPeer(task, id) : sharedTaskGuestPeer(task, endpoint.memberId, id);
}
/** Encode only at the socket boundary, after local reliable-link bookkeeping. */
export function encodeSharedTaskEnvelope(env: Envelope, supportsScope: boolean): Envelope {
  const peer = parseSharedTaskPeer(env.dst);
  if (!peer) {
    if (env.sharedTask !== undefined) throw new DeviceLinkError('BAD_REQUEST', 'shared scope requires a scoped local peer');
    if (env.dst !== undefined) sharedTaskDeviceId(env.dst);
    return env;
  }
  if (!supportsScope) throw new DeviceLinkError('VERSION_MISMATCH', 'shared task routing requires ' + SHARED_TASK_RELAY_CAPABILITY);
  if (!ROUTED_KINDS.has(env.kind)) throw new DeviceLinkError('BAD_REQUEST', 'invalid shared task frame kind');
  const { src: _src, sharedTask: _scope, ...frame } = env;
  return { ...frame, dst: peer.deviceId, sharedTask: {
    sharedTaskId: peer.sharedTaskId,
    target: peer.role === 'host' ? { role: 'host' } : { role: 'guest', memberId: peer.memberId },
  } };
}
/** Only relay-authored scope can become a local scoped key. Invalid scope never falls back. */
export function decodeSharedTaskEnvelope(env: Envelope, supportsScope: boolean): Envelope | null {
  try {
    if (env.sharedTask === undefined) {
      if (env.src !== undefined) sharedTaskDeviceId(env.src);
      if (env.dst !== undefined) sharedTaskDeviceId(env.dst);
      if (env.kind === 'relay-error') {
        const dst = (env.payload as { dst?: unknown } | undefined)?.dst;
        if (dst !== undefined) sharedTaskDeviceId(dst);
      }
      return env;
    }
    if (!supportsScope || (!ROUTED_KINDS.has(env.kind) && env.kind !== 'relay-error')) return null;
    const scope = parseSharedTaskScope(env.sharedTask, env.kind !== 'relay-error');
    if (!scope) return null;
    if (env.kind === 'relay-error') {
      const payload = env.payload as Record<string, unknown> | undefined;
      if (!payload || typeof payload !== 'object') return null;
      return { ...env, payload: { ...payload, dst: peerKey(scope.sharedTaskId, scope.target, payload.dst) } };
    }
    return { ...env,
      src: peerKey(scope.sharedTaskId, scope.source!, env.src),
      dst: peerKey(scope.sharedTaskId, scope.target, env.dst),
    };
  } catch { return null; }
}
