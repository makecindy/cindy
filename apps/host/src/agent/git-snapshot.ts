import type { Maker } from '@cindy/maker-core';

import {
  createGitSnapshotCoordinatorWithRouteGuard,
  type GitSnapshotCoordinatorHostDeps,
} from '../../../desktop/src/main/maker-host/gitSnapshotHostCore.js';

/** Error a Host label one-shot raises; the labeler then uses its deterministic label. */
export const HOST_SNAPSHOT_LABEL_ONE_SHOT_DISABLED = 'HOST_AUXILIARY_MODEL_CALL_DISABLED';

/**
 * The desktop Git snapshot coordinator (gitSnapshotHostCore.ts) for Host tasks:
 * same savepoint refs (refs/cindy/savepoints/<task id>), attempt journal and
 * settings. Auxiliary model calls stay off on the Host until they share the
 * desktop assembly (release table row 7b), so the label one-shot is reported as
 * unavailable and the labeler falls back to its deterministic label. No paid
 * request is sent.
 */
export function createHostGitSnapshot(maker: Pick<Maker, 'getSessionMeta'>, deps: GitSnapshotCoordinatorHostDeps = {}) {
  return createGitSnapshotCoordinatorWithRouteGuard({
    getSessionMeta: id => maker.getSessionMeta(id),
    oneShot: async () => { throw new Error(HOST_SNAPSHOT_LABEL_ONE_SHOT_DISABLED); },
  }, {
    isAgentOneShotRouteDisabled: async () => true,
  }, deps);
}

export type HostGitSnapshot = ReturnType<typeof createHostGitSnapshot>;
