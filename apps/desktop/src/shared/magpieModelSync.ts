/**
 * Magpie model-list synchronization protocol shared by Main and Renderer.
 *
 * Magpie is a local gateway whose catalog can change without a Cindy restart.
 * The custom-provider form already performs an initial discovery; Main keeps
 * the list fresh afterwards with the same additions-only merge, so models the
 * gateway no longer returns stay available to existing tasks.
 */

export const MAGPIE_MODEL_SYNC_COOLDOWN_MS = 30 * 60_000;
export const MAGPIE_MODEL_SYNC_FAILURE_COOLDOWN_MS = 5 * 60_000;
export const MAGPIE_MODEL_SYNC_STALE_AFTER_MS = 24 * 60 * 60_000;

export interface ProviderModelSyncFailure {
  /** Provider error code or a Main-local code; never a raw upstream message. */
  code: string;
  /** HTTP status when the gateway answered. */
  status?: number;
  at: number;
}

export interface ProviderModelSyncStatus {
  providerId: string;
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  failure: ProviderModelSyncFailure | null;
  /** True when the current list is absent, older than the stale window, or a later sync failed. */
  stale: boolean;
}

export type ProviderModelSyncErrorCode =
  | 'NOT_SUPPORTED'
  | 'NOT_CONFIGURED'
  | 'DISCOVERY_FAILED'
  | 'CONFIG_CHANGED'
  | 'UNKNOWN';

export interface ProviderModelSyncResult {
  ok: boolean;
  status: ProviderModelSyncStatus;
  /** Unique model ids added across all configured runtimes. */
  added: number;
  /** Present when ok=false. */
  code?: ProviderModelSyncErrorCode;
}

export function isProviderModelSyncStale(
  status: Pick<ProviderModelSyncStatus, 'lastSuccessAt' | 'failure'>,
  now: number,
): boolean {
  if (status.lastSuccessAt === null) return true;
  if (status.failure && status.failure.at > status.lastSuccessAt) return true;
  return now - status.lastSuccessAt > MAGPIE_MODEL_SYNC_STALE_AFTER_MS;
}
