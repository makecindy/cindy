import { isSqliteCorruption } from '../client/sqliteCorruption.js';
import type { DataOwnerPushStamp } from '../../../shared/dataOwnerPush.js';

export type OwnerEnsureResult =
  | { ready: true }
  | {
      ready: false;
      error: { code: string; message: string };
    };

interface OwnerEnsureCoordinatorDeps {
  isOwnerCurrent(ownerId: string, recovery?: DataOwnerPushStamp): boolean;
  beforeEnsureReady?(ownerId: string, recovery?: DataOwnerPushStamp): void | Promise<void>;
  ensureReady(ownerId: string): Promise<OwnerEnsureResult>;
  onReady?(ownerId: string): void | Promise<void>;
  onReadyError?(ownerId: string, error: unknown): void;
  getCorruptionError?(ownerId: string): Error | null;
  discardReadyOwner(ownerId: string): void | Promise<void>;
}

const staleResult = (): OwnerEnsureResult => ({
  ready: false,
  error: {
    code: 'DB_INIT_FAILED',
    message: 'local database owner changed while initialization was in progress',
  },
});

const readyHookFailureResult = (error: unknown): OwnerEnsureResult => ({
  ready: false,
  error: {
    code: 'DB_INIT_FAILED',
    message: `local database startup hook failed: ${
      error instanceof Error ? error.message : String(error)
    }`,
  },
});

/**
 * Serialize owner database initialization and reject work superseded by an
 * application-session switch. The queue is essential: it lets a stale task
 * discard only its own committed DB before the next owner starts opening one.
 */
export function createOwnerEnsureCoordinator(deps: OwnerEnsureCoordinatorDeps) {
  let tail: Promise<void> = Promise.resolve();

  return (ownerId: string, recovery?: DataOwnerPushStamp): Promise<OwnerEnsureResult> => {
    const isCurrent = () => deps.isOwnerCurrent(ownerId, recovery);
    const operation = tail.then(async () => {
      if (!isCurrent()) return staleResult();

      await deps.beforeEnsureReady?.(ownerId, recovery);
      if (!isCurrent()) return staleResult();

      const result = await deps.ensureReady(ownerId);
      if (!isCurrent()) {
        await deps.discardReadyOwner(ownerId);
        return staleResult();
      }

      if (result.ready && deps.onReady) {
        try {
          await deps.onReady(ownerId);
        } catch (error) {
          deps.onReadyError?.(ownerId, error);
          // Preserve a quarantined client until explicit recovery. Discarding
          // it here would let the next window create a fresh error boundary.
          const corruption = deps.getCorruptionError?.(ownerId)
            ?? (isSqliteCorruption(error) ? error : null);
          if (corruption) {
            return { ready: false, error: { code: 'DB_RUNTIME_CORRUPT', message: corruption instanceof Error ? corruption.message : String(corruption) } };
          }
          // ensureReady has already committed this owner's DB. A failed
          // lifecycle hook must roll it back so a renderer retry can perform a
          // complete initialization instead of observing a half-ready owner.
          await deps.discardReadyOwner(ownerId);
          return readyHookFailureResult(error);
        }
      }
      if (!isCurrent()) {
        await deps.discardReadyOwner(ownerId);
        return staleResult();
      }

      return result;
    });
    tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  };
}
