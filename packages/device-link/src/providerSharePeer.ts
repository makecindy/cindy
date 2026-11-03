import { providerShareIdentifier, sharedTaskDeviceId, type ProviderShareEndpoint } from '@cindy/device-link-protocol';

export type ProviderSharePeer = { shareId: string; deviceId: string } & ProviderShareEndpoint;
const TAG = 'provider-share';
// Local map/IPC handles only, NEVER relay addresses. Physical auth IDs are <=128
// code units and shared-task keys have four parts, so these five-part keys can
// collide with neither. Padding costs no wire bytes.
function key(peer: ProviderSharePeer): string {
  return JSON.stringify([TAG, peer.shareId, peer.role, peer.role === 'guest' ? peer.memberId : null, peer.deviceId]).padEnd(129, '~');
}
export function providerShareHostPeer(shareId: string, deviceId: string): string {
  return key({ shareId: providerShareIdentifier(shareId), role: 'host', deviceId: sharedTaskDeviceId(deviceId) });
}
export function providerShareGuestPeer(shareId: string, memberId: string, deviceId: string): string {
  return key({ shareId: providerShareIdentifier(shareId), role: 'guest', memberId: providerShareIdentifier(memberId), deviceId: sharedTaskDeviceId(deviceId) });
}
export function parseProviderSharePeer(value: unknown): ProviderSharePeer | null {
  if (typeof value !== 'string' || value.length <= 128 || value.length > 2048) return null;
  try {
    const parts: unknown = JSON.parse(value.replace(/~+$/, ''));
    if (!Array.isArray(parts) || parts.length !== 5 || parts[0] !== TAG) return null;
    const [, share, role, member, device] = parts;
    const shareId = providerShareIdentifier(share);
    const deviceId = sharedTaskDeviceId(device);
    let peer: ProviderSharePeer;
    if (role === 'host' && member === null) peer = { shareId, role, deviceId };
    else if (role === 'guest') peer = { shareId, role, deviceId, memberId: providerShareIdentifier(member) };
    else return null;
    return key(peer) === value ? peer : null;
  } catch { return null; }
}
export function isProviderSharePeer(value: unknown): boolean { return parseProviderSharePeer(value) !== null; }
