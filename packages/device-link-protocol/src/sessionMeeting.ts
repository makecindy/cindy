/**
 * Task-scoped logical peers multiplexed over the existing reliable device link.
 * A meeting peer is NOT a physical device identifier or an authorization grant.
 * Relay and both endpoints must negotiate this capability before using it.
 */
export const SESSION_MEETING_RELAY_CAPABILITY = 'session-meeting-v1';
export const SESSION_MEETING_PEER_PREFIX = 'meeting~';
export type SessionMeetingPeer =
  | { meetingId: string; role: 'host' }
  | { meetingId: string; role: 'guest'; memberId: string; deviceId: string };

function identifier(value: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new Error('Invalid meeting peer identifier');
  return value;
}
export function meetingHostPeer(meetingId: string): string {
  return `${SESSION_MEETING_PEER_PREFIX}${encodeURIComponent(identifier(meetingId))}~host`;
}
export function meetingGuestPeer(meetingId: string, memberId: string, deviceId: string): string {
  return `${SESSION_MEETING_PEER_PREFIX}${encodeURIComponent(identifier(meetingId))}~guest~${encodeURIComponent(identifier(memberId))}~${encodeURIComponent(identifier(deviceId))}`;
}
export function isMeetingPeer(value: unknown): value is `meeting~${string}` {
  return typeof value === 'string' && value.startsWith(SESSION_MEETING_PEER_PREFIX);
}
/** Malformed reserved peers must be rejected, never retried as legacy device IDs. */
export function parseMeetingPeer(value: unknown): SessionMeetingPeer | null {
  if (!isMeetingPeer(value) || value.length > 1600) return null;
  try {
    const parts = value.split('~');
    const meetingId = identifier(decodeURIComponent(parts[1] ?? ''));
    if (parts.length === 3 && parts[2] === 'host' && meetingHostPeer(meetingId) === value) return { meetingId, role: 'host' };
    if (parts.length !== 5 || parts[2] !== 'guest') return null;
    const memberId = identifier(decodeURIComponent(parts[3]));
    const deviceId = identifier(decodeURIComponent(parts[4]));
    return meetingGuestPeer(meetingId, memberId, deviceId) === value ? { meetingId, role: 'guest', memberId, deviceId } : null;
  } catch { return null; }
}
