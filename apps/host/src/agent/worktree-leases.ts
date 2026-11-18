import * as hostWorktreeRuntimeLeases from '../../../desktop/src/main/worktree/runtimeLeases.js';
import { createPrecreatedCancellation } from '../../../desktop/src/main/worktree/precreatedCancellationCore.js';
import { getAppDataDir, getUserDataDir } from '../../../desktop/src/main/userDataPath.js';

// Runtime leases now use the shared Node-compatible module directly. Both launchers
// configure its profile and app-data paths once at startup. Cancelled creations
// keep their existing factory port; they do not depend on the lease implementation.
const app = {
  getPath: (name: 'userData' | 'appData') => (name === 'appData' ? getAppDataDir() : getUserDataDir()),
};

export { hostWorktreeRuntimeLeases };
export const hostPrecreatedCancellation = createPrecreatedCancellation({ app });
