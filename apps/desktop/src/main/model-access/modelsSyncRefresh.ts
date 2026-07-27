import type { ModelAccessStatus } from '../../shared/modelAccess.js';
import type { CredentialsSync } from './credentialsSync.js';

/** Bound the shared single-flight so a black-hole connection cannot block later refreshes. */
export const XD_MODELS_SYNC_TIMEOUT_MS = 20_000;

export function buildModelsSyncRequest(baseUrl: string): {
  path: '/api/model-access/models';
  options: { baseUrl: string; timeoutMs: number };
} {
  return {
    path: '/api/model-access/models',
    options: {
      baseUrl,
      timeoutMs: XD_MODELS_SYNC_TIMEOUT_MS,
    },
  };
}

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
