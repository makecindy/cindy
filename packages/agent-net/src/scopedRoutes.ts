import { delegationEndpointCertificate, type Delegation } from '@cindy/agent-net-protocol';
import { parseProviderShareScope, parseSharedTaskScope, type Envelope } from '@cindy/device-link-protocol';
import { parseProviderSharePeer, parseSharedTaskPeer } from '@cindy/device-link';

export interface ScopedPeerTarget { relayId: string; transportKey: string; delegation: Delegation; }
/** Resolve a local logical peer only within its verified resource/member. */
export function delegatedPeerTarget(d: Delegation, peer: string, localRole: 'host' | 'guest'): ScopedPeerTarget | null {
  const p = d.kind === 'shared-task' ? parseSharedTaskPeer(peer) : parseProviderSharePeer(peer);
  const resourceId = p && ('sharedTaskId' in p ? p.sharedTaskId : p.shareId);
  if (!p || !d.scope || resourceId !== d.resourceId || p.role === localRole) return null;
  if (localRole === 'guest') {
    const endpoint = delegationEndpointCertificate(d, p.deviceId);
    return endpoint ? { relayId: p.deviceId, transportKey: endpoint.transportKey, delegation: d } : null;
  }
  return p.role === 'guest' && p.memberId === d.scope.memberId && p.deviceId === d.guestDeviceId
    ? { relayId: 'guest:' + d.id, transportKey: d.guestTransportKey, delegation: d } : null;
}

const guestKinds = new Set(['link-open', 'link-close', 'invoke', 'push']);
const hostKinds = new Set(['link-accept', 'link-close', 'invoke-result', 'push']);
/** Same guest ACK boundary as the existing shared-task/provider-share relay. */
function guestAck(value: unknown): boolean {
  const frame = value as { channel?: unknown; payload?: { streamId?: unknown; ackSeq?: unknown; linkRequestId?: unknown } };
  if (!frame || typeof frame !== 'object' || Array.isArray(frame) || '__cindyDeviceLinkTransport' in frame
    || frame.channel !== '__cindy/device-link/transport-ack') return false;
  const ack = frame.payload;
  return !!ack && typeof ack === 'object' && !Array.isArray(ack) && typeof ack.streamId === 'string'
    && Number.isSafeInteger(ack.ackSeq) && Number(ack.ackSeq) >= 0 && (ack.linkRequestId === undefined
      || typeof ack.linkRequestId === 'string' && ack.linkRequestId.length >= 1 && ack.linkRequestId.length <= 256);
}
/** Every scoped application frame is bound to the host-signed resource/member.
 * Sender-supplied source roles never reach DeviceLinkClient's scoped decoder. */
export function scopedFrame(delegation: Delegation, frame: Envelope, sender: 'host' | 'guest', endpoint = delegation.hostDeviceId): Envelope | null {
  const member = delegation.scope;
  if (!member || !delegationEndpointCertificate(delegation, endpoint) || !(sender === 'guest' ? guestKinds : hostKinds).has(frame.kind)) return null;
  const provider = delegation.kind === 'provider-share';
  if (provider ? frame.sharedTask !== undefined : frame.providerShare !== undefined) return null;
  const scope = provider ? parseProviderShareScope(frame.providerShare) : parseSharedTaskScope(frame.sharedTask);
  if (!scope || (provider ? (scope as { shareId: string }).shareId : (scope as { sharedTaskId: string }).sharedTaskId) !== delegation.resourceId) return null;
  const toGuest = sender === 'host';
  if (scope.target.role !== (toGuest ? 'guest' : 'host')
    || scope.target.role === 'guest' && scope.target.memberId !== member.memberId
    || frame.dst !== (toGuest ? delegation.guestDeviceId : endpoint)
    || sender === 'guest' && frame.kind === 'push' && !guestAck(frame.payload)) return null;
  const guest = { role: 'guest' as const, memberId: member.memberId }, host = { role: 'host' as const };
  const roles = { source: toGuest ? host : guest, target: toGuest ? guest : host };
  return { ...frame, src: toGuest ? endpoint : delegation.guestDeviceId,
    ...(provider ? { providerShare: { shareId: delegation.resourceId, ...roles } }
      : { sharedTask: { sharedTaskId: delegation.resourceId, ...roles } }) };
}
export function frameMatchesDelegation(delegation: Delegation, frame: Envelope): boolean {
  const scope = delegation.kind === 'provider-share' ? parseProviderShareScope(frame.providerShare) : parseSharedTaskScope(frame.sharedTask);
  return !!delegation.scope && !!scope && (delegation.kind === 'provider-share'
    ? (scope as { shareId: string }).shareId : (scope as { sharedTaskId: string }).sharedTaskId) === delegation.resourceId
    && scope.target.role === 'guest' && scope.target.memberId === delegation.scope.memberId && frame.dst === delegation.guestDeviceId;
}
