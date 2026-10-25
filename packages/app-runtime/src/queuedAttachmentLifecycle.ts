import { QueuedAttachmentOwnershipRegistry } from "./queuedAttachmentOwnership.js";
import type { DbLogger } from "@cindy/runtime-db/logging";
export function createQueuedAttachmentLifecycle(
  log: DbLogger,
  awaitAgentInputQueueSnapshotPersistence: (id: string) => Promise<void>,
) {
  const queuedAttachmentOwnership = new QueuedAttachmentOwnershipRegistry(
    (failure) => {
      log.warn("queued attachment cleanup failed", {
        sessionId: failure.sessionId,
        clientId: failure.clientId,
        error:
          failure.error instanceof Error
            ? failure.error.message
            : String(failure.error),
      });
    },
  );
  const registerQueuedAttachmentOwnership =
    queuedAttachmentOwnership.register.bind(queuedAttachmentOwnership);
  const markQueuedAttachmentDurableAfterSnapshot = (
    sessionId: string,
    clientId: string,
    ownerId: string | null,
  ): void => {
    if (!ownerId) return;
    void (async () => {
      try {
        await awaitAgentInputQueueSnapshotPersistence(sessionId);
        await queuedAttachmentOwnership.markDurable(
          sessionId,
          clientId,
          ownerId,
        );
      } catch (error) {
        // Keep the remote source alive when the snapshot did not cross the
        // durable boundary. A later retry, DB persistence callback, or explicit
        // discard will settle the ownership; deleting it here would recreate
        // the crash window this registry is meant to close.
        log.warn("queued attachment durable snapshot not available", {
          sessionId,
          clientId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  };
  const discardQueuedAttachmentOwnership = (
    sessionId: string,
    clientId: string,
    opts?: { keepCurrentOwner?: boolean },
  ): void => {
    // Coordinator discard callbacks can run before the state mutation that
    // removes the item emits its replacement snapshot (remove/stop/clear do
    // exactly that). Defer one microtask so the current synchronous lifecycle
    // transition has queued that snapshot; otherwise a crash between the old
    // snapshot and the pending deletion could resurrect an item whose local
    // materialisation was already deleted.
    queueMicrotask(() => {
      void (async () => {
        try {
          await awaitAgentInputQueueSnapshotPersistence(sessionId);
          // A superseding edit keeps whichever owner is current when the
          // discard finally runs: a later edit accepted while this one waited
          // may have replaced or merged the owner that was current earlier.
          await (opts?.keepCurrentOwner
            ? queuedAttachmentOwnership.discardSuperseded(sessionId, clientId)
            : queuedAttachmentOwnership.discardClient(sessionId, clientId));
        } catch (error) {
          // A failed snapshot must keep the ownership callbacks alive. The
          // recycler/next lifecycle boundary can retry without losing data.
          log.warn(
            "queued attachment discard deferred until snapshot persistence",
            {
              sessionId,
              clientId,
              error: error instanceof Error ? error.message : String(error),
            },
          );
        }
      })();
    });
  };
  const discardSpecificQueuedAttachmentOwnership = (
    sessionId: string,
    clientId: string,
    ownerId: string,
  ): Promise<void> => {
    return queuedAttachmentOwnership.discardSpecific(
      sessionId,
      clientId,
      ownerId,
    );
  };
  const markQueuedAttachmentPersistenceStarted = (
    sessionId: string,
    clientId: string,
  ): void => {
    queuedAttachmentOwnership.markPersistenceStarted(sessionId, clientId);
  };
  const settleQueuedAttachmentPersistenceFailure = (
    sessionId: string,
    clientId: string,
    retainForRetry: boolean,
  ): void => {
    // The coordinator invokes this callback before its failure projection emits
    // the replacement queue snapshot.  Wait one microtask so cleanup cannot
    // race the stale crash snapshot and delete media that recovery still needs.
    queueMicrotask(() => {
      void (async () => {
        try {
          await awaitAgentInputQueueSnapshotPersistence(sessionId);
          await queuedAttachmentOwnership.markPersistenceFailed(
            sessionId,
            clientId,
            {
              retainForRetry,
            },
          );
        } catch (error) {
          log.warn(
            "queued attachment persistence failure settlement deferred",
            {
              sessionId,
              clientId,
              error: error instanceof Error ? error.message : String(error),
            },
          );
        }
      })();
    });
  };

  return {
    queuedAttachmentOwnership,
    registerQueuedAttachmentOwnership,
    markQueuedAttachmentDurableAfterSnapshot,
    discardQueuedAttachmentOwnership,
    discardSpecificQueuedAttachmentOwnership,
    markQueuedAttachmentPersistenceStarted,
    settleQueuedAttachmentPersistenceFailure,
  };
}
