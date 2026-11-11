import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { AppError, conflict, invalidParams, notFound, permissionDenied } from './errors.js';

const MAX_SHARED_TASKS = 5;
const MAX_JOINED_SHARED_TASKS = 5;
const MAX_GUESTS = 2;

/** Identity supplied exclusively by the verified access-token adapter. */
export interface SharedTaskActor { accountId: string; deviceId: string }
export interface SharedTaskGuest {
  memberId: string;
  accountId: string;
  displayName: string;
  deviceIds: string[];
  status: 'joined' | 'left' | 'removed';
  version: number;
  joinedAt: number | null;
  blockedThroughInviteSequence: number;
}
export interface StoredSharedTask {
  sharedTaskId: string;
  sessionId: string;
  ownerAccountId: string;
  hostDeviceId: string;
  title: string;
  status: 'active' | 'closed';
  revision: number;
  inviteSequence: number;
  guests: SharedTaskGuest[];
}
export interface StoredSharedTaskInvitation {
  digest: string;
  sharedTaskId: string;
  ownerAccountId: string;
  sequence: number;
}
export interface SharedTaskTransaction {
  get(sharedTaskId: string): Promise<StoredSharedTask | null>;
  listActive(): Promise<StoredSharedTask[]>;
  countJoinedActive(): Promise<number>;
  save(sharedTask: StoredSharedTask): Promise<void>;
  invite(invitation: StoredSharedTaskInvitation): Promise<void>;
}
export interface SharedTaskRepository {
  listActivePage(afterId: string | undefined, limit: number): Promise<Pick<StoredSharedTask, 'sharedTaskId' | 'ownerAccountId' | 'hostDeviceId'>[]>;
  find(sharedTaskId: string): Promise<StoredSharedTask | null>;
  findInvitation(digest: string): Promise<StoredSharedTaskInvitation | null>;
  listForActor(actor: SharedTaskActor): Promise<StoredSharedTask[]>;
  /** Serializes every mutation for an owner across all server instances. */
  transaction<T>(ownerAccountId: string, work: (tx: SharedTaskTransaction) => Promise<T>, guestAccountId?: string): Promise<T>;
}

const id = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw invalidParams('Invalid identifier');
  return value;
};
const label = (value: unknown): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > 128 || /[\u0000-\u001f\u007f]/.test(value)) throw invalidParams('Invalid display name');
  return value.trim();
};
function validateActor(actor: SharedTaskActor): void {
  id(actor.accountId);
  // Device claims follow auth-server's 1..128 string contract, not internal IDs.
  if (typeof actor.deviceId !== 'string' || actor.deviceId.length < 1 || actor.deviceId.length > 128) {
    throw invalidParams('Invalid device identifier');
  }
}
const digest = (token: string) => createHash('sha256').update(token).digest('hex');

/**
 * SharedTask lifecycle and account-scoped membership. The transport stays disabled
 * until the host can enforce task/tool boundaries; CRUD never grants full-device
 * access. Tokens are returned once, only their digest is stored.
 */
export function createSharedTaskService(repo: SharedTaskRepository, now: () => number = Date.now) {
  async function modify<T>(actor: SharedTaskActor, sharedTaskId: string, work: (sharedTask: StoredSharedTask, tx: SharedTaskTransaction) => Promise<T>, guestAccountId?: string): Promise<T> {
    validateActor(actor);
    const located = await repo.find(id(sharedTaskId));
    if (!located) throw notFound();
    return repo.transaction(located.ownerAccountId, async (tx) => {
      const sharedTask = await tx.get(sharedTaskId);
      if (!sharedTask || sharedTask.status !== 'active') throw notFound();
      return work(sharedTask, tx);
    }, guestAccountId);
  }
  function owner(actor: SharedTaskActor, sharedTask: StoredSharedTask): void {
    if (actor.accountId !== sharedTask.ownerAccountId) throw permissionDenied();
  }
  function attachDevice(member: SharedTaskGuest, deviceId: string): void {
    if (member.deviceIds.includes(deviceId)) return;
    if (member.deviceIds.length >= 64) throw conflict('Too many member devices');
    member.deviceIds.push(deviceId);
    member.version++;
  }
  async function save(tx: SharedTaskTransaction, sharedTask: StoredSharedTask): Promise<void> {
    sharedTask.revision++;
    await tx.save(sharedTask);
  }

  return {
    async create(actor: SharedTaskActor, sessionId: string, title: string) {
      validateActor(actor); id(sessionId); label(title);
      return repo.transaction(actor.accountId, async (tx) => {
        const active = await tx.listActive();
        const existing = active.find((item) => item.sessionId === sessionId && item.hostDeviceId === actor.deviceId);
        if (existing) return existing;
        if (active.length >= MAX_SHARED_TASKS) {
          throw new AppError('SHARED_TASK_HOST_LIMIT', 409, 'Hosted shared task limit reached');
        }
        const sharedTask: StoredSharedTask = {
          sharedTaskId: randomUUID(), sessionId, ownerAccountId: actor.accountId, hostDeviceId: actor.deviceId,
          title: label(title), status: 'active', revision: 1, inviteSequence: 0, guests: [],
        };
        await tx.save(sharedTask);
        return sharedTask;
      });
    },
    async invite(actor: SharedTaskActor, sharedTaskId: string) {
      return modify(actor, sharedTaskId, async (sharedTask, tx) => {
        owner(actor, sharedTask);
        const token = randomBytes(32).toString('base64url');
        sharedTask.inviteSequence++;
        await tx.invite({ digest: digest(token), sharedTaskId, ownerAccountId: sharedTask.ownerAccountId, sequence: sharedTask.inviteSequence });
        await save(tx, sharedTask);
        return { sharedTaskId, invitation: token };
      });
    },
    async join(actor: SharedTaskActor, invitation: string, displayName: string) {
      validateActor(actor); label(displayName);
      if (typeof invitation !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(invitation)) throw notFound();
      const invite = await repo.findInvitation(digest(invitation));
      if (!invite) throw notFound();
      return modify(actor, invite.sharedTaskId, async (sharedTask, tx) => {
        if (actor.accountId === sharedTask.ownerAccountId) {
          throw new AppError('SHARED_TASK_SELF_JOIN', 409, 'Use existing same-account device control');
        }
        let member = sharedTask.guests.find((item) => item.accountId === actor.accountId);
        if (member && invite.sequence <= member.blockedThroughInviteSequence) throw permissionDenied('A new invitation is required');
        if (member?.status === 'joined') {
          const version = member.version;
          attachDevice(member, actor.deviceId);
          if (version !== member.version) await save(tx, sharedTask);
          return { sharedTaskId: sharedTask.sharedTaskId, memberId: member.memberId, status: member.status, created: false };
        }
        if (sharedTask.guests.filter((item) => item.status === 'joined').length >= MAX_GUESTS) {
          throw new AppError('SHARED_TASK_GUEST_LIMIT', 409, 'At most two guests per shared task');
        }
        if (await tx.countJoinedActive() >= MAX_JOINED_SHARED_TASKS) {
          throw new AppError('SHARED_TASK_JOIN_LIMIT', 409, 'Joined shared task limit reached');
        }
        const blockedThroughInviteSequence = member?.blockedThroughInviteSequence ?? 0;
        sharedTask.guests = sharedTask.guests.filter((item) => item.accountId !== actor.accountId);
        member = {
          memberId: randomUUID(), accountId: actor.accountId, displayName: label(displayName), deviceIds: [actor.deviceId],
          status: 'joined', version: 1, joinedAt: now(), blockedThroughInviteSequence,
        };
        sharedTask.guests.push(member);
        await save(tx, sharedTask);
        return { sharedTaskId: sharedTask.sharedTaskId, memberId: member.memberId, status: member.status, created: true };
      }, actor.accountId);
    },
    async depart(actor: SharedTaskActor, sharedTaskId: string, memberId?: string) {
      if (memberId !== undefined) id(memberId);
      return modify(actor, sharedTaskId, async (sharedTask, tx) => {
        if (memberId !== undefined) owner(actor, sharedTask);
        const member = sharedTask.guests.find((item) => memberId === undefined ? item.accountId === actor.accountId : item.memberId === memberId);
        if (!member || member.status !== 'joined') throw notFound();
        member.status = memberId === undefined ? 'left' : 'removed';
        member.blockedThroughInviteSequence = sharedTask.inviteSequence;
        member.deviceIds = [];
        member.version++;
        await save(tx, sharedTask);
        return { memberId: member.memberId, status: member.status };
      });
    },
    async close(actor: SharedTaskActor, sharedTaskId: string) {
      validateActor(actor);
      const located = await repo.find(id(sharedTaskId));
      if (!located) throw notFound();
      return repo.transaction(located.ownerAccountId, async (tx) => {
        const sharedTask = await tx.get(sharedTaskId);
        if (!sharedTask) throw notFound();
        owner(actor, sharedTask);
        if (sharedTask.status !== 'closed') {
          sharedTask.status = 'closed';
          await save(tx, sharedTask);
        }
        return { sharedTaskId, status: sharedTask.status };
      });
    },
    /** Close every active sharedTask hosted by one physical device.
     *
     * This is used by the relay when a host device connection is gone. The
     * owner-scoped transaction keeps the operation serialized with create,
     * join, and explicit close, so guest capacity is released atomically.
     */
    async closeHostedByDevice(actor: SharedTaskActor, isOffline: () => Promise<boolean> = async () => true, sharedTaskIds?: readonly string[]) {
      validateActor(actor);
      return repo.transaction(actor.accountId, async (tx) => {
        const hosted = (await tx.listActive()).filter((sharedTask) => sharedTask.hostDeviceId === actor.deviceId
          && (!sharedTaskIds || sharedTaskIds.includes(sharedTask.sharedTaskId)));
        // Recheck after waiting for the owner lock. A reconnect or new share
        // must not be closed by a delayed cleanup of an older connection.
        if (hosted.length === 0 || !await isOffline()) return [];
        for (const sharedTask of hosted) {
          sharedTask.status = 'closed';
          await save(tx, sharedTask);
        }
        return hosted.map((sharedTask) => sharedTask.sharedTaskId);
      });
    },
    async get(actor: SharedTaskActor, sharedTaskId: string) {
      validateActor(actor);
      const sharedTask = await repo.find(id(sharedTaskId));
      if (!sharedTask) throw notFound();
      const isOwner = sharedTask.ownerAccountId === actor.accountId;
      const membership = sharedTask.guests.find((item) => item.accountId === actor.accountId);
      if (!isOwner && (sharedTask.status !== 'active' || membership?.status !== 'joined')) throw notFound();
      return {
        sharedTaskId: sharedTask.sharedTaskId, sessionId: sharedTask.sessionId, ownerAccountId: sharedTask.ownerAccountId,
        hostDeviceId: sharedTask.hostDeviceId, revision: sharedTask.revision, status: sharedTask.status, title: sharedTask.title,
        guests: sharedTask.guests.filter((item) => item.status === 'joined').map((item) => ({
          memberId: item.memberId, accountId: item.accountId, version: item.version, deviceIds: [...item.deviceIds],
          displayName: item.displayName, joinedAt: item.joinedAt,
        })),
      };
    },
    /** First-hop link-open only. Account membership grants admission; device
     * bindings remain the transport allowlist. Never revive a departed member
     * or attach an old request to a replacement membership after rejoining. */
    async connectDevice(actor: SharedTaskActor, sharedTaskId: string, memberId: string, hostDeviceId: string) {
      validateActor(actor);
      const located = await repo.find(id(sharedTaskId));
      if (!located) return null;
      return repo.transaction(located.ownerAccountId, async (tx) => {
        const sharedTask = await tx.get(sharedTaskId);
        if (!sharedTask || sharedTask.status !== 'active' || sharedTask.hostDeviceId !== hostDeviceId) return null;
        const member = sharedTask.guests.find((item) => item.accountId === actor.accountId &&
          item.memberId === memberId && item.status === 'joined');
        if (!member) return null;
        if (!member.deviceIds.includes(actor.deviceId)) {
          if (member.deviceIds.length >= 64) return null;
          attachDevice(member, actor.deviceId);
          await save(tx, sharedTask);
        }
        return sharedTask;
      });
    },
    async list(actor: SharedTaskActor) {
      validateActor(actor);
      return (await repo.listForActor(actor)).filter((sharedTask) => sharedTask.status === 'active' && (
        sharedTask.ownerAccountId === actor.accountId || sharedTask.guests.some((member) =>
          member.accountId === actor.accountId && member.status === 'joined')
      )).map((sharedTask) => ({
        sharedTaskId: sharedTask.sharedTaskId, sessionId: sharedTask.sessionId, hostDeviceId: sharedTask.hostDeviceId,
        ownerAccountId: sharedTask.ownerAccountId, title: sharedTask.title, revision: sharedTask.revision,
      }));
    },
  };
}

export type SharedTaskService = ReturnType<typeof createSharedTaskService>;
