import { getDbClient } from '../localDb/client/current';
import { physicalWorktreeKey } from './resourceLock';
import { readWorktreeRuntimePaths } from './runtimeLeases';
import { readPiSubagentWorktreeReferences } from './piSubagentReferences';
import * as store from './worktreeStore';
import { createLogger } from '../logger';
import { createLiveWorktreeReferences } from '@cindy/worktree-core/liveSessionRefs';
export { pathKey, hasLiveSessionReference } from '@cindy/worktree-core/liveSessionRefs';
export type {
  LiveSessionPathKeys,
  LoadLiveSessionPathKeysOptions,
} from '@cindy/worktree-core/liveSessionRefs';
export const { loadLiveSessionPathKeys } = createLiveWorktreeReferences({
  readLocalWorktreeReferences: async () => {
    const db = getDbClient();
    return db.readLocalWorktreeReferences ? db.readLocalWorktreeReferences() : null;
  },
  physicalWorktreeKey: (...args) => physicalWorktreeKey(...args),
  readWorktreeRuntimePaths: (...args) => readWorktreeRuntimePaths(...args),
  readPiSubagentWorktreeReferences: (...args) => readPiSubagentWorktreeReferences(...args),
  store,
  log: createLogger('worktreeLiveRefs'),
});
