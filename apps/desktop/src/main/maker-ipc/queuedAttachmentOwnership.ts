export type QueuedAttachmentCleanup = () => void | Promise<void>;

export type QueuedAttachmentOwnershipOptions = {
  /**
   * Cleanup for the controller-owned source (for example a remote OSS key).
   * It must not run until the accepted queue item has crossed a durable
   * boundary; explicit discard and a post-snapshot non-retryable persistence
   * failure may run it.
   */
  cleanupAfterDurable?: QueuedAttachmentCleanup;
  /**
   * The local materialisation split per attachment: its host-managed refs
   * (managed URL and absolute path) and the cleanup releasing only it. When
   * given, these replace `cleanup`, so a queue edit can keep the attachments
   * the replacement still carries and release only the ones it dropped.
   */
  parts?: ReadonlyArray<{ refs: readonly string[]; cleanup: QueuedAttachmentCleanup }>;
};

type OwnedAttachment = { refs: ReadonlySet<string>; cleanup: QueuedAttachmentCleanup };

type QueuedAttachmentOwnership = {
  parts: OwnedAttachment[];
  cleanupAfterDurable?: QueuedAttachmentCleanup;
  /**
   * Set once the coordinator accepted this materialisation. A preparation that
   * is still awaiting acceptance belongs to its own handler, which activates or
   * discards it; a superseded-owner discard must leave it alone.
   */
  accepted: boolean;
  durableBoundaryReached: boolean;
  persistenceInFlight: boolean;
  discardRequested: boolean;
};

type QueuedAttachmentClientOwnership = {
  owners: Map<string, QueuedAttachmentOwnership>;
  /** The owner represented by the coordinator's currently accepted item. */
  currentOwnerId: string | null;
};

export type QueuedAttachmentCleanupError = {
  sessionId: string;
  clientId: string;
  error: unknown;
};

/**
 * Owns local files created while a queued remote attachment is being prepared.
 *
 * A clear/stop can race the SQLite insert. Cleanup is immediate while the item
 * is only queued, but becomes deferred once persistence starts: a successful
 * insert transfers ownership to the durable row, while a failed insert may
 * clean only when the item was discarded or will not be retried.
 */
export class QueuedAttachmentOwnershipRegistry {
  private readonly ownership = new Map<
    string,
    Map<string, QueuedAttachmentClientOwnership>
  >();
  private nextOwnerId = 0;

  constructor(private readonly onCleanupError?: (failure: QueuedAttachmentCleanupError) => void) {}

  register(
    sessionId: string,
    clientId: string,
    cleanup: QueuedAttachmentCleanup | undefined,
    options?: QueuedAttachmentOwnershipOptions,
  ): string | null {
    const parts: OwnedAttachment[] = options?.parts?.length
      ? options.parts.map((part) => ({ refs: new Set(part.refs), cleanup: part.cleanup }))
      : cleanup
        ? [{ refs: new Set(), cleanup }]
        : [];
    if (parts.length === 0 && !options?.cleanupAfterDurable) return null;
    let byClient = this.ownership.get(sessionId);
    if (!byClient) {
      byClient = new Map();
      this.ownership.set(sessionId, byClient);
    }
    let clientOwnership = byClient.get(clientId);
    if (!clientOwnership) {
      clientOwnership = { owners: new Map(), currentOwnerId: null };
      byClient.set(clientId, clientOwnership);
    }
    const ownerId = `${clientId}:${++this.nextOwnerId}`;
    clientOwnership.owners.set(ownerId, {
      parts,
      ...(options?.cleanupAfterDurable ? { cleanupAfterDurable: options.cleanupAfterDurable } : {}),
      accepted: false,
      durableBoundaryReached: false,
      persistenceInFlight: false,
      discardRequested: false,
    });
    return ownerId;
  }

  /**
   * Make an accepted materialisation the owner of the coordinator item.
   * Registration happens before acceptance, so a rejected preparation never
   * becomes the current owner.  The previous id is returned for rollback when
   * an async steer is cancelled before acceptance.
   */
  activateCurrentOwner(sessionId: string, clientId: string, ownerId: string): string | null {
    const clientOwnership = this.ownership.get(sessionId)?.get(clientId);
    const owner = clientOwnership?.owners.get(ownerId);
    if (!clientOwnership || !owner) return null;
    owner.accepted = true;
    const previousOwnerId = clientOwnership.currentOwnerId;
    clientOwnership.currentOwnerId = ownerId;
    return previousOwnerId;
  }

  restoreCurrentOwner(sessionId: string, clientId: string, ownerId: string | null): void {
    const clientOwnership = this.ownership.get(sessionId)?.get(clientId);
    if (!clientOwnership) return;
    clientOwnership.currentOwnerId =
      ownerId && clientOwnership.owners.has(ownerId) ? ownerId : null;
  }

  /**
   * Queue edit: move every attachment the replacement still references into
   * one surviving owner, so the caller's later superseded-owner discard
   * releases only the attachments the edit dropped. The survivor is
   * `keepOwnerId` (the edit's own materialisation) or, when the edit created
   * none, the first owner with a referenced attachment. Dropped attachments of
   * a partly kept owner stay behind in a superseded owner. Returns the survivor
   * id, which the caller activates and excludes from its discard.
   */
  retainReferencedOwners(
    sessionId: string,
    clientId: string,
    keepOwnerId: string | null,
    isReferenced: (ref: string) => boolean,
  ): string | null {
    const clientOwnership = this.ownership.get(sessionId)?.get(clientId);
    if (!clientOwnership) return null;
    let survivorId = keepOwnerId && clientOwnership.owners.has(keepOwnerId) ? keepOwnerId : null;
    for (const [ownerId, owner] of [...clientOwnership.owners]) {
      // Another edit's preparation that is not accepted yet is not ours to move.
      if (ownerId === survivorId || !owner.accepted) continue;
      const kept = owner.parts.filter((part) => [...part.refs].some(isReferenced));
      if (kept.length === 0) continue;
      const dropped = owner.parts.filter((part) => !kept.includes(part));
      if (!survivorId) {
        survivorId = ownerId;
        owner.parts = kept;
      } else {
        const survivor = clientOwnership.owners.get(survivorId)!;
        survivor.parts.push(...kept);
        const pendingRemote = owner.durableBoundaryReached ? undefined : owner.cleanupAfterDurable;
        if (pendingRemote) {
          const survivorRemote = survivor.cleanupAfterDurable;
          survivor.cleanupAfterDurable = survivorRemote
            ? async () => {
                await survivorRemote();
                await pendingRemote();
              }
            : pendingRemote;
          // The moved remote source has not been released yet; the caller's
          // next durable mark must run it.
          survivor.durableBoundaryReached = false;
        }
        survivor.persistenceInFlight ||= owner.persistenceInFlight;
        survivor.discardRequested ||= owner.discardRequested;
        clientOwnership.owners.delete(ownerId);
        if (clientOwnership.currentOwnerId === ownerId) clientOwnership.currentOwnerId = survivorId;
      }
      if (dropped.length > 0) {
        // The remote source travels with the kept attachments; only local copies remain here.
        clientOwnership.owners.set(`${clientId}:${++this.nextOwnerId}`, {
          parts: dropped,
          accepted: true,
          durableBoundaryReached: true,
          persistenceInFlight: owner.persistenceInFlight,
          discardRequested: owner.discardRequested,
        });
      }
    }
    return survivorId;
  }

  getCurrentOwnerId(sessionId: string, clientId: string): string | null {
    return this.ownership.get(sessionId)?.get(clientId)?.currentOwnerId ?? null;
  }

  markPersistenceStarted(sessionId: string, clientId: string): void {
    const clientOwnership = this.ownership.get(sessionId)?.get(clientId);
    if (!clientOwnership) return;
    const currentOwner = clientOwnership.currentOwnerId
      ? clientOwnership.owners.get(clientOwnership.currentOwnerId)
      : undefined;
    if (currentOwner) {
      currentOwner.persistenceInFlight = true;
      return;
    }
    // Keep the legacy fail-safe for an item accepted by an older caller that
    // did not stamp its owner: retaining all owners is safer than deleting a
    // local materialisation that may be referenced by the durable row.
    for (const owner of clientOwnership.owners.values()) owner.persistenceInFlight = true;
  }

  async markPersistenceFailed(
    sessionId: string,
    clientId: string,
    opts: { retainForRetry: boolean },
  ): Promise<void> {
    const clientOwnership = this.ownership.get(sessionId)?.get(clientId);
    if (!clientOwnership) return;
    const ownerIds = [...clientOwnership.owners.keys()];
    // A single-owner legacy caller can be inferred safely.  If several owners
    // exist without an activation stamp, retain all of them on a retry rather
    // than guessing which local file the durable row references.
    const currentOwnerId =
      clientOwnership.currentOwnerId ?? (ownerIds.length === 1 ? ownerIds[0] : null);
    const cleanups: QueuedAttachmentCleanup[] = [];
    for (const [ownerId, owner] of clientOwnership.owners) {
      owner.persistenceInFlight = false;
      const isCurrent = ownerId === currentOwnerId;
      // The caller waits for the post-failure queue snapshot before invoking
      // this method.  Every non-current replacement is therefore no longer
      // recoverable from the queue and can be cleaned even when its discard
      // callback was still waiting on that same snapshot.
      if (
        opts.retainForRetry &&
        !owner.discardRequested &&
        (isCurrent || clientOwnership.currentOwnerId === null)
      ) {
        continue;
      }
      clientOwnership.owners.delete(ownerId);
      cleanups.push(...localCleanups(owner));
      if (owner.cleanupAfterDurable && !owner.durableBoundaryReached) {
        cleanups.push(owner.cleanupAfterDurable);
      }
    }
    clientOwnership.currentOwnerId = null;
    this.prune(sessionId, clientId);
    await this.runCleanups(sessionId, clientId, cleanups);
  }

  /**
   * Mark one accepted materialization as crash-recoverable/durable and release
   * only its ephemeral remote source. The local materialization remains owned
   * until the durable messages row exists or the item is explicitly discarded.
   */
  async markDurable(sessionId: string, clientId: string, ownerId?: string): Promise<void> {
    const clientOwnership = this.ownership.get(sessionId)?.get(clientId);
    if (!clientOwnership) return;
    const cleanups: QueuedAttachmentCleanup[] = [];
    for (const [candidateId, owner] of clientOwnership.owners) {
      if (ownerId !== undefined && candidateId !== ownerId) continue;
      if (owner.durableBoundaryReached) continue;
      owner.durableBoundaryReached = true;
      if (owner.cleanupAfterDurable) {
        cleanups.push(owner.cleanupAfterDurable);
        owner.cleanupAfterDurable = undefined;
      }
    }
    await this.runCleanups(sessionId, clientId, cleanups);
  }

  /**
   * Settle the stronger messages-row boundary atomically.  The accepted
   * owner transfers its local materialisation to the transcript row; every
   * superseded owner is fully discarded so replacement edits cannot leak
   * media.  Callers must invoke this only after the row exists.
   */
  async settleDurable(
    sessionId: string,
    clientId: string,
    ownerId?: string,
  ): Promise<void> {
    const clientOwnership = this.ownership.get(sessionId)?.get(clientId);
    if (!clientOwnership) return;
    const persistedOwnerId = ownerId ?? clientOwnership.currentOwnerId;
    if (persistedOwnerId && !clientOwnership.owners.has(persistedOwnerId)) {
      // Never clean local materialisation when the caller names an owner that
      // is no longer registered; the row may still reference another owner.
      return;
    }
    const cleanups: QueuedAttachmentCleanup[] = [];
    if (!persistedOwnerId) {
      // Fail-safe for a legacy caller that did not activate an owner: transfer
      // every local copy to the durable row and release only remote sources.
      // This can leak a superseded local copy, but cannot delete the copy the
      // transcript may reference.  New call sites always stamp an owner.
      for (const owner of clientOwnership.owners.values()) {
        owner.durableBoundaryReached = true;
        if (owner.cleanupAfterDurable) cleanups.push(owner.cleanupAfterDurable);
      }
      clientOwnership.owners.clear();
      clientOwnership.currentOwnerId = null;
      this.prune(sessionId, clientId);
      await this.runCleanups(sessionId, clientId, cleanups);
      return;
    }
    for (const [candidateId, owner] of clientOwnership.owners) {
      const persistedOwner = candidateId === persistedOwnerId;
      if (persistedOwner) {
        if (owner.cleanupAfterDurable && !owner.durableBoundaryReached) {
          cleanups.push(owner.cleanupAfterDurable);
        }
      } else {
        cleanups.push(...localCleanups(owner));
        if (owner.cleanupAfterDurable && !owner.durableBoundaryReached) {
          cleanups.push(owner.cleanupAfterDurable);
        }
      }
      clientOwnership.owners.delete(candidateId);
    }
    clientOwnership.currentOwnerId = null;
    this.prune(sessionId, clientId);
    await this.runCleanups(sessionId, clientId, cleanups);
  }

  discardClient(sessionId: string, clientId: string, keepOwnerId?: string): Promise<void> {
    return this.discardWhere(sessionId, clientId, (ownerId) => ownerId !== keepOwnerId);
  }

  /**
   * Discard every accepted owner except the coordinator's current one,
   * resolved when this runs rather than when the discard was scheduled.
   * Preparations not yet accepted stay with the handler that registered them.
   */
  discardSuperseded(sessionId: string, clientId: string): Promise<void> {
    const clientOwnership = this.ownership.get(sessionId)?.get(clientId);
    const currentOwnerId = clientOwnership?.currentOwnerId ?? null;
    return this.discardWhere(
      sessionId,
      clientId,
      (ownerId) =>
        ownerId !== currentOwnerId && clientOwnership?.owners.get(ownerId)?.accepted === true,
    );
  }

  discardSpecific(sessionId: string, clientId: string, ownerId: string): Promise<void> {
    return this.discardWhere(sessionId, clientId, (candidate) => candidate === ownerId);
  }

  releaseClient(sessionId: string, clientId: string): void {
    const clientOwnership = this.ownership.get(sessionId)?.get(clientId);
    if (!clientOwnership) return;
    // This legacy escape hatch is intentionally limited to owners that have
    // crossed a durable boundary.  Dropping a pending/discard-requested owner
    // here would silently lose the only cleanup callback and reintroduce the
    // session-close data-loss race.
    if ([...clientOwnership.owners.values()].some((owner) => !owner.durableBoundaryReached)) {
      return;
    }
    this.ownership.get(sessionId)?.delete(clientId);
    this.prune(sessionId, clientId);
  }

  releaseSpecific(sessionId: string, clientId: string, ownerId: string): void {
    const clientOwnership = this.ownership.get(sessionId)?.get(clientId);
    if (!clientOwnership) return;
    const owner = clientOwnership.owners.get(ownerId);
    if (!owner || !owner.durableBoundaryReached) return;
    clientOwnership.owners.delete(ownerId);
    if (clientOwnership.currentOwnerId === ownerId) clientOwnership.currentOwnerId = null;
    this.prune(sessionId, clientId);
  }

  async discardSession(sessionId: string): Promise<void> {
    const clientIds = [...(this.ownership.get(sessionId)?.keys() ?? [])];
    await Promise.all(clientIds.map((clientId) => this.discardClient(sessionId, clientId)));
  }

  private async discardWhere(
    sessionId: string,
    clientId: string,
    predicate: (ownerId: string) => boolean,
  ): Promise<void> {
    const clientOwnership = this.ownership.get(sessionId)?.get(clientId);
    if (!clientOwnership) return;
    const cleanups: QueuedAttachmentCleanup[] = [];
    for (const [ownerId, owner] of clientOwnership.owners) {
      if (!predicate(ownerId)) continue;
      if (owner.persistenceInFlight) {
        owner.discardRequested = true;
        continue;
      }
      clientOwnership.owners.delete(ownerId);
      if (clientOwnership.currentOwnerId === ownerId) clientOwnership.currentOwnerId = null;
      cleanups.push(...localCleanups(owner));
      if (owner.cleanupAfterDurable && !owner.durableBoundaryReached) {
        cleanups.push(owner.cleanupAfterDurable);
      }
    }
    this.prune(sessionId, clientId);
    await this.runCleanups(sessionId, clientId, cleanups);
  }

  private prune(sessionId: string, clientId: string): void {
    const byClient = this.ownership.get(sessionId);
    const clientOwnership = byClient?.get(clientId);
    if (clientOwnership?.owners.size === 0) byClient?.delete(clientId);
    if (byClient?.size === 0) this.ownership.delete(sessionId);
  }

  private async runCleanups(
    sessionId: string,
    clientId: string,
    cleanups: QueuedAttachmentCleanup[],
  ): Promise<void> {
    await Promise.all(
      cleanups.map(async (cleanup) => {
        try {
          await cleanup();
        } catch (error) {
          this.onCleanupError?.({ sessionId, clientId, error });
        }
      }),
    );
  }
}

function localCleanups(owner: QueuedAttachmentOwnership): QueuedAttachmentCleanup[] {
  return owner.parts.map((part) => part.cleanup);
}
