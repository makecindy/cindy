import {
  MODEL_ACCESS_CATALOG_SCHEMA_VERSION,
  parseListModelsResponse,
} from '@cindy/model-providers';
import type {
  ModelAccessGatewayModel,
  ModelAccessModelsResponse,
  ModelAccessStatus,
} from '../../shared/modelAccess.js';
import type { CredentialsSync } from './credentialsSync.js';

/** Bound the shared single-flight so a black-hole connection cannot block later refreshes. */
export const XD_MODELS_SYNC_TIMEOUT_MS = 20_000;
export const XD_MODELS_SYNC_PATH = '/api/model-access/models?schemaVersion=3' as const;

export type ModelsSyncPayloadParseResult =
  { ok: true; models: ModelAccessGatewayModel[] } | { ok: false; error: string };

/**
 * Validate the actual `/models` wire envelope before it can replace the last-known-good snapshot.
 * The client-owned parser is the version boundary: it accepts the frozen v1 and current v2
 * contracts, and rejects unknown versions or fields instead of partially interpreting them.
 */
export function parseModelsSyncPayload(value: unknown): ModelsSyncPayloadParseResult {
  const parsed = parseListModelsResponse(value);
  if (!parsed.ok) return parsed;
  if (parsed.value.schemaVersion !== MODEL_ACCESS_CATALOG_SCHEMA_VERSION) {
    return {
      ok: false,
      error: `response.schemaVersion must be ${MODEL_ACCESS_CATALOG_SCHEMA_VERSION} for Desktop model sync`,
    };
  }
  const response: ModelAccessModelsResponse = parsed.value;
  return { ok: true, models: response.models };
}

/**
 * Bound the whole serverApiFetch lifecycle, including its non-abortable token-rotation refresh.
 * The input promise is intentionally not cancelled: aborting `/api/auth/refresh` after the server
 * rotates a token can invalidate the session. Promise.race still observes its eventual settlement,
 * while the model single-flight is released at the advertised deadline.
 */
export function withModelsSyncOverallDeadline<T>(
  operation: Promise<T>,
  timeoutMs = XD_MODELS_SYNC_TIMEOUT_MS,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(
      () => reject(new Error(`Cindy AI model list refresh timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    timeout.unref?.();
  });
  return Promise.race([operation, deadline]).finally(() => {
    if (timeout !== null) clearTimeout(timeout);
  });
}

export function buildModelsSyncRequest(baseUrl: string | (() => string)): {
  path: typeof XD_MODELS_SYNC_PATH;
  options: { baseUrl: string | (() => string); timeoutMs: number };
} {
  return {
    path: XD_MODELS_SYNC_PATH,
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

export type ModelsSyncRefreshOutcome = 'succeeded' | 'failed' | 'not-started' | 'account-changed';

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
