import { app } from 'electron';
import { withCrossProcessLock } from '../device-link/crossProcessLock';
import { createPrecreatedWorktreeCancellation } from '@cindy/worktree-core/precreatedCancellation';

export const {
  withPrecreatedSessionOperationLock,
  assertPrecreatedSessionNotCancelled,
  sealPrecreatedSessionCancellation,
} = createPrecreatedWorktreeCancellation({
  userDataRoot: () => app.getPath('userData'),
  withCrossProcessLock,
});
