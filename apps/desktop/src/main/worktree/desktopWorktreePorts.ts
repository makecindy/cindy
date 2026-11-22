/** Desktop bindings of the Worktree lifecycle ports. Loaded once by the worktree IPC barrel. */

import { recycleManagedWorktree } from './managedRecycle.js';
import {
  assertPrecreatedSessionNotCancelled,
  sealPrecreatedSessionCancellation,
  withPrecreatedSessionOperationLock,
} from './precreatedCancellation.js';
import { configureWorktreeManagerPorts } from './WorktreeManagerPorts.js';

configureWorktreeManagerPorts({
  assertPrecreatedSessionNotCancelled,
  sealPrecreatedSessionCancellation,
  withPrecreatedSessionOperationLock,
  recycleManagedWorktree,
});
