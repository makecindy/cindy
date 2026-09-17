/**
 * Task-scoped meeting authorization contract. This does not enable cross-account
 * routing: the relay and host must authenticate the source before consuming it.
 * Same-account device control continues to use its existing authorization path.
 */
import { isMeetingPeer } from './protocol.js';
import { parseAttachmentOssRef } from './attachmentOssRef.js';

/** Only objects issued for this shared task may be materialized on its host. */
export function isSessionMeetingAttachment(value: string, meetingId: string): boolean {
  const ref = parseAttachmentOssRef(value);
  const parts = ref?.ossKey.split('/');
  return !!parts && parts.length === 5 && parts[0] === 'cindy' && parts[1] === 'shared-task' &&
    parts[2] === meetingId && parts.slice(2).every((part) => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(part));
}

export const SESSION_MEETING_CAPABILITY = 'session-meeting-v1';
export const SESSION_MEETING_MAX_ACTIVE_PER_OWNER = 3;
export const SESSION_MEETING_MAX_GUESTS = 3;
/** Ordinary task screens also request the device-wide list; shared peers never do. */
export function sessionMeetingTopics<T extends string>(peer: string, topics: readonly T[]): T[] {
  return topics.filter((topic) => !isMeetingPeer(peer) || topic !== 'sessions');
}

export interface SessionMeetingIdentity {
  readonly meetingId: string;
  readonly sessionId: string;
  readonly ownerAccountId: string;
  readonly hostDeviceId: string;
}

/** An approved account. Presence is a separate, non-authorizing projection. */
export interface SessionMeetingGrant {
  readonly memberId: string;
  readonly accountId: string;
  /** Changes when this member's authorization changes, not on presence changes. */
  readonly version: number;
  readonly deviceIds: readonly string[];
}

/** A complete authority snapshot, never an arbitrary Renderer-supplied patch. */
export interface SessionMeetingSnapshot extends SessionMeetingIdentity {
  readonly revision: number;
  readonly status: 'active' | 'closed';
  /** Active guests only; owner identity is carried separately. */
  readonly guests: readonly SessionMeetingGrant[];
}

export type SessionMeetingOperation =
  | 'history.read' | 'events.subscribe' | 'attachment.read' | 'attachment.upload'
  | 'file.read' | 'input.send' | 'input.edit' | 'input.withdraw' | 'agent.stop'
  | 'agent.configure' | 'approval.resolve' | 'permission.configure'
  | 'workdir.configure' | 'plugins.configure' | 'history.delete'
  | 'session.archive' | 'session.export' | 'session.fork'
  | 'background.create' | 'schedule.create' | 'meeting.manage';

/** Derived from authenticated account/device claims, never from request args. */
export interface SessionMeetingCaller {
  readonly accountId: string;
  readonly deviceId: string;
}

/** Resolve this from the host queue, not from a caller-supplied message payload. */
export interface SessionMeetingQueueItem {
  readonly sessionId: string;
  readonly authorAccountId: string;
  readonly state: 'pending' | 'accepted';
}

export type SessionMeetingDenial =
  | 'meeting-unavailable' | 'scope-mismatch' | 'not-a-member'
  | 'owner-required' | 'queue-item-unavailable' | 'queue-item-not-owned'
  | 'unknown-operation';

export type SessionMeetingDecision =
  | { allowed: true; role: 'host' | 'guest'; memberId: string; memberVersion: number }
  | { allowed: false; reason: SessionMeetingDenial };

const sharedOperations: ReadonlySet<string> = new Set<SessionMeetingOperation>([
  'history.read', 'events.subscribe', 'attachment.read', 'attachment.upload',
  'file.read', 'input.send', 'agent.stop', 'agent.configure',
]);
const ownerOperations: ReadonlySet<string> = new Set<SessionMeetingOperation>([
  'approval.resolve', 'permission.configure', 'workdir.configure', 'plugins.configure',
  'history.delete', 'session.archive', 'session.export', 'session.fork',
  'background.create', 'schedule.create', 'meeting.manage',
]);

/**
 * Only task-level authorization. File ancestry, attachment ownership, tool risk,
 * and queue transaction identity must ALSO be checked by the executing handler.
 */
export function authorizeSessionMeetingOperation(
  snapshot: SessionMeetingSnapshot | null,
  caller: SessionMeetingCaller,
  sessionId: string,
  operation: string,
  queueItem?: SessionMeetingQueueItem,
): SessionMeetingDecision {
  if (!snapshot || snapshot.status !== 'active') return { allowed: false, reason: 'meeting-unavailable' };
  if (snapshot.sessionId !== sessionId) return { allowed: false, reason: 'scope-mismatch' };
  const isOwner = caller.accountId === snapshot.ownerAccountId;
  const guest = isOwner ? undefined : snapshot.guests.find((item) =>
    item.accountId === caller.accountId && item.deviceIds.includes(caller.deviceId));
  if (!isOwner && !guest) return { allowed: false, reason: 'not-a-member' };
  const allowed: SessionMeetingDecision = {
    allowed: true,
    role: isOwner ? 'host' : 'guest',
    memberId: isOwner ? snapshot.ownerAccountId : guest!.memberId,
    memberVersion: isOwner ? 0 : guest!.version,
  };
  if (sharedOperations.has(operation)) return allowed;
  if (ownerOperations.has(operation)) return isOwner ? allowed : { allowed: false, reason: 'owner-required' };
  if (operation === 'input.edit' || operation === 'input.withdraw') {
    if (!queueItem || queueItem.sessionId !== sessionId || queueItem.state !== 'pending') {
      return { allowed: false, reason: 'queue-item-unavailable' };
    }
    return isOwner || queueItem.authorAccountId === caller.accountId
      ? allowed : { allowed: false, reason: 'queue-item-not-owned' };
  }
  return { allowed: false, reason: 'unknown-operation' };
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid meeting snapshot');
  return value as Record<string, unknown>;
}

function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new Error('Invalid meeting identifier');
  }
  return value;
}

function version(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error('Invalid meeting revision');
  }
  return value;
}

/** Validate/project a decoded response; parsing alone does NOT authenticate it. */
export function parseSessionMeetingSnapshot(value: unknown): SessionMeetingSnapshot {
  const row = record(value);
  const ownerAccountId = identifier(row.ownerAccountId);
  const hostDeviceId = identifier(row.hostDeviceId);
  if (row.status !== 'active' && row.status !== 'closed') throw new Error('Invalid meeting status');
  if (!Array.isArray(row.guests) || row.guests.length > SESSION_MEETING_MAX_GUESTS) {
    throw new Error('Invalid meeting guests');
  }
  const accounts = new Set<string>([ownerAccountId]);
  const members = new Set<string>();
  const guests = row.guests.map((value): SessionMeetingGrant => {
    const guest = record(value);
    const memberId = identifier(guest.memberId);
    const accountId = identifier(guest.accountId);
    if (accounts.has(accountId) || members.has(memberId)) throw new Error('Duplicate meeting member');
    accounts.add(accountId);
    members.add(memberId);
    // Device claims are account-scoped. Two accounts can legitimately report
    // the same deviceId; only the authenticated account+device pair is identity.
    const devices = new Set<string>();
    if (!Array.isArray(guest.deviceIds) || guest.deviceIds.length > 64) throw new Error('Invalid member devices');
    const deviceIds = guest.deviceIds.map((value): string => {
      const deviceId = identifier(value);
      if (devices.has(deviceId)) throw new Error('Duplicate meeting device');
      devices.add(deviceId);
      return deviceId;
    }).sort();
    return Object.freeze({ memberId, accountId, version: version(guest.version), deviceIds: Object.freeze(deviceIds) });
  }).sort((a, b) => a.memberId < b.memberId ? -1 : a.memberId > b.memberId ? 1 : 0);
  return Object.freeze({
    meetingId: identifier(row.meetingId), sessionId: identifier(row.sessionId),
    ownerAccountId, hostDeviceId, revision: version(row.revision), status: row.status,
    guests: Object.freeze(guests),
  });
}
