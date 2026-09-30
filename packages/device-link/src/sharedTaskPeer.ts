import { sharedTaskDeviceId, sharedTaskIdentifier, type SharedTaskEndpoint } from '@cindy/device-link-protocol';

export type SharedTaskPeer = { sharedTaskId: string; deviceId: string } & SharedTaskEndpoint;
// Local map/IPC handles only, NEVER relay addresses. Physical auth IDs are <=128
// code units. Keeping scoped keys outside that domain makes collisions impossible,
// including deliberately fabricated IDs. Padding costs no wire bytes.
function key(peer: SharedTaskPeer): string {
  return JSON.stringify([peer.sharedTaskId, peer.role, peer.role === 'guest' ? peer.memberId : null, peer.deviceId]).padEnd(129, '~');
}
export function sharedTaskHostPeer(sharedTaskId: string, deviceId: string): string {
  return key({ sharedTaskId: sharedTaskIdentifier(sharedTaskId), role: 'host', deviceId: sharedTaskDeviceId(deviceId) });
}
export function sharedTaskGuestPeer(sharedTaskId: string, memberId: string, deviceId: string): string {
  return key({ sharedTaskId: sharedTaskIdentifier(sharedTaskId), role: 'guest', memberId: sharedTaskIdentifier(memberId), deviceId: sharedTaskDeviceId(deviceId) });
}
export function parseSharedTaskPeer(value: unknown): SharedTaskPeer | null {
  if (typeof value !== 'string' || value.length <= 128 || value.length > 2048) return null;
  try {
    const parts: unknown = JSON.parse(value.replace(/~+$/, ''));
    if (!Array.isArray(parts) || parts.length !== 4) return null;
    const [task, role, member, device] = parts;
    const sharedTaskId = sharedTaskIdentifier(task);
    const deviceId = sharedTaskDeviceId(device);
    let peer: SharedTaskPeer;
    if (role === 'host' && member === null) peer = { sharedTaskId, role, deviceId };
    else if (role === 'guest') peer = { sharedTaskId, role, deviceId, memberId: sharedTaskIdentifier(member) };
    else return null;
    return key(peer) === value ? peer : null;
  } catch { return null; }
}
export function isSharedTaskPeer(value: unknown): boolean { return parseSharedTaskPeer(value) !== null; }
