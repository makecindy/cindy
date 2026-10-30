import { ownerScopedUserDataPath } from '../appSessionState.js';
import { CindyMakeHistoryStore } from './historyStore.js';

/** Capture before awaiting; never resolve an old operation against a newly signed-in owner. */
export function captureMakeHistoryStore(): CindyMakeHistoryStore {
  return new CindyMakeHistoryStore(ownerScopedUserDataPath('cindy-make-history'));
}
