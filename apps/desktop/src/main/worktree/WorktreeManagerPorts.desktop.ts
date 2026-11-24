/**
 * Desktop binding of the Worktree lifecycle ports (WorktreeManagerPorts.ts); the Node Host binds
 * its own in apps/host/src/agent/worktree-lifecycle.ts. Loaded once by the worktree IPC barrel.
 * Each port forwards at call time (architecture-invariants §5), so a test that mocks one of these
 * modules is seen by the manager as well.
 */

import { recycleManagedWorktree } from './managedRecycle.js';
import {
  assertPrecreatedSessionNotCancelled,
  sealPrecreatedSessionCancellation,
  withPrecreatedSessionOperationLock,
} from './precreatedCancellation.js';
import { configureWorktreeManagerPorts, type WorktreeManagerPorts } from './WorktreeManagerPorts.js';

const ports: WorktreeManagerPorts = {
  assertPrecreatedSessionNotCancelled: (...args) => assertPrecreatedSessionNotCancelled(...args),
  sealPrecreatedSessionCancellation: (...args) => sealPrecreatedSessionCancellation(...args),
  withPrecreatedSessionOperationLock: (...args) => withPrecreatedSessionOperationLock(...args),
  recycleManagedWorktree: (...args) => recycleManagedWorktree(...args),
};

configureWorktreeManagerPorts(ports);
