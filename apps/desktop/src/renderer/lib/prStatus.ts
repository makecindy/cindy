/** Shared limits and keys used by the session header, sidebar and companion cards. */
export {
  MAX_STATUS_QUERIES,
  PR_STATUS_REFRESH_INTERVAL_MS,
  prStatusKey,
} from '@cindy/maker-shared';

import { prStatusKey } from '@cindy/maker-shared';
import type { PrStatusResult, SessionPrRef } from './gitContext.types';

/** Display surfaces show MAX_STATUS_QUERIES chips, but archive eligibility must know every
 * associated PR. Statuses are fetched in batches of MAX_STATUS_BATCH (the main-process batch
 * limit) and capped at MAX_TASK_STATUS_QUERIES; a task above the cap stays non-archivable. */
export const MAX_STATUS_BATCH = 10;
export const MAX_TASK_STATUS_QUERIES = 30;

/** Task completion needs every associated PR, including cards outside the viewport. */
export function areAllTaskPrsMerged(
  refs: readonly SessionPrRef[],
  statuses: ReadonlyMap<string, PrStatusResult>,
  refreshError: boolean,
): boolean {
  return !refreshError && refs.length > 0 && refs.every((ref) => {
    const status = statuses.get(prStatusKey(ref));
    return status?.ok === true && status.status === 'merged';
  });
}
