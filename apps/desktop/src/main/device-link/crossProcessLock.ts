/** Shared Node implementation; preserve the existing Desktop import surface. */
import { createLogger } from '../logger';
import { setCrossProcessLockLogger } from '@cindy/remote-agent/crossProcessLock';
setCrossProcessLockLogger(createLogger('device-link:cross-process-lock'));
export { withCrossProcessLock, withSecurityBoundaryLock, __testing } from '@cindy/remote-agent/crossProcessLock';
export type { LockStatus, FileLockOptions } from '@cindy/remote-agent/crossProcessLock';
