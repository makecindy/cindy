/**
 * Wait for the model-list request that belongs to one Cindy account generation.
 *
 * The credential retry may initially encounter an older account's in-flight request;
 * callers provide the existing scheduler/snapshot so this helper can wait through
 * that boundary without ever following a later account indefinitely.
 */

export interface ModelsSyncFlightSnapshot {
  flight: Promise<void> | null;
  generation: number;
  attempt: number;
}

export type ModelsSyncRefreshOutcome =
  | 'succeeded'
  | 'failed'
  | 'not-started'
  | 'account-changed';

export async function waitForModelsSyncRefresh(input: {
  expectedGeneration: number;
  schedule(): void;
  snapshot(): ModelsSyncFlightSnapshot;
  currentGeneration(): number;
  lastSuccessfulAttempt(): number;
}): Promise<ModelsSyncRefreshOutcome> {
  for (;;) {
    input.schedule();
    const { flight, generation, attempt } = input.snapshot();
    if (!flight) return 'not-started';
    await flight;
    if (input.currentGeneration() !== input.expectedGeneration) return 'account-changed';
    if (generation !== input.expectedGeneration) continue;
    return input.lastSuccessfulAttempt() === attempt ? 'succeeded' : 'failed';
  }
}
