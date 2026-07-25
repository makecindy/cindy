import type { ModelAccessStatus } from '../../shared/modelAccess.js';
import type { CredentialsSync } from './credentialsSync.js';

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

/**
 * A model-only refresh must not reacquire credentials when the current credentials
 * are already ready. Reacquisition can transition the shared status to `failed`
 * during a transient endpoint outage, which would invalidate an otherwise usable
 * model snapshot before the `/models` request even starts.
 */
export async function ensureCredentialsReadyForModelsRefresh(
  sync: Pick<CredentialsSync, 'getStatus' | 'retry'>,
): Promise<ModelAccessStatus> {
  const status = sync.getStatus();
  return status.state === 'ok' ? status : sync.retry();
}

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
