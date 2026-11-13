import { createWorktreeRuntimeLeases } from '../../../desktop/src/main/worktree/runtimeLeasesCore.js';
import { createPrecreatedCancellation } from '../../../desktop/src/main/worktree/precreatedCancellationCore.js';
import { getAppDataDir, getUserDataDir } from '../../../desktop/src/main/userDataPath.js';

// The desktop's worktree runtime leases and cancelled creations (worktree/runtimeLeases.ts,
// precreatedCancellation.ts), one instance per process as on the desktop. userData is this
// Host's profile directory and appData its app-data root, both resolved when used: the leases
// land where a desktop window sharing the profile reads them before it recycles a worktree.
const app = {
  getPath: (name: 'userData' | 'appData') => (name === 'appData' ? getAppDataDir() : getUserDataDir()),
};

export const hostWorktreeRuntimeLeases = createWorktreeRuntimeLeases({ app });
export const hostPrecreatedCancellation = createPrecreatedCancellation({ app });
