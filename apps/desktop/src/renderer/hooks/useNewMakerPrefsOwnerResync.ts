import { useEffect } from 'react';

import { useAuth } from '@/contexts/AuthContext';

/**
 * Re-push the persisted new-task / Bot default snapshot whenever the owner scope
 * main fences it on changes.
 *
 * Main keeps that mirror keyed by `mode:dataOwnerId:generation` and refuses a
 * push stamped with any other generation. A same-owner repair (Ghost projection
 * recovery) bumps the generation without changing `dataOwnerId` or the recovery
 * epoch, so nothing used to re-push: the mirror stayed fenced on the old scope,
 * Bots that follow the app default read no preferred route, and every send hit
 * "请先选择已开启的伙伴模型" until the user touched the model picker (#4469).
 *
 * `sync` must early-return while the persisted draft / memory snapshot is not
 * loaded, so a re-push never overwrites a configured mirror with an empty one.
 */
export function useNewMakerPrefsOwnerResync(sync: () => void): void {
  const { dataOwnerId, dataOwnerRecoveryEpoch, dataOwnerGeneration } = useAuth();
  useEffect(() => {
    sync();
  }, [sync, dataOwnerId, dataOwnerRecoveryEpoch, dataOwnerGeneration]);
}
