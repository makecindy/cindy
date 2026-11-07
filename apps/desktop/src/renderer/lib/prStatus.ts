/** Shared limits and keys used by the session header, sidebar and companion cards. */
export {
  MAX_STATUS_QUERIES,
  PR_STATUS_REFRESH_INTERVAL_MS,
  prStatusKey,
} from '@cindy/maker-shared';

import { prStatusKey } from '@cindy/maker-shared';
import type { PrStatusResult, SessionPrRef } from './gitContext.types';

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
