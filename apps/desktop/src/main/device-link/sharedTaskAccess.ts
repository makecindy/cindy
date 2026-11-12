import {
  authorizeSharedTaskOperation,
  parseSharedTaskSnapshot,
  type SharedTaskCaller,
  type SharedTaskDecision,
  type SharedTaskIdentity,
  type SharedTaskQueueItem,
  type SharedTaskSnapshot,
} from '@cindy/device-link';

/**
 * Per-sharedTask authority mirror owned by the task host. It contains no network or
 * persistence: only the authenticated authority adapter may install snapshots.
 * A replacement account/sharedTask must get a new instance; queued callbacks keep
 * the old instance and therefore cannot regain permission after close().
 */
export class SharedTaskAccess {
  private readonly identity: Readonly<SharedTaskIdentity>;
  private snapshot: SharedTaskSnapshot | null = null;
  private closed = false;
  private readonly retiredMemberIds = new Set<string>();
  private readonly suspendedMembers = new Map<string, number>();

  constructor(identity: SharedTaskIdentity) {
    this.identity = Object.freeze({ ...identity });
  }

  /** Returns false for a stale revision. Conflicting identities/revisions fail closed. */
  applyVerifiedSnapshot(value: unknown): boolean {
    const next = parseSharedTaskSnapshot(value);
    for (const key of ['sharedTaskId', 'sessionId', 'ownerAccountId', 'hostDeviceId'] as const) {
      if (next[key] !== this.identity[key]) throw new Error('SharedTask authority scope mismatch');
    }
    if (this.closed) return false;
    if (this.snapshot) {
      if (next.revision < this.snapshot.revision) return false;
      if (next.revision === this.snapshot.revision) {
        if (JSON.stringify(next) !== JSON.stringify(this.snapshot)) throw new Error('Conflicting sharedTask revision');
        return false;
      }
      if (this.snapshot.status === 'closed') throw new Error('Closed sharedTask cannot reopen');
      for (const guest of next.guests) {
        if (this.retiredMemberIds.has(guest.memberId)) throw new Error('Revoked sharedTask member cannot return');
        const previous = this.snapshot.guests.find((item) => item.memberId === guest.memberId);
        if (previous && (guest.accountId !== previous.accountId || guest.version < previous.version ||
          (guest.version === previous.version && JSON.stringify(guest.deviceIds) !== JSON.stringify(previous.deviceIds)))) {
          throw new Error('Invalid sharedTask member revision');
        }
      }
      for (const previous of this.snapshot.guests) {
        if (!next.guests.some((item) => item.memberId === previous.memberId)) this.retiredMemberIds.add(previous.memberId);
      }
    }
    this.snapshot = next;
    return true;
  }

  authorize(
    caller: SharedTaskCaller, sessionId: string, operation: string,
    queueItem?: SharedTaskQueueItem,
  ): SharedTaskDecision {
    const decision = authorizeSharedTaskOperation(this.closed ? null : this.snapshot, caller, sessionId, operation, queueItem);
    return decision.allowed && decision.role === 'guest' && this.suspendedMembers.has(decision.memberId)
      ? { allowed: false, reason: 'not-a-member' } : decision;
  }

  /** Fence just this member while its removal is being committed/reconciled. */
  suspendMember(memberId: string): () => void {
    this.suspendedMembers.set(memberId, (this.suspendedMembers.get(memberId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = (this.suspendedMembers.get(memberId) ?? 1) - 1;
      if (count === 0) this.suspendedMembers.delete(memberId);
      else this.suspendedMembers.set(memberId, count);
    };
  }

  /**
   * Recheck after awaits and immediately before delivery or side effects. The
   * queue item must be re-read by the caller too; this is not a queue lock.
   */
  capture(
    caller: SharedTaskCaller, sessionId: string, operation: string,
    readQueueItem?: () => SharedTaskQueueItem | undefined,
  ): { decision: SharedTaskDecision; isCurrent: () => boolean } {
    const actor = { ...caller };
    const decision = this.authorize(actor, sessionId, operation, readQueueItem?.());
    return {
      decision,
      isCurrent: () => {
        if (!decision.allowed) return false;
        const now = this.authorize(actor, sessionId, operation, readQueueItem?.());
        return now.allowed && now.role === decision.role && now.memberId === decision.memberId && now.memberVersion === decision.memberVersion;
      },
    };
  }

  /** Local close/logout prevents late authority replies from reviving access. */
  close(): void {
    this.closed = true;
    this.snapshot = null;
  }
}
