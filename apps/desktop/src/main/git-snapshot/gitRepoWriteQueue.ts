/**
 * Shared per-repository Git write queue.
 *
 * Snapshot creation and Codex file rewind both stage and commit through Git.
 * Keeping them on the same queue prevents one flow from observing another
 * flow's half-applied index state.
 */

import { assertGitDirectoryReady, currentOperationBudget, operationCheckpoint, operationWait } from '../utils/operationBudget';

const repoQueues = new Map<string, Promise<unknown>>();

/** Runs a mutating Git task after earlier writes for the same repo finish. */
export function enqueueGitRepoWrite<T>(repoRoot: string, task: () => Promise<T>): Promise<T> {
  const prev = repoQueues.get(repoRoot) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(async () => {
    operationCheckpoint();
    assertGitDirectoryReady(repoRoot);
    try {
      return await task();
    } finally {
      // Caller timeout may return before a non-cancellable read completes, but
      // the repository slot must still belong to any terminating Git children.
      await currentOperationBudget()?.drain();
    }
  });
  const tail = run.catch(() => undefined);
  repoQueues.set(repoRoot, tail);
  void tail.finally(() => {
    if (repoQueues.get(repoRoot) === tail) repoQueues.delete(repoRoot);
  });
  return operationWait(run);
}
