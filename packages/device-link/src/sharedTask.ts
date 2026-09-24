/**
 * Task-scoped sharedTask authorization contract. This does not enable cross-account
 * routing: the relay and host must authenticate the source before consuming it.
 * Same-account device control continues to use its existing authorization path.
 */
import { isSharedTaskPeer, sharedTaskDeviceId } from './protocol.js';
import { parseAttachmentOssRef } from './attachmentOssRef.js';

/** Only objects issued for this shared task may be materialized on its host. */
export function isSharedTaskAttachment(value: string, sharedTaskId: string): boolean {
  const ref = parseAttachmentOssRef(value);
  const parts = ref?.ossKey.split('/');
  return !!parts && parts.length === 6 && parts[0] === 'cindy' && parts[1] === 'device-link' &&
    parts[2] === 'shared-task' && parts[3] === sharedTaskId &&
    parts.slice(3).every((part) => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(part));
}

export const SHARED_TASK_CAPABILITY = 'shared-task-v2';
export const SHARED_TASK_MAX_GUESTS = 2;
/** Read existing development snapshots without revoking already joined guests.
 * Admission limits are enforced by the server, not by rejecting stored history. */
export const SHARED_TASK_MAX_SNAPSHOT_GUESTS = 3;
/** Ordinary task screens also request the device-wide list; shared peers never do. */
export function sharedTaskTopics<T extends string>(peer: string, topics: readonly T[]): T[] {
  return topics.filter((topic) => !isSharedTaskPeer(peer) || topic !== 'sessions');
}

export interface SharedTaskIdentity {
  readonly sharedTaskId: string;
  readonly sessionId: string;
  readonly ownerAccountId: string;
  readonly hostDeviceId: string;
}

/** An approved account. Presence is a separate, non-authorizing projection. */
export interface SharedTaskGrant {
  readonly memberId: string;
  readonly accountId: string;
  /** Changes when this member's authorization changes, not on presence changes. */
  readonly version: number;
  readonly deviceIds: readonly string[];
}

/** A complete authority snapshot, never an arbitrary Renderer-supplied patch. */
export interface SharedTaskSnapshot extends SharedTaskIdentity {
  readonly revision: number;
  readonly status: 'active' | 'closed';
  /** Active guests only; owner identity is carried separately. */
  readonly guests: readonly SharedTaskGrant[];
}

export type SharedTaskOperation =
  | 'history.read' | 'events.subscribe' | 'attachment.read' | 'attachment.upload'
  | 'file.read' | 'input.send' | 'input.edit' | 'input.withdraw' | 'agent.stop'
  | 'agent.configure' | 'approval.resolve' | 'permission.configure'
  | 'workdir.configure' | 'plugins.configure' | 'history.delete'
  | 'session.archive' | 'session.export' | 'session.fork'
  | 'background.create' | 'schedule.create' | 'sharedTask.manage';

/** Derived from authenticated account/device claims, never from request args. */
export interface SharedTaskCaller {
  readonly accountId: string;
  readonly deviceId: string;
}

/** Resolve this from the host queue, not from a caller-supplied message payload. */
export interface SharedTaskQueueItem {
  readonly sessionId: string;
  readonly authorAccountId: string;
  readonly state: 'pending' | 'accepted';
}

export type SharedTaskDenial =
  | 'sharedTask-unavailable' | 'scope-mismatch' | 'not-a-member'
  | 'owner-required' | 'queue-item-unavailable' | 'queue-item-not-owned'
  | 'unknown-operation';

export type SharedTaskDecision =
  | { allowed: true; role: 'host' | 'guest'; memberId: string; memberVersion: number }
  | { allowed: false; reason: SharedTaskDenial };

const sharedOperations: ReadonlySet<string> = new Set<SharedTaskOperation>([
  'history.read', 'events.subscribe', 'attachment.read', 'attachment.upload',
  'file.read', 'input.send', 'agent.stop', 'agent.configure',
]);
const ownerOperations: ReadonlySet<string> = new Set<SharedTaskOperation>([
  'approval.resolve', 'permission.configure', 'workdir.configure', 'plugins.configure',
  'history.delete', 'session.archive', 'session.export', 'session.fork',
  'background.create', 'schedule.create', 'sharedTask.manage',
]);

/**
 * Only task-level authorization. File ancestry, attachment ownership, tool risk,
 * and queue transaction identity must ALSO be checked by the executing handler.
 */
export function authorizeSharedTaskOperation(
  snapshot: SharedTaskSnapshot | null,
  caller: SharedTaskCaller,
  sessionId: string,
  operation: string,
  queueItem?: SharedTaskQueueItem,
): SharedTaskDecision {
  if (!snapshot || snapshot.status !== 'active') return { allowed: false, reason: 'sharedTask-unavailable' };
  if (snapshot.sessionId !== sessionId) return { allowed: false, reason: 'scope-mismatch' };
  const isOwner = caller.accountId === snapshot.ownerAccountId;
  const guest = isOwner ? undefined : snapshot.guests.find((item) =>
    item.accountId === caller.accountId && item.deviceIds.includes(caller.deviceId));
  if (!isOwner && !guest) return { allowed: false, reason: 'not-a-member' };
  const allowed: SharedTaskDecision = {
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
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid sharedTask snapshot');
  return value as Record<string, unknown>;
}

function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new Error('Invalid sharedTask identifier');
  }
  return value;
}

function version(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error('Invalid sharedTask revision');
  }
  return value;
}

/** Validate/project a decoded response; parsing alone does NOT authenticate it. */
export function parseSharedTaskSnapshot(value: unknown): SharedTaskSnapshot {
  const row = record(value);
  const ownerAccountId = identifier(row.ownerAccountId);
  const hostDeviceId = sharedTaskDeviceId(row.hostDeviceId);
  if (row.status !== 'active' && row.status !== 'closed') throw new Error('Invalid sharedTask status');
  if (!Array.isArray(row.guests) || row.guests.length > SHARED_TASK_MAX_SNAPSHOT_GUESTS) {
    throw new Error('Invalid sharedTask guests');
  }
  const accounts = new Set<string>([ownerAccountId]);
  const members = new Set<string>();
  const guests = row.guests.map((value): SharedTaskGrant => {
    const guest = record(value);
    const memberId = identifier(guest.memberId);
    const accountId = identifier(guest.accountId);
    if (accounts.has(accountId) || members.has(memberId)) throw new Error('Duplicate sharedTask member');
    accounts.add(accountId);
    members.add(memberId);
    // Device claims are account-scoped. Two accounts can legitimately report
    // the same deviceId; only the authenticated account+device pair is identity.
    const devices = new Set<string>();
    if (!Array.isArray(guest.deviceIds) || guest.deviceIds.length > 64) throw new Error('Invalid member devices');
    const deviceIds = guest.deviceIds.map((value): string => {
      const deviceId = sharedTaskDeviceId(value);
      if (devices.has(deviceId)) throw new Error('Duplicate sharedTask device');
      devices.add(deviceId);
      return deviceId;
    }).sort();
    return Object.freeze({ memberId, accountId, version: version(guest.version), deviceIds: Object.freeze(deviceIds) });
  }).sort((a, b) => a.memberId < b.memberId ? -1 : a.memberId > b.memberId ? 1 : 0);
  return Object.freeze({
    sharedTaskId: identifier(row.sharedTaskId), sessionId: identifier(row.sessionId),
    ownerAccountId, hostDeviceId, revision: version(row.revision), status: row.status,
    guests: Object.freeze(guests),
  });
}
