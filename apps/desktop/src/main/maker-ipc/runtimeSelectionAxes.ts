import type { AgentKind, Effort } from '@cindy/maker-core';
import { EFFORT_VALUES } from '@cindy/model-providers';

/** Runtime validation for effort values crossing IPC and Device Link boundaries. */
export function isSupportedRuntimeEffort(value: unknown): value is Effort {
  return typeof value === 'string' && (EFFORT_VALUES as readonly string[]).includes(value);
}

export function resolveRetainedRuntimeEffort(input: {
  targetModelHasFixedEffort: boolean;
  requestedEffort: Effort | null | undefined;
  liveEffort: Effort | null;
  previousEffort: Effort | null | undefined;
}): Effort | null {
  // Catalog capability is the request contract. A close failure leaves the old
  // handle in Session status=error, and the next send rebuilds it instead of
  // reusing its stale mutable effort, so never project that stale value onto a
  // fixed-effort model.
  if (input.targetModelHasFixedEffort || input.requestedEffort === null) return null;
  if (input.liveEffort !== null) return input.liveEffort;
  return input.previousEffort ?? null;
}

interface RuntimeSelectionAxesSession {
  agentKind: AgentKind;
  setEffort: (effort: Effort) => Promise<void>;
  setFastMode: (enabled: boolean) => Promise<void>;
}

export interface ApplyRuntimeSelectionAxesWithRecoveryInput {
  session: RuntimeSelectionAxesSession;
  effort: Effort | null;
  fastMode: boolean;
  applyEffort?: boolean;
  applyFastMode?: boolean;
  assertCanCommit?: () => void;
  commitControlStores: () => void;
  restoreControlStores: () => void;
  terminateSession: () => Promise<void>;
  recoverLiveProfileAfterTerminationFailure?: () => void | Promise<void>;
}

export interface CommitRuntimeAxisAfterPersistenceInput {
  persist: () => Promise<void>;
  commit: () => void;
  assertCanCommit?: () => void;
  recoverAfterPersistenceFailure?: () => Promise<void>;
}

/**
 * A Device Link axis change is not accepted until the controlled Desktop has
 * persisted its baseline. If persistence rejects after the live RPC succeeded,
 * retire or reconcile that Session before reporting the failed invoke.
 */
export async function commitRuntimeAxisAfterPersistence(
  input: CommitRuntimeAxisAfterPersistenceInput,
): Promise<void> {
  try {
    await input.persist();
  } catch (persistenceError) {
    // Owner transitions invalidate both the requested write and any recovery
    // against the old live Session. Fence that path before touching either.
    input.assertCanCommit?.();
    if (input.recoverAfterPersistenceFailure) {
      try {
        await input.recoverAfterPersistenceFailure();
      } catch (recoveryError) {
        throw new AggregateError(
          [persistenceError, recoveryError],
          'runtime axis persistence and session recovery both failed',
        );
      }
    }
    throw persistenceError;
  }
  // Persistence may have yielded across an owner transition. The final store /
  // generation commit must therefore be fenced independently of the DB write.
  input.assertCanCommit?.();
  input.commit();
}

/**
 * Finishes the effort/Fast half of an already-applied model switch.
 *
 * Harness control calls are not transactional. If either axis rejects after the
 * model/provider changed, restore the old host-side routing stores and retire the
 * partially-mutated Session. The next send then rebuilds from the still-current
 * runtime-control generation instead of exposing a mixed live profile.
 */
export async function applyRuntimeSelectionAxesWithRecovery(
  input: ApplyRuntimeSelectionAxesWithRecoveryInput,
): Promise<void> {
  const applyEffort = input.applyEffort !== false;
  const applyFastMode = input.applyFastMode !== false;
  // A fixed-effort model has no representable live setEffort value. Keeping the
  // current Session would leave each harness's mutable effort on the previous
  // model, so retire the idle Session and let the next send rebuild from the
  // committed null-effort runtime profile.
  if (applyEffort && input.effort === null) {
    try {
      await input.terminateSession();
    } catch (terminationError) {
      input.assertCanCommit?.();
      input.restoreControlStores();
      await input.recoverLiveProfileAfterTerminationFailure?.();
      throw terminationError;
    }
    input.assertCanCommit?.();
    input.commitControlStores();
    return;
  }
  try {
    if (applyEffort) {
      // The null case returns through the fixed-effort rebuild branch above.
      await input.session.setEffort(input.effort as Effort);
      input.assertCanCommit?.();
    }
    if (applyFastMode && input.session.agentKind === 'codex') {
      await input.session.setFastMode(input.fastMode);
      input.assertCanCommit?.();
    }
  } catch (axisError) {
    input.assertCanCommit?.();
    input.restoreControlStores();
    try {
      await input.terminateSession();
    } catch (terminationError) {
      input.assertCanCommit?.();
      await input.recoverLiveProfileAfterTerminationFailure?.();
      throw new AggregateError(
        [axisError, terminationError],
        'runtime selection axis update and session recovery both failed',
      );
    }
    throw axisError;
  }
  input.assertCanCommit?.();
  input.commitControlStores();
}
