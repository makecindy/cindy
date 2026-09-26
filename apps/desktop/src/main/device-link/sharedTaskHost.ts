import { withTaskMigrationWrite } from '../task-migration/writeBoundary.js';
import {
  parseSharedTaskSnapshot, parseSharedTaskPeer, type SharedTaskApi, type SharedTaskCaller,
  type SharedTaskDetail, type SharedTaskIdentity, type SharedTaskQueueItem,
} from '@cindy/device-link';
import type { SharedTaskJournal } from '../localDb/sharedTasks.js';
import { isIpcError } from '../../shared/ipc-errors.js';
import { SharedTaskAccess } from './sharedTaskAccess.js';

interface HostedSharedTask {
  identity: SharedTaskIdentity;
  access: SharedTaskAccess;
  detail: SharedTaskDetail | null;
}
/** Lifecycle bookkeeping survives same-profile runtime replacement; grants do not. */
export interface SharedTaskCreationState {
  pending: Map<Promise<unknown>, string>;
  identities: Map<string, SharedTaskIdentity>;
  closedSessions?: Set<string>;
  sessionGenerations?: Map<string, number>;
  taskClosures?: Map<string, Promise<string[]>>;
}
export interface SharedTaskHostOptions {
  api: SharedTaskApi;
  journal: SharedTaskJournal;
  ownerAccountId: string;
  hostDeviceId: string;
  creationState?: SharedTaskCreationState;
  /** Bound at construction to this profile/auth/region generation. */
  isCurrent(): boolean;
  readSession(sessionId: string): Promise<{ id: string; title: string; status: string } | null>;
  /** Teardown only the affected sharedTask/member, not the shared relay connection. */
  revoke(sharedTaskId: string, memberId?: string): void;
  changed(sharedTaskId: string): void;
}

/** One task-hosting Desktop generation. Never grants access from disk alone. */
export class SharedTaskHost {
  private disposed = false;
  private boundaryClosed = false;
  private readonly closedSessions: Set<string>;
  private readonly sessionGenerations: Map<string, number>;
  private readonly taskClosures: Map<string, Promise<string[]>>;
  private readonly creating: SharedTaskCreationState['pending'];
  private readonly created: SharedTaskCreationState['identities'];
  private readonly entries = new Map<string, HostedSharedTask>();
  private readonly closed = new Set<string>();
  private readonly chains = new Map<string, Promise<unknown>>();
  // Keep failed writes too: disposal must not report durability after a disk error.
  private readonly closeWrites = new Map<string, Promise<void>>();
  private readonly reconciliation = new Map<string, Map<string, () => void>>();
  constructor(private readonly options: SharedTaskHostOptions) {
    const lifecycle: SharedTaskCreationState = options.creationState ?? { pending: new Map(), identities: new Map() };
    this.creating = lifecycle.pending;
    this.created = lifecycle.identities;
    this.closedSessions = lifecycle.closedSessions ??= new Set();
    this.sessionGenerations = lifecycle.sessionGenerations ??= new Map();
    this.taskClosures = lifecycle.taskClosures ??= new Map();
  }

  private assertCurrent(): void {
    if (this.disposed || this.boundaryClosed || !this.options.isCurrent()) throw new Error('SharedTask host generation changed');
  }
  private assertSessionGeneration(sessionId: string, generation: number): void {
    this.assertCurrent();
    if ((this.sessionGenerations.get(sessionId) ?? 0) !== generation) throw new Error('Shared task was closed');
  }
  private assertSessionOpen(sessionId: string, generation = this.sessionGenerations.get(sessionId) ?? 0): void {
    this.assertSessionGeneration(sessionId, generation);
    if (this.closedSessions.has(sessionId)) throw new Error('Shared task was closed');
  }
  private requireEntry(sharedTaskId: string): HostedSharedTask {
    this.assertCurrent();
    const entry = this.entries.get(sharedTaskId);
    if (!entry || this.closed.has(sharedTaskId)) throw new Error('SharedTask is not active here');
    return entry;
  }
  private serial<T>(sharedTaskId: string, work: () => Promise<T>): Promise<T> {
    const result = (this.chains.get(sharedTaskId) ?? Promise.resolve()).catch(() => undefined).then(() => {
      this.assertCurrent();
      return work();
    });
    this.chains.set(sharedTaskId, result);
    void result.finally(() => { if (this.chains.get(sharedTaskId) === result) this.chains.delete(sharedTaskId); }).catch(() => undefined);
    return result;
  }
  private async accept(detail: SharedTaskDetail, generation: number): Promise<void> {
    return withTaskMigrationWrite(detail.sessionId, () => this.acceptWritable(detail, generation));
  }
  private async acceptWritable(detail: SharedTaskDetail, generation: number): Promise<void> {
    this.assertCurrent();
    const snapshot = parseSharedTaskSnapshot(detail);
    this.assertSessionOpen(snapshot.sessionId, generation);
    if (snapshot.ownerAccountId !== this.options.ownerAccountId || snapshot.hostDeviceId !== this.options.hostDeviceId) throw new Error('SharedTask is not hosted by this device');
    if (this.closed.has(snapshot.sharedTaskId)) throw new Error('SharedTask is closed locally');
    const session = await this.options.readSession(snapshot.sessionId);
    this.assertSessionOpen(snapshot.sessionId, generation);
    if (!session || session.id !== snapshot.sessionId || session.status !== 'active') throw new Error('SharedTask task is unavailable');
    const persisted = (await this.options.journal.latest()).find((item) => item.sharedTaskId === snapshot.sharedTaskId);
    this.assertSessionOpen(snapshot.sessionId, generation);
    if (persisted?.terminal || this.closed.has(snapshot.sharedTaskId)) throw new Error('SharedTask is closed locally');
    if (persisted?.snapshot) {
      const check = new SharedTaskAccess(persisted.snapshot);
      check.applyVerifiedSnapshot(persisted.snapshot);
      check.applyVerifiedSnapshot(snapshot);
      if (persisted.snapshot.revision > snapshot.revision) return;
    }
    let entry = this.entries.get(snapshot.sharedTaskId);
    if (entry) {
      // Validate before writing a conflicting identity/revision into the journal.
      for (const key of ['sharedTaskId', 'sessionId', 'ownerAccountId', 'hostDeviceId'] as const) {
        if (entry.identity[key] !== snapshot[key]) throw new Error('SharedTask scope changed');
      }
    }
    await this.options.journal.recordAuthority(snapshot);
    this.assertSessionOpen(snapshot.sessionId, generation);
    if (this.closed.has(snapshot.sharedTaskId)) return;
    // A local close could have been persisted by another host callback while
    // this write awaited; never treat a rejected insert as permission to grant.
    const latest = (await this.options.journal.latest()).find((item) => item.sharedTaskId === snapshot.sharedTaskId);
    this.assertSessionOpen(snapshot.sessionId, generation);
    if (!latest || latest.terminal && snapshot.status !== 'closed' || this.closed.has(snapshot.sharedTaskId)) return;
    if (!latest.snapshot || latest.snapshot.revision !== snapshot.revision) return;
    if (!entry) {
      entry = { identity: snapshot, access: new SharedTaskAccess(snapshot), detail: null };
      this.entries.set(snapshot.sharedTaskId, entry);
    }
    if (entry.access.applyVerifiedSnapshot(snapshot) || entry.detail === null) {
      for (const previous of entry.detail?.guests ?? []) {
        const current = snapshot.guests.find((guest) => guest.memberId === previous.memberId);
        // Adding another device invalidates old captures via member version,
        // but does not revoke the existing devices or their subscriptions.
        if (!current || previous.deviceIds.some((id) => !current.deviceIds.includes(id))) {
          this.options.revoke(snapshot.sharedTaskId, previous.memberId);
        }
      }
      entry.detail = detail;
      if (snapshot.status === 'closed') {
        entry.access.close();
        this.closed.add(snapshot.sharedTaskId);
        this.options.revoke(snapshot.sharedTaskId);
      }
      this.options.changed(snapshot.sharedTaskId);
    }
  }
  private async refreshNow(sharedTaskId: string): Promise<void> {
    this.assertCurrent();
    const generations = new Map(this.sessionGenerations);
    const detail = await this.options.api.get(sharedTaskId);
    await this.accept(detail, generations.get(detail.sessionId) ?? 0);
    for (const release of this.reconciliation.get(sharedTaskId)?.values() ?? []) release();
    this.reconciliation.delete(sharedTaskId);
  }
  refresh(sharedTaskId: string): Promise<void> { return this.serial(sharedTaskId, () => this.refreshNow(sharedTaskId)); }

  async open(sessionId: string): Promise<string> {
    this.assertCurrent();
    const generation = this.sessionGenerations.get(sessionId) ?? 0;
    return withTaskMigrationWrite(sessionId, () => this.openWritable(sessionId, generation));
  }
  private async openWritable(sessionId: string, generation: number): Promise<string> {
    this.assertSessionGeneration(sessionId, generation);
    // An explicit open may re-share an unarchived task, only after the prior
    // boundary has drained its creates and made their closures durable.
    await this.taskClosures.get(sessionId);
    this.assertSessionGeneration(sessionId, generation);
    const session = await this.options.readSession(sessionId);
    this.assertSessionGeneration(sessionId, generation);
    if (!session || session.id !== sessionId || session.status !== 'active') throw new Error('SharedTask task is unavailable');
    const journal = await this.options.journal.latest();
    this.assertSessionGeneration(sessionId, generation);
    // Server create is idempotent for an active task: close the previous IDs
    // first, including closures inherited from another runtime or restart.
    for (const item of journal) {
      if (item.sessionId !== sessionId || !item.terminal) continue;
      await this.options.api.close(item.sharedTaskId);
      this.assertSessionGeneration(sessionId, generation);
    }
    this.closedSessions.delete(sessionId);
    this.assertSessionOpen(sessionId, generation);
    const rememberCreated = (sharedTaskId: string) => {
      this.created.set(sharedTaskId, { sharedTaskId, sessionId, ownerAccountId: this.options.ownerAccountId, hostDeviceId: this.options.hostDeviceId });
    };
    const creating = this.options.api.create(sessionId, session.title, rememberCreated);
    this.creating.set(creating, sessionId);
    let created: Awaited<typeof creating>;
    try {
      created = await creating;
      rememberCreated(created.sharedTaskId);
    } finally { this.creating.delete(creating); }
    if (this.boundaryClosed || this.closedSessions.has(sessionId)) {
      // The boundary drains this request, journals the identity and closes it
      // using outgoing credentials. Ordinary API scopes are already fenced.
      throw new Error('Shared task was closed');
    }
    this.assertSessionOpen(sessionId, generation);
    // Already inside the session boundary; do not wait for a refresh chain
    // that may itself be waiting to acquire that boundary.
    const verified = await this.options.api.get(created.sharedTaskId);
    if (verified.sessionId !== sessionId) throw new Error('SharedTask task does not match');
    await this.acceptWritable(verified, generation);
    const detail = this.entries.get(created.sharedTaskId)?.detail;
    if (!detail || detail.sessionId !== sessionId || detail.status !== 'active') throw new Error('SharedTask could not be opened');
    return created.sharedTaskId;
  }

  private revokeLocally(sharedTaskId: string): void {
    const alreadyClosed = this.closed.has(sharedTaskId);
    this.closed.add(sharedTaskId);
    const entry = this.entries.get(sharedTaskId);
    entry?.access.close();
    if (entry?.detail) entry.detail = Object.freeze({ ...entry.detail, status: 'closed' });
    if (!alreadyClosed) {
      this.options.revoke(sharedTaskId);
      this.options.changed(sharedTaskId);
    }
  }

  async restore(allowNetwork = true): Promise<void> {
    this.assertCurrent();
    const journal = await this.options.journal.latest();
    this.assertCurrent();
    // Shared profile writers hand off terminal changes through the journal.
    // Close access objects as well as the index so existing captures also expire.
    for (const item of journal) if (item.terminal) this.revokeLocally(item.sharedTaskId);
    const sessions = new Set([...this.entries.values()].map((entry) => entry.identity.sessionId));
    for (const identity of this.created.values()) sessions.add(identity.sessionId);
    for (const sessionId of this.creating.values()) sessions.add(sessionId);
    for (const sessionId of sessions) {
      const session = await this.options.readSession(sessionId);
      this.assertCurrent();
      if ((!session || session.status !== 'active') && !this.closedSessions.has(sessionId)) {
        await this.closeLocallyForBoundary(sessionId);
        this.assertCurrent();
      }
    }
    if (!allowNetwork) return;
    const active = await this.options.api.list();
    this.assertCurrent();
    const owned = active.filter((item) => item.ownerAccountId === this.options.ownerAccountId && item.hostDeviceId === this.options.hostDeviceId);
    for (const item of journal) {
      if (item.terminal) this.closed.add(item.sharedTaskId);
      else if (item.snapshot && !owned.some((sharedTask) => sharedTask.sharedTaskId === item.sharedTaskId)) {
        this.closed.add(item.sharedTaskId);
        this.entries.get(item.sharedTaskId)?.access.close();
        this.options.revoke(item.sharedTaskId);
        await this.options.journal.close(item.snapshot);
        this.assertCurrent();
      }
    }
    for (const item of owned) {
      this.assertCurrent();
      // Covers a create that reached the server but was never accepted/journaled
      // here, and a terminal write made by a different process before startup.
      const session = await this.options.readSession(item.sessionId);
      this.assertCurrent();
      if (!session || session.status !== 'active') {
        this.revokeLocally(item.sharedTaskId);
        await this.options.journal.close(item);
        this.assertCurrent();
      }
      if (this.closed.has(item.sharedTaskId)) {
        // Retry a previous explicit close that was persisted before connectivity
        // failed. A process restart itself never closes an active sharedTask.
        await this.options.api.close(item.sharedTaskId);
      } else await this.refresh(item.sharedTaskId);
    }
  }

  detail(sharedTaskId: string): SharedTaskDetail | null {
    this.assertCurrent();
    return this.entries.get(sharedTaskId)?.detail ?? null;
  }
  authorize(sharedTaskId: string, caller: SharedTaskCaller, sessionId: string, operation: string, queueItem?: SharedTaskQueueItem) {
    if (this.disposed || !this.options.isCurrent() || this.closed.has(sharedTaskId)) return { allowed: false as const, reason: 'sharedTask-unavailable' as const };
    return this.entries.get(sharedTaskId)?.access.authorize(caller, sessionId, operation, queueItem) ?? { allowed: false as const, reason: 'sharedTask-unavailable' as const };
  }

  invite(sharedTaskId: string) {
    return this.serial(sharedTaskId, async () => {
      this.requireEntry(sharedTaskId);
      const invitation = await this.options.api.invite(sharedTaskId);
      this.assertCurrent();
      return invitation;
    });
  }
  remove(sharedTaskId: string, memberId: string): Promise<void> {
    const release = this.requireEntry(sharedTaskId).access.suspendMember(memberId);
    // Suspend host reads/writes immediately. A failed request can leave this
    // member authorized, so send permanent revocation only from fresh authority.
    return this.serial(sharedTaskId, async () => {
      let missingMember: Error | undefined;
      try {
        this.requireEntry(sharedTaskId);
        await this.options.api.remove(sharedTaskId, memberId);
      } catch (error) {
        if (!isIpcError(error) || error.code !== 'NOT_FOUND') throw error;
        missingMember = error;
      } finally {
        // On an ambiguous timeout, regain permission only from a fresh authority
        // response. If reconciliation also fails, this member stays suspended.
        try {
          await this.refreshNow(sharedTaskId);
          release();
        } catch (error) {
          let pending = this.reconciliation.get(sharedTaskId);
          if (!pending) this.reconciliation.set(sharedTaskId, pending = new Map());
          const previous = pending.get(memberId);
          pending.set(memberId, () => { previous?.(); release(); });
          throw error;
        }
      }
      if (missingMember) {
        // A guest may leave while the owner confirms removal. Only a verified,
        // still-active task with that member absent makes removal complete.
        const detail = this.detail(sharedTaskId);
        if (detail?.status !== 'active' || detail.guests.some((guest) => guest.memberId === memberId)) {
          throw missingMember;
        }
      }
    });
  }
  close(sharedTaskId: string): Promise<void> {
    this.assertCurrent();
    const entry = this.entries.get(sharedTaskId);
    if (!entry) throw new Error('SharedTask is not hosted here');
    this.closed.add(sharedTaskId);
    entry.access.close();
    if (entry.detail) entry.detail = Object.freeze({ ...entry.detail, status: 'closed' });
    // Start the profile-bound write before callbacks can dispose this host. It
    // must not queue behind HTTP or be cancelled by an account generation check.
    const persisted = this.options.journal.close(entry.identity);
    this.closeWrites.set(sharedTaskId, persisted);
    const closing = persisted.then(async () => {
      this.assertCurrent();
      await this.options.api.close(sharedTaskId);
    });
    this.options.revoke(sharedTaskId);
    this.options.changed(sharedTaskId);
    return closing;
  }
  /** A temporary authority fence is not evidence that membership was revoked. */
  peerStatus(source: string): 'available' | 'unavailable' | 'revoked' {
    const peer = parseSharedTaskPeer(source);
    if (!peer || peer.role !== 'guest') return 'revoked';
    if (this.closed.has(peer.sharedTaskId)) return 'revoked';
    if (this.disposed || !this.options.isCurrent()) return 'unavailable';
    const entry = this.entries.get(peer.sharedTaskId);
    if (!entry?.detail) return 'unavailable';
    if (this.boundaryClosed || this.closedSessions.has(entry.identity.sessionId)) return 'revoked';
    const member = entry.detail.guests.find((guest) => guest.memberId === peer.memberId);
    if (!member || !member.deviceIds.includes(peer.deviceId)) return 'revoked';
    return entry.access.authorize({ accountId: member.accountId, deviceId: peer.deviceId },
      entry.identity.sessionId, 'history.read').allowed ? 'available' : 'unavailable';
  }

  /** Only resolve relay-stamped logical peers against verified host authority. */
  capturePeer(source: string) {
    const peer = parseSharedTaskPeer(source);
    if (!peer || peer.role !== 'guest' || this.disposed || !this.options.isCurrent()) return null;
    const entry = this.entries.get(peer.sharedTaskId);
    const member = entry?.detail?.guests.find((guest) => guest.memberId === peer.memberId);
    if (!entry || !member || this.closed.has(peer.sharedTaskId)) return null;
    const caller = Object.freeze({ accountId: member.accountId, deviceId: peer.deviceId });
    const captured = entry.access.capture(caller, entry.identity.sessionId, 'history.read');
    if (!captured.decision.allowed) return null;
    const author = Object.freeze({
      sharedTaskId: peer.sharedTaskId, sessionId: entry.identity.sessionId,
      memberId: member.memberId, accountId: member.accountId,
      displayName: entry.detail!.memberLabels.find((label) => label.memberId === member.memberId)?.displayName ?? member.accountId,
    });
    const isCurrent = () => !this.disposed && this.options.isCurrent() && captured.isCurrent();
    return {
      author, isCurrent,
      authorize: (operation: string, queueItem?: SharedTaskQueueItem) =>
        isCurrent() && entry.access.authorize(caller, author.sessionId, operation, queueItem).allowed,
    };
  }

  activeSharedTaskIds(): string[] {
    this.assertCurrent();
    return [...this.entries].filter(([id, entry]) => !this.closed.has(id) && entry.detail?.status === 'active').map(([id]) => id);
  }

  /** Account teardown has already fenced network scopes. Durability must not depend on them. */
  closeLocallyForBoundary(sessionId?: string): Promise<string[]> {
    // Fence in-flight accept/open before the first journal await.
    if (sessionId) {
      this.closedSessions.add(sessionId);
      this.sessionGenerations.set(sessionId, (this.sessionGenerations.get(sessionId) ?? 0) + 1);
    }
    else this.boundaryClosed = true;
    let closing = this.persistBoundaryClosure(sessionId);
    if (sessionId) {
      const previous = this.taskClosures.get(sessionId);
      if (previous) closing = Promise.all([previous, closing]).then((lists) => [...new Set(lists.flat())]);
      this.taskClosures.set(sessionId, closing);
    }
    return closing;
  }

  private async persistBoundaryClosure(sessionId?: string): Promise<string[]> {
    const identities = new Map<string, SharedTaskIdentity>();
    for (const [id, entry] of this.entries) {
      if (sessionId && entry.identity.sessionId !== sessionId) continue;
      identities.set(id, entry.identity);
      this.closed.add(id);
      entry.access.close();
      if (entry.detail) entry.detail = Object.freeze({ ...entry.detail, status: 'closed' });
      this.options.revoke(id);
      this.options.changed(id);
    }
    // Keep the outgoing profile alive through the existing bounded create
    // requests. Their response observer runs before stale-scope rejection.
    await Promise.allSettled([...this.creating].filter(([, sid]) => !sessionId || sid === sessionId).map(([pending]) => pending));
    if (!sessionId) await Promise.all(this.taskClosures.values());
    for (const [id, identity] of this.created) {
      if (sessionId && identity.sessionId !== sessionId) continue;
      identities.set(id, identity);
      this.closed.add(id);
    }
    // Also close sharedTasks not restored yet (e.g. logout during authority fetch).
    for (const item of await this.options.journal.latest()) {
      if (item.terminal || !item.snapshot || sessionId && item.sessionId !== sessionId) continue;
      if (item.snapshot.ownerAccountId !== this.options.ownerAccountId || item.snapshot.hostDeviceId !== this.options.hostDeviceId) continue;
      identities.set(item.sharedTaskId, item.snapshot);
      this.closed.add(item.sharedTaskId);
    }
    for (const [id, identity] of identities) {
      const write = this.options.journal.close(identity);
      this.closeWrites.set(id, write);
      await write;
    }
    return [...identities.keys()];
  }

  /**
   * Revokes synchronously. Await before releasing the old profile database or
   * replacing this host; only local close writes drain, never HTTP requests.
   * App exit itself does not close active sharedTasks.
   */
  async dispose(): Promise<void> {
    this.disposed = true;
    for (const [sharedTaskId, entry] of this.entries) {
      entry.access.close();
      this.options.revoke(sharedTaskId);
    }
    this.entries.clear();
    const writes = await Promise.allSettled(this.closeWrites.values());
    for (const write of writes) if (write.status === 'rejected') throw write.reason;
  }
}
